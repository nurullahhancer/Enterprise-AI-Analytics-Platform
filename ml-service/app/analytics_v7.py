from __future__ import annotations

import math
import re
import unicodedata
from itertools import combinations
from typing import Any, Callable

import numpy as np
import pandas as pd
from sklearn.cluster import KMeans
from sklearn.compose import ColumnTransformer
from sklearn.ensemble import IsolationForest
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import (
    accuracy_score,
    adjusted_rand_score,
    average_precision_score,
    balanced_accuracy_score,
    brier_score_loss,
    f1_score,
    precision_score,
    recall_score,
    roc_auc_score,
    silhouette_score,
)
from sklearn.model_selection import StratifiedGroupKFold, StratifiedKFold, cross_val_predict
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder, RobustScaler, StandardScaler

EnvelopeFactory = Callable[..., Any]

CLASSIFICATION_USE_CASES = (
    ("churn_risk", "Müşteri kaybı riski", re.compile(r"churn|kayip|terk|iptal|lost customer")),
    ("fraud_risk", "Dolandırıcılık riski", re.compile(r"fraud|dolandir|sahte|supheli|risk flag")),
    ("employee_turnover", "Personel devir riski", re.compile(r"turnover|attrition|isten ayril|personel kayip")),
)


def _normalize(value: str) -> str:
    normalized = unicodedata.normalize("NFD", str(value).lower().replace("ı", "i"))
    normalized = "".join(char for char in normalized if unicodedata.category(char) != "Mn")
    return re.sub(r"[^a-z0-9]+", " ", normalized).strip()


def _quality_grade(score: float) -> str:
    """Human-readable quality label; never represents a success probability."""
    if score >= 0.80:
        return "high"
    if score >= 0.60:
        return "medium"
    if score >= 0.40:
        return "low"
    return "very_low"


def _is_identifier_name(value: str) -> bool:
    name = _normalize(value)
    return bool(
        re.search(r"(^| )(id|uuid|guid|key|sku|ean|iban)( |$)", name)
        or re.search(r"(^| )(kod|kodu|code|ref|referans|barkod|barcode|email|mail|telefon|phone|gsm)( |$)", name)
        or re.search(r"posta kodu|postal code|tc kimlik|vergi no|tax number", name)
        or re.search(r"(siparis|order|fatura|invoice|musteri|customer|urun|product|islem|transaction|kayit|record) (no|numara|number)$", name)
    )


def _is_date_like(column: str, series: pd.Series) -> bool:
    name = _normalize(column)
    hinted = bool(re.search(r"\b(date|tarih|zaman|time|gun|ay|month|year|yil)\b", name))
    if pd.api.types.is_numeric_dtype(series) and not hinted:
        return False
    parsed = pd.to_datetime(series, errors="coerce", dayfirst=True, format="mixed")
    return bool(parsed.notna().mean() >= 0.70)


def _finite_numeric_frame(
    frame: pd.DataFrame,
    numeric_columns: list[str],
    *,
    max_features: int = 20,
    max_missing_ratio: float = 0.60,
) -> tuple[pd.DataFrame, np.ndarray, dict[str, Any]]:
    selected: list[str] = []
    dropped: dict[str, str] = {}
    numeric = pd.DataFrame(index=frame.index)
    for column in numeric_columns:
        if column not in frame.columns or _is_identifier_name(column):
            dropped[column] = "identifier_or_missing"
            continue
        values = pd.to_numeric(frame[column], errors="coerce").replace([np.inf, -np.inf], np.nan)
        missing_ratio = float(values.isna().mean())
        if missing_ratio > max_missing_ratio:
            dropped[column] = "too_many_missing_values"
            continue
        finite = values.dropna()
        if len(finite) < 4 or int(finite.nunique()) <= 1:
            dropped[column] = "constant_or_insufficient"
            continue
        numeric[column] = values
        selected.append(column)

    if not selected:
        return pd.DataFrame(index=frame.index), np.empty((len(frame), 0)), {
            "selected_columns": [], "dropped_columns": dropped, "imputed_cells": 0,
        }

    # Keep the most informative columns while preventing very wide uploaded
    # datasets from turning a lightweight analysis request into an expensive job.
    if len(selected) > max_features:
        # Raw variance is scale-dependent and would systematically prefer TL
        # columns over rates or counts. Rank by completeness and information
        # depth instead, which is invariant to measurement units.
        def feature_priority(column: str) -> tuple[float, float, int]:
            finite = numeric[column].dropna()
            completeness = 1.0 - float(numeric[column].isna().mean())
            unique_depth = math.log1p(int(finite.nunique()))
            return (completeness, unique_depth, -selected.index(column))

        ranked = sorted(selected, key=feature_priority, reverse=True)
        kept = ranked[:max_features]
        for column in selected:
            if column not in kept:
                dropped[column] = "feature_limit"
        numeric = numeric[kept]
        selected = kept

    imputed_cells = int(numeric.isna().sum().sum())
    imputed = numeric.fillna(numeric.median(numeric_only=True)).fillna(0.0)

    # Near-duplicate numeric columns can silently give one business signal extra
    # weight in distance-based models. Keep the first and report the duplicate.
    if imputed.shape[1] > 1:
        correlation = imputed.corr(method="spearman").abs().fillna(0.0)
        upper = correlation.where(np.triu(np.ones(correlation.shape), k=1).astype(bool))
        correlated = [column for column in upper.columns if bool((upper[column] >= 0.995).any())]
        if correlated:
            for column in correlated:
                dropped[column] = "near_duplicate_correlation"
            imputed = imputed.drop(columns=correlated)
            selected = [column for column in selected if column not in correlated]

    scaler = RobustScaler(quantile_range=(25.0, 75.0))
    scaled = scaler.fit_transform(imputed)
    scaled = np.nan_to_num(scaled, nan=0.0, posinf=0.0, neginf=0.0)
    return imputed, scaled, {
        "selected_columns": selected,
        "dropped_columns": dropped,
        "imputed_cells": imputed_cells,
        "missing_ratio": round(imputed_cells / max(1, imputed.size), 6),
    }


def _pairwise_jaccard(label_sets: list[set[int]]) -> float:
    values: list[float] = []
    for left, right in combinations(label_sets, 2):
        union = left | right
        values.append(1.0 if not union else len(left & right) / len(union))
    return float(np.mean(values)) if values else 1.0


def build_anomaly_detection_v7(
    frame: pd.DataFrame,
    numeric_columns: list[str],
    envelope_factory: EnvelopeFactory,
) -> Any | None:
    if len(frame) < 20 or not numeric_columns:
        return None
    raw, scaled, diagnostics = _finite_numeric_frame(frame, numeric_columns, max_features=20)
    if scaled.shape[1] == 0:
        return None

    n_rows = len(frame)
    contamination = float(min(0.08, max(0.01, 10.0 / n_rows)))
    seeds = (17, 42, 97)
    score_runs: list[np.ndarray] = []
    flagged_sets: list[set[int]] = []
    max_samples = min(2048, n_rows)
    for seed in seeds:
        model = IsolationForest(
            n_estimators=250,
            contamination=contamination,
            max_samples=max_samples,
            random_state=seed,
            n_jobs=1,
        )
        model.fit(scaled)
        scores = -model.score_samples(scaled)
        threshold = float(np.quantile(scores, 1.0 - contamination, method="higher"))
        score_runs.append(scores)
        flagged_sets.append(set(np.flatnonzero(scores >= threshold).tolist()))

    mean_scores = np.mean(np.vstack(score_runs), axis=0)
    consensus_votes = np.sum(
        np.vstack([[index in flagged for index in range(n_rows)] for flagged in flagged_sets]),
        axis=0,
    )
    flagged = np.flatnonzero(consensus_votes >= 2)
    if len(flagged) == 0:
        flagged = np.argsort(mean_scores)[-max(1, int(math.ceil(n_rows * contamination))):]

    normal_mask = np.ones(n_rows, dtype=bool)
    normal_mask[flagged] = False
    anomaly_median = float(np.median(mean_scores[flagged]))
    normal_median = float(np.median(mean_scores[normal_mask])) if np.any(normal_mask) else anomaly_median
    score_iqr = float(np.subtract(*np.percentile(mean_scores, [75, 25])))
    separation = max(0.0, (anomaly_median - normal_median) / max(score_iqr, 1e-9))
    separation_quality = float(np.tanh(separation / 2.0))
    stability = _pairwise_jaccard(flagged_sets)
    completeness = 1.0 - float(diagnostics.get("missing_ratio", 0.0))
    quality = float(min(0.85, max(0.0, 0.60 * stability + 0.30 * separation_quality + 0.10 * completeness)))

    order = flagged[np.argsort(mean_scores[flagged])[::-1]]
    output = []
    columns = diagnostics["selected_columns"]
    for position in order[:50]:
        contributions = sorted(
            (
                {"feature": column, "robust_deviation": round(float(abs(scaled[position, idx])), 4)}
                for idx, column in enumerate(columns)
            ),
            key=lambda item: item["robust_deviation"],
            reverse=True,
        )[:3]
        output.append({
            "row": int(frame.index[position]) if isinstance(frame.index[position], (int, np.integer)) else int(position),
            "score": round(float(mean_scores[position]), 6),
            "consensus_votes": int(consensus_votes[position]),
            "top_contributors": contributions,
        })

    return envelope_factory(
        type="anomaly",
        confidence=round(quality, 4),
        model="Robust-scaled IsolationForest consensus (3 seeds)",
        metrics={
            "anomaly_count": int(len(flagged)),
            "anomaly_rate": round(float(len(flagged) / n_rows), 6),
            "expected_contamination": round(contamination, 6),
            "stability_jaccard": round(stability, 4),
            "score_separation": round(separation, 4),
            "feature_count": int(scaled.shape[1]),
            "selected_features": columns,
            "imputed_cells": diagnostics["imputed_cells"],
            "dropped_columns": diagnostics["dropped_columns"],
            "quality_score": round(quality, 4),
            "quality_grade": _quality_grade(quality),
            "quality_semantics": "multi_seed_stability_and_score_separation_not_probability",
            "confidence_is_probability": False,
            "anomalies_are_candidates": True,
            "decision_support": "review_candidates_not_automatic_action",
        },
        data=output,
    )


def _cluster_candidate_scores(sample: np.ndarray, max_k: int) -> list[dict[str, Any]]:
    candidates: list[dict[str, Any]] = []
    n = len(sample)
    for k in range(2, max_k + 1):
        model = KMeans(n_clusters=k, random_state=42, n_init=20, max_iter=400)
        labels = model.fit_predict(sample)
        distinct_labels = int(np.unique(labels).size)
        if distinct_labels < 2 or distinct_labels >= n:
            continue
        counts = np.bincount(labels, minlength=k)
        if np.any(counts == 0):
            continue
        minimum_count = int(counts.min())
        minimum_share = float(minimum_count / n)
        if minimum_count < 3 or minimum_share < 0.02:
            continue
        silhouette = float(silhouette_score(sample, labels, metric="euclidean"))
        imbalance = float(np.std(counts / n))
        objective = silhouette - 0.10 * imbalance
        candidates.append({
            "k": k,
            "silhouette": silhouette,
            "minimum_cluster_share": minimum_share,
            "objective": objective,
        })
    return candidates


def build_segments_v7(
    frame: pd.DataFrame,
    numeric_columns: list[str],
    envelope_factory: EnvelopeFactory,
) -> Any | None:
    if len(frame) < 12 or not numeric_columns:
        return None
    raw, scaled, diagnostics = _finite_numeric_frame(frame, numeric_columns, max_features=15)
    if scaled.shape[1] == 0:
        return None
    distinct_rows = int(np.unique(np.round(scaled, 8), axis=0).shape[0])
    if distinct_rows < 2:
        return None

    rng = np.random.default_rng(42)
    sample_size = min(5000, len(scaled))
    sample_indices = np.sort(rng.choice(len(scaled), size=sample_size, replace=False)) if sample_size < len(scaled) else np.arange(len(scaled))
    sample = scaled[sample_indices]
    max_k = min(6, distinct_rows - 1, max(2, int(math.sqrt(len(sample)))))
    candidates = _cluster_candidate_scores(sample, max_k)
    if not candidates:
        return None
    best = max(candidates, key=lambda item: (item["objective"], item["silhouette"], -item["k"]))
    if best["silhouette"] < 0.10:
        return None
    selected_k = int(best["k"])

    seed_labels = []
    for seed in (17, 42, 97):
        seed_model = KMeans(n_clusters=selected_k, random_state=seed, n_init=20, max_iter=400)
        seed_labels.append(seed_model.fit_predict(sample))
    ari_values = [adjusted_rand_score(a, b) for a, b in combinations(seed_labels, 2)]
    stability = float(np.mean(ari_values)) if ari_values else 1.0

    model = KMeans(n_clusters=selected_k, random_state=42, n_init=30, max_iter=500)
    labels = model.fit_predict(scaled)
    # KMeans labels are arbitrary. Lexicographic centroid ordering makes the API
    # deterministic for the same data and avoids segment IDs changing by chance.
    centroid_order = sorted(range(selected_k), key=lambda index: tuple(np.round(model.cluster_centers_[index], 8)))
    remap = {old: new for new, old in enumerate(centroid_order)}
    stable_labels = np.asarray([remap[int(label)] for label in labels], dtype=int)

    counts = np.bincount(stable_labels, minlength=selected_k)
    if int(counts.min()) < 3 or float(counts.min() / len(labels)) < 0.02:
        return None
    balance = float(1.0 - np.std(counts / len(labels)) / max(1e-9, np.mean(counts / len(labels))))
    balance = max(0.0, min(1.0, balance))
    silhouette_quality = max(0.0, min(1.0, best["silhouette"] / 0.50))
    quality = float(min(0.85, 0.60 * silhouette_quality + 0.30 * stability + 0.10 * balance))

    columns = diagnostics["selected_columns"]
    data = []
    overall_medians = raw.median(numeric_only=True)
    scaled_frame = pd.DataFrame(scaled, index=raw.index, columns=columns)
    overall_scaled_medians = scaled_frame.median(numeric_only=True)
    for segment in range(selected_k):
        mask = stable_labels == segment
        segment_frame = raw.loc[mask]
        scaled_segment = scaled_frame.loc[mask]
        averages = {column: round(float(segment_frame[column].mean()), 4) for column in columns[:8]}
        medians = {column: round(float(segment_frame[column].median()), 4) for column in columns[:8]}
        differentiators = sorted(
            (
                {
                    "feature": column,
                    "robust_effect": round(float(scaled_segment[column].median() - overall_scaled_medians[column]), 4),
                    "raw_median_difference": round(float(segment_frame[column].median() - overall_medians[column]), 4),
                }
                for column in columns
            ),
            key=lambda item: abs(item["robust_effect"]),
            reverse=True,
        )[:3]
        data.append({
            "segment": segment,
            "count": int(mask.sum()),
            "share": round(float(mask.mean()), 6),
            "averages": averages,
            "medians": medians,
            "top_differentiators": differentiators,
        })

    return envelope_factory(
        type="segment",
        confidence=round(quality, 4),
        model="RobustScaler + KMeans with silhouette selection and multi-seed stability",
        metrics={
            "segments": selected_k,
            "silhouette": round(float(best["silhouette"]), 4),
            "stability_ari": round(stability, 4),
            "minimum_cluster_share": round(float(counts.min() / len(labels)), 6),
            "feature_count": len(columns),
            "selected_features": columns,
            "candidate_scores": [
                {
                    "k": int(item["k"]),
                    "silhouette": round(float(item["silhouette"]), 4),
                    "minimum_cluster_share": round(float(item["minimum_cluster_share"]), 6),
                }
                for item in candidates
            ],
            "imputed_cells": diagnostics["imputed_cells"],
            "dropped_columns": diagnostics["dropped_columns"],
            "quality_score": round(quality, 4),
            "quality_grade": _quality_grade(quality),
            "quality_semantics": "cluster_separation_and_multi_seed_stability_not_probability",
            "confidence_is_probability": False,
            "decision_support": "descriptive_exploration_not_ground_truth",
        },
        data=data,
    )


def _binary_target(series: pd.Series) -> pd.Series:
    positive = {"1", "true", "yes", "evet", "e", "y", "churn", "lost", "fraud", "ayrildi", "terk"}
    negative = {"0", "false", "no", "hayir", "h", "n", "active", "retained", "normal", "devam"}

    def convert(value: Any) -> float:
        if pd.isna(value):
            return np.nan
        if isinstance(value, (int, float, np.integer, np.floating)) and float(value) in (0.0, 1.0):
            return float(value)
        normalized = _normalize(str(value))
        if normalized in positive:
            return 1.0
        if normalized in negative:
            return 0.0
        return np.nan

    return series.map(convert).astype(float)


def _classification_features(
    frame: pd.DataFrame,
    valid: pd.Series,
    excluded_columns: set[str],
) -> tuple[pd.DataFrame, list[str], list[str], dict[str, str]]:
    feature_data: dict[str, pd.Series] = {}
    numeric_columns: list[str] = []
    categorical_columns: list[str] = []
    dropped: dict[str, str] = {}
    leakage_pattern = re.compile(
        r"outcome|sonuc|result|final status|nihai durum|termination date|ayrilma tarihi|iptal nedeni|cancel reason|closed date|kapanis tarihi"
    )
    for column in frame.columns:
        if column in excluded_columns:
            dropped[column] = "target_or_related_target"
            continue
        source_all = frame[column]
        if _is_identifier_name(column):
            dropped[column] = "identifier"
            continue
        if _is_date_like(column, source_all):
            dropped[column] = "date"
            continue
        if leakage_pattern.search(_normalize(column)):
            dropped[column] = "potential_post_outcome_leakage"
            continue
        source = source_all.loc[valid]
        missing_ratio = float(source.isna().mean())
        if missing_ratio > 0.50:
            dropped[column] = "too_many_missing_values"
            continue
        numeric = pd.to_numeric(source, errors="coerce").replace([np.inf, -np.inf], np.nan)
        if numeric.notna().mean() >= 0.80 and int(numeric.nunique(dropna=True)) > 1:
            feature_data[column] = numeric
            numeric_columns.append(column)
        else:
            unique_count = int(source.dropna().astype(str).nunique())
            if 1 < unique_count <= 30:
                feature_data[column] = source.astype("object")
                categorical_columns.append(column)
            else:
                dropped[column] = "unsupported_cardinality_or_constant"
        if len(feature_data) >= 20:
            break
    return pd.DataFrame(feature_data, index=frame.index[valid]), numeric_columns, categorical_columns, dropped


def _classification_group_column(frame: pd.DataFrame, valid: pd.Series) -> str | None:
    """Find a repeated entity identifier to prevent entity leakage across folds."""
    candidates: list[tuple[float, str]] = []
    n = int(valid.sum())
    for column in frame.columns:
        if not _is_identifier_name(column):
            continue
        values = frame.loc[valid, column]
        non_missing = values.dropna().astype(str)
        unique = int(non_missing.nunique())
        if unique < 3 or unique >= max(3, int(n * 0.95)):
            continue
        repeated_share = 1.0 - unique / max(len(non_missing), 1)
        candidates.append((repeated_share, column))
    return max(candidates)[1] if candidates else None


def _group_values(frame: pd.DataFrame, index: pd.Index, column: str) -> pd.Series:
    values = frame.loc[index, column].astype("object").copy()
    missing = values.isna()
    if missing.any():
        values.loc[missing] = [f"__missing_group_{item}" for item in values.index[missing]]
    return values.astype(str)


def _select_binary_target(frame: pd.DataFrame, pattern: re.Pattern[str]) -> tuple[str | None, pd.Series | None]:
    """Choose the strongest genuinely binary target among matching columns.

    Column order must not decide the target. A date/reason field such as
    ``iptal_tarihi`` may match the same keyword as the actual ``churn`` label.
    """
    candidates: list[tuple[int, int, str, pd.Series]] = []
    for column in frame.columns:
        if not pattern.search(_normalize(column)):
            continue
        converted = _binary_target(frame[column])
        valid = converted.notna()
        counts = converted.loc[valid].value_counts()
        two_class = int(len(counts) == 2)
        minority = int(counts.min()) if two_class else 0
        candidates.append((two_class, minority, int(valid.sum()), column, converted))
    if not candidates:
        return None, None
    _, _, _, column, converted = max(candidates, key=lambda item: (item[0], item[1], item[2], item[3]))
    return column, converted


def build_classification_use_cases_v7(
    frame: pd.DataFrame,
    envelope_factory: EnvelopeFactory,
) -> tuple[list[Any], list[str]]:
    results: list[Any] = []
    warnings: list[str] = []
    hinted_columns = {
        column
        for column in frame.columns
        if any(pattern.search(_normalize(column)) for _, _, pattern in CLASSIFICATION_USE_CASES)
    }
    for use_case, label, pattern in CLASSIFICATION_USE_CASES:
        target_column, target = _select_binary_target(frame, pattern)
        if target_column is None or target is None:
            continue
        valid = target.notna()
        class_counts = target.loc[valid].value_counts()
        if int(valid.sum()) < 40 or len(class_counts) != 2 or int(class_counts.min()) < 10:
            warnings.append(
                f"{label} modeli için '{target_column}' bulundu ancak en az 40 etiketli satır ve her sınıfta 10 örnek gerekir."
            )
            continue

        features, numeric_columns, categorical_columns, dropped = _classification_features(frame, valid, hinted_columns)
        if features.shape[1] == 0:
            warnings.append(f"{label} modeli için kullanılabilir ve sızıntısız açıklayıcı kolon bulunamadı.")
            continue
        y = target.loc[features.index].astype(int)
        date_columns_present = [
            column for column in frame.columns
            if column != target_column and _is_date_like(column, frame[column])
        ]
        maximum_folds = 3 if len(y) > 10_000 else 5
        folds = min(maximum_folds, int(y.value_counts().min()))
        group_column = _classification_group_column(frame, valid)
        groups = _group_values(frame, features.index, group_column) if group_column else None
        if groups is not None:
            folds = min(folds, int(groups.nunique()))
        if folds < 3:
            warnings.append(f"{label} modeli için güvenilir çapraz doğrulama katmanı oluşturulamadı.")
            continue

        transformers = []
        if numeric_columns:
            numeric_pipeline = Pipeline([
                ("imputer", SimpleImputer(strategy="median")),
                ("scaler", StandardScaler()),
            ])
            transformers.append(("num", numeric_pipeline, numeric_columns))
        if categorical_columns:
            categorical_pipeline = Pipeline([
                ("imputer", SimpleImputer(strategy="most_frequent")),
                ("onehot", OneHotEncoder(handle_unknown="ignore", min_frequency=2)),
            ])
            transformers.append(("cat", categorical_pipeline, categorical_columns))
        preprocessor = ColumnTransformer(transformers=transformers, remainder="drop")
        classifier = LogisticRegression(
            max_iter=2_000,
            class_weight="balanced",
            solver="liblinear",
            random_state=42,
        )
        pipeline = Pipeline([("preprocess", preprocessor), ("classifier", classifier)])
        validation_limitations: list[str] = []
        quality_cap_reasons: list[str] = []
        if date_columns_present:
            validation_limitations.append(
                "Date columns exist, but the uploaded table does not define a reliable prediction timestamp; "
                "cross-validation measures row/entity generalisation, not guaranteed future-period performance."
            )
            quality_cap_reasons.append("temporal_generalisation_not_validated")
        try:
            if groups is not None:
                cv = StratifiedGroupKFold(n_splits=folds, shuffle=True, random_state=42)
                validation_method = "stratified_group_k_fold_out_of_fold"
                try:
                    probabilities = cross_val_predict(
                        pipeline,
                        features,
                        y,
                        groups=groups,
                        cv=cv,
                        method="predict_proba",
                        n_jobs=1,
                    )[:, 1]
                except ValueError as exc:
                    cv = StratifiedKFold(n_splits=folds, shuffle=True, random_state=42)
                    validation_method = "stratified_k_fold_out_of_fold_group_fallback"
                    validation_limitations.append(
                        f"Entity-group validation was infeasible ({type(exc).__name__}); row-stratified folds were used, "
                        "so repeated-entity leakage may remain."
                    )
                    quality_cap_reasons.append("group_leakage_fallback")
                    probabilities = cross_val_predict(
                        pipeline,
                        features,
                        y,
                        cv=cv,
                        method="predict_proba",
                        n_jobs=1,
                    )[:, 1]
            else:
                cv = StratifiedKFold(n_splits=folds, shuffle=True, random_state=42)
                validation_method = "stratified_k_fold_out_of_fold"
                probabilities = cross_val_predict(
                    pipeline,
                    features,
                    y,
                    cv=cv,
                    method="predict_proba",
                    n_jobs=1,
                )[:, 1]
        except ValueError as exc:
            warnings.append(
                f"{label} modeli için çapraz doğrulama kurulamadı ({type(exc).__name__}); model güvenli biçimde atlandı."
            )
            continue
        predicted = (probabilities >= 0.5).astype(int)

        roc_auc = float(roc_auc_score(y, probabilities))
        average_precision = float(average_precision_score(y, probabilities))
        brier = float(brier_score_loss(y, probabilities))
        f1 = float(f1_score(y, predicted, zero_division=0))
        balanced_accuracy = float(balanced_accuracy_score(y, predicted))
        prevalence = float(y.mean())
        baseline_brier = max(prevalence * (1.0 - prevalence), 1e-12)
        brier_skill = float(1.0 - brier / baseline_brier)
        discrimination = max(0.0, min(1.0, (roc_auc - 0.50) / 0.50))
        average_precision_skill = max(0.0, min(1.0, (average_precision - prevalence) / max(1.0 - prevalence, 1e-12)))
        calibration_skill = max(0.0, min(1.0, brier_skill))
        balanced_skill = max(0.0, min(1.0, (balanced_accuracy - 0.50) / 0.50))
        sample_depth = min(1.0, len(y) / 200.0)
        quality = float(min(
            0.85,
            0.40 * discrimination
            + 0.20 * average_precision_skill
            + 0.15 * balanced_skill
            + 0.15 * calibration_skill
            + 0.10 * sample_depth,
        ))
        if roc_auc < 0.55:
            quality = min(quality, 0.30)
            warnings.append(f"{label} modelinin çapraz doğrulama ayırt etme gücü düşüktür; risk sıralaması karar için tek başına kullanılmamalıdır.")
        if "group_leakage_fallback" in quality_cap_reasons:
            quality = min(quality, 0.45)
        if "temporal_generalisation_not_validated" in quality_cap_reasons:
            quality = min(quality, 0.65)

        try:
            pipeline.fit(features, y)
        except ValueError as exc:
            warnings.append(f"{label} modeli son eğitim aşamasında kurulamadı ({type(exc).__name__}); model atlandı.")
            continue
        fitted_preprocessor = pipeline.named_steps["preprocess"]
        fitted_classifier = pipeline.named_steps["classifier"]
        feature_names = fitted_preprocessor.get_feature_names_out()
        coefficients = fitted_classifier.coef_[0]
        drivers = sorted(
            (
                {
                    "feature": str(feature),
                    "model_coefficient": round(float(coefficient), 6),
                    "feature_type": "numeric_standardized" if str(feature).startswith("num__") else "categorical_indicator",
                }
                for feature, coefficient in zip(feature_names, coefficients, strict=True)
            ),
            key=lambda item: abs(item["model_coefficient"]),
            reverse=True,
        )[:10]
        ranked = sorted(
            (
                {
                    "row": int(index) if isinstance(index, (int, np.integer)) else int(position),
                    "risk_score": round(float(score), 6),
                    "score_scope": "out_of_fold",
                }
                for position, (index, score) in enumerate(zip(features.index.tolist(), probabilities, strict=True))
            ),
            key=lambda item: item["risk_score"],
            reverse=True,
        )[:10]

        metrics = {
            "use_case": use_case,
            "label": label,
            "target_column": target_column,
            "rows": int(len(y)),
            "positive_rows": int((y == 1).sum()),
            "negative_rows": int((y == 0).sum()),
            "folds": folds,
            "accuracy": round(float(accuracy_score(y, predicted)), 4),
            "balanced_accuracy": round(balanced_accuracy, 4),
            "precision": round(float(precision_score(y, predicted, zero_division=0)), 4),
            "recall": round(float(recall_score(y, predicted, zero_division=0)), 4),
            "f1": round(f1, 4),
            "roc_auc": round(roc_auc, 4),
            "average_precision": round(average_precision, 4),
            "brier_score": round(brier, 4),
            "brier_skill_vs_prevalence": round(brier_skill, 4),
            "prevalence": round(prevalence, 4),
            "validation_method": validation_method,
            "validation_limitations": validation_limitations,
            "quality_cap_reasons": quality_cap_reasons,
            "group_column": group_column,
            "risk_score_scope": "out_of_fold_predictions_for_uploaded_rows",
            "risk_score_is_calibrated_probability": False,
            "drivers": drivers,
            "numeric_features": numeric_columns,
            "categorical_features": categorical_columns,
            "dropped_columns": dropped,
            "quality_score": round(quality, 4),
            "quality_grade": _quality_grade(quality),
            "quality_semantics": "out_of_fold_discrimination_precision_recall_skill_calibration_and_sample_depth_not_probability",
            "confidence_is_probability": False,
            "decision_support": "ranking_support_not_automated_decision",
        }
        results.append(envelope_factory(
            type="classification",
            confidence=round(quality, 4),
            model="Standardized/one-hot LogisticRegression with leakage-aware out-of-fold validation",
            metrics=metrics,
            data=ranked,
        ))
    return results, warnings


def anomaly_indices_v7(values: list[float]) -> dict[str, Any]:
    array = np.asarray(values, dtype=float)
    if len(array) < 4:
        return {"anomalies": [], "quality": 0.0, "metrics": {"method": "insufficient_data"}}
    if len(array) < 20:
        median = float(np.median(array))
        mad = float(np.median(np.abs(array - median)))
        if mad <= 1e-12:
            deviations = np.abs(array - median)
            positive = deviations[deviations > 1e-12]
            threshold = float(np.min(positive)) if len(positive) == 1 else float("inf")
            indices = np.flatnonzero(deviations >= threshold).tolist() if math.isfinite(threshold) else []
        else:
            robust_z = 0.67448975 * (array - median) / mad
            indices = np.flatnonzero(np.abs(robust_z) >= 3.5).tolist()
        return {
            "anomalies": [int(index) for index in indices],
            "quality": 0.0,
            "metrics": {
                "method": "small_sample_robust_mad_rule",
                "quality_semantics": "unvalidated_small_sample_rule_not_probability",
                "confidence_is_probability": False,
            },
        }
    frame = pd.DataFrame({"value": values})
    result = build_anomaly_detection_v7(frame, ["value"], lambda **kwargs: kwargs)
    if result is None:
        return {"anomalies": [], "quality": 0.0}
    return {
        "anomalies": [int(item["row"]) for item in result["data"]],
        "quality": float(result["confidence"]),
        "metrics": result["metrics"],
    }


def cluster_values_v7(values: list[float], k: int) -> dict[str, Any]:
    array = np.asarray(values, dtype=float).reshape(-1, 1)
    bounded_k = max(1, min(int(k), len(array), len(np.unique(array))))
    if bounded_k == 1:
        return {
            "clusters": [0] * len(values),
            "centers": [round(float(np.mean(array)), 4)],
            "quality": 0.0,
            "quality_grade": "very_low",
            "quality_semantics": "single_cluster_no_separation_not_probability",
            "confidence_is_probability": False,
            "decision_support": "descriptive_exploration_not_ground_truth",
        }
    scaled = RobustScaler().fit_transform(array)
    model = KMeans(n_clusters=bounded_k, random_state=42, n_init=20, max_iter=400)
    labels = model.fit_predict(scaled)
    centers_raw = [float(np.mean(array[labels == label])) for label in range(bounded_k)]
    order = sorted(range(bounded_k), key=lambda label: centers_raw[label])
    remap = {old: new for new, old in enumerate(order)}
    stable_labels = [remap[int(label)] for label in labels]
    stable_centers = [round(centers_raw[old], 4) for old in order]
    silhouette = float(silhouette_score(scaled, labels)) if len(array) > bounded_k else 0.0
    quality = max(0.0, min(0.85, silhouette / 0.50))
    return {
        "clusters": stable_labels,
        "centers": stable_centers,
        "quality": round(quality, 4),
        "quality_grade": _quality_grade(quality),
        "silhouette": round(silhouette, 4),
        "quality_semantics": "silhouette_separation_not_probability",
        "confidence_is_probability": False,
        "decision_support": "descriptive_exploration_not_ground_truth",
    }
