from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from app.analytics_v7 import (
    anomaly_indices_v7,
    build_anomaly_detection_v7,
    build_classification_use_cases_v7,
    build_segments_v7,
    cluster_values_v7,
)


def envelope(**kwargs):
    return kwargs


def test_anomaly_detection_uses_stability_not_fixed_confidence() -> None:
    rng = np.random.default_rng(42)
    normal = rng.normal(0, 1, size=(200, 2))
    outliers = np.array([[10, 10], [12, -11], [-9, 13]], dtype=float)
    values = np.vstack([normal, outliers])
    frame = pd.DataFrame(values, columns=["x", "y"])
    result = build_anomaly_detection_v7(frame, ["x", "y"], envelope)
    assert result is not None
    assert result["metrics"]["confidence_is_probability"] is False
    assert 0 <= result["confidence"] <= 0.85
    rows = {item["row"] for item in result["data"]}
    assert any(index in rows for index in (200, 201, 202))
    assert all("top_contributors" in item for item in result["data"])


def test_anomaly_utility_returns_original_indices() -> None:
    values = [1.0] * 30 + [100.0]
    result = anomaly_indices_v7(values)
    assert 30 in result["anomalies"]
    assert result["quality"] <= 0.85


def test_segmentation_scales_features_and_selects_k() -> None:
    rng = np.random.default_rng(7)
    a = pd.DataFrame({
        "revenue": rng.normal(1_000, 30, 80),
        "orders": rng.normal(3, 0.3, 80),
    })
    b = pd.DataFrame({
        "revenue": rng.normal(10_000, 100, 80),
        "orders": rng.normal(30, 1.0, 80),
    })
    frame = pd.concat([a, b], ignore_index=True)
    result = build_segments_v7(frame, ["revenue", "orders"], envelope)
    assert result is not None
    assert result["metrics"]["segments"] == 2
    assert result["metrics"]["silhouette"] > 0.5
    assert result["metrics"]["stability_ari"] > 0.9
    assert result["metrics"]["confidence_is_probability"] is False
    assert sum(item["count"] for item in result["data"]) == len(frame)


def test_segmentation_rejects_structureless_identical_rows() -> None:
    frame = pd.DataFrame({"a": [1.0] * 30, "b": [2.0] * 30})
    assert build_segments_v7(frame, ["a", "b"], envelope) is None


def test_cluster_utility_stabilizes_center_order() -> None:
    result = cluster_values_v7([1, 2, 1.5, 100, 110, 105], 2)
    assert result["centers"][0] < result["centers"][1]
    assert set(result["clusters"][:3]) == {0}
    assert set(result["clusters"][3:]) == {1}


def test_classification_uses_out_of_fold_scores_and_scaled_pipeline() -> None:
    rng = np.random.default_rng(11)
    n = 240
    tenure = rng.normal(24, 8, n)
    complaints = rng.poisson(2, n)
    monthly_spend = rng.normal(800, 250, n)
    logit = -1.5 - 0.05 * tenure + 0.8 * complaints + 0.002 * monthly_spend
    probability = 1 / (1 + np.exp(-logit))
    churn = rng.binomial(1, probability)
    # Force both classes to remain sufficiently represented if RNG changes.
    churn[:20] = 0
    churn[20:40] = 1
    frame = pd.DataFrame({
        "customer_id": [f"C{i:04d}" for i in range(n)],
        "tenure_months": tenure,
        "complaints": complaints,
        "monthly_spend": monthly_spend,
        "channel": rng.choice(["web", "store", "partner"], n),
        "churn": churn,
    })
    results, warnings = build_classification_use_cases_v7(frame, envelope)
    assert len(results) == 1
    result = results[0]
    assert result["metrics"]["validation_method"] == "stratified_k_fold_out_of_fold"
    assert result["metrics"]["risk_score_scope"] == "out_of_fold_predictions_for_uploaded_rows"
    assert result["metrics"]["confidence_is_probability"] is False
    assert "customer_id" in result["metrics"]["dropped_columns"]
    assert all(item["score_scope"] == "out_of_fold" for item in result["data"])
    assert not warnings or all("düşüktür" in warning for warning in warnings)


def test_classification_fails_closed_on_tiny_labels() -> None:
    frame = pd.DataFrame({
        "x": np.arange(20),
        "churn": [0] * 15 + [1] * 5,
    })
    results, warnings = build_classification_use_cases_v7(frame, envelope)
    assert results == []
    assert warnings


def test_near_duplicate_numeric_features_are_pruned() -> None:
    rng = np.random.default_rng(21)
    x = rng.normal(size=120)
    frame = pd.DataFrame({"x": x, "x_copy": x * 2, "y": rng.normal(size=120)})
    result = build_anomaly_detection_v7(frame, ["x", "x_copy", "y"], envelope)
    assert result is not None
    dropped = result["metrics"]["dropped_columns"]
    assert "near_duplicate_correlation" in set(dropped.values())
    assert result["metrics"]["feature_count"] == 2


def test_segment_differentiators_use_robust_effect_not_raw_scale() -> None:
    rng = np.random.default_rng(22)
    frame = pd.DataFrame({
        "large_scale": np.r_[rng.normal(1_000_000, 1_000, 80), rng.normal(1_002_000, 1_000, 80)],
        "strong_signal": np.r_[rng.normal(0, 0.1, 80), rng.normal(5, 0.1, 80)],
    })
    result = build_segments_v7(frame, ["large_scale", "strong_signal"], envelope)
    assert result is not None
    for segment in result["data"]:
        assert "robust_effect" in segment["top_differentiators"][0]
        assert "raw_median_difference" in segment["top_differentiators"][0]


def test_classification_groups_repeated_entities_across_folds() -> None:
    rng = np.random.default_rng(23)
    customers = 80
    repeats = 3
    customer_id = np.repeat([f"C{i:03d}" for i in range(customers)], repeats)
    base = rng.normal(size=customers)
    churn_customer = (base + rng.normal(0, 0.4, customers) > 0).astype(int)
    frame = pd.DataFrame({
        "customer_id": customer_id,
        "usage": np.repeat(base, repeats) + rng.normal(0, 0.1, customers * repeats),
        "channel": rng.choice(["web", "store"], customers * repeats),
        "churn": np.repeat(churn_customer, repeats),
    })
    results, _ = build_classification_use_cases_v7(frame, envelope)
    assert len(results) == 1
    metrics = results[0]["metrics"]
    assert metrics["validation_method"] == "stratified_group_k_fold_out_of_fold"
    assert metrics["group_column"] == "customer_id"
    assert "brier_skill_vs_prevalence" in metrics
    assert all("model_coefficient" in driver for driver in metrics["drivers"])


def test_quality_scores_are_labeled_and_not_probabilities() -> None:
    rng = np.random.default_rng(31)
    frame = pd.DataFrame({
        "x": np.r_[rng.normal(0, 1, 100), [12.0, -13.0]],
        "y": np.r_[rng.normal(0, 1, 100), [11.0, -12.0]],
    })
    anomaly = build_anomaly_detection_v7(frame, ["x", "y"], envelope)
    assert anomaly is not None
    assert anomaly["confidence"] <= 0.85
    assert anomaly["metrics"]["quality_grade"] in {"very_low", "low", "medium", "high"}
    assert anomaly["metrics"]["confidence_is_probability"] is False


def test_classification_reports_temporal_validation_limitation() -> None:
    rng = np.random.default_rng(32)
    n = 180
    signal = rng.normal(size=n)
    churn = (signal + rng.normal(0, 0.8, n) > 0.2).astype(int)
    churn[:15] = 0
    churn[15:30] = 1
    frame = pd.DataFrame({
        "customer_id": [f"C{i:04d}" for i in range(n)],
        "snapshot_date": pd.date_range("2025-01-01", periods=n, freq="D"),
        "usage": signal,
        "plan": rng.choice(["basic", "pro"], n),
        "churn": churn,
    })
    results, _ = build_classification_use_cases_v7(frame, envelope)
    assert len(results) == 1
    metrics = results[0]["metrics"]
    assert metrics["quality_grade"] in {"very_low", "low", "medium", "high"}
    assert metrics["validation_limitations"]
    assert "future-period" in metrics["validation_limitations"][0]


def test_analytics_outputs_state_decision_limits() -> None:
    rng = np.random.default_rng(44)
    frame = pd.DataFrame({
        "x": np.r_[rng.normal(0, 1, 80), rng.normal(8, 1, 80)],
        "y": np.r_[rng.normal(0, 1, 80), rng.normal(8, 1, 80)],
    })
    anomaly = build_anomaly_detection_v7(frame, ["x", "y"], envelope)
    segment = build_segments_v7(frame, ["x", "y"], envelope)
    cluster = cluster_values_v7([1, 2, 1.5, 100, 110, 105], 2)
    assert anomaly is not None and anomaly["metrics"]["decision_support"] == "review_candidates_not_automatic_action"
    assert segment is not None and segment["metrics"]["decision_support"] == "descriptive_exploration_not_ground_truth"
    assert cluster["confidence_is_probability"] is False
    assert cluster["decision_support"] == "descriptive_exploration_not_ground_truth"



def test_classification_chooses_real_binary_target_not_first_keyword_match() -> None:
    rng = np.random.default_rng(51)
    n = 160
    signal = rng.normal(size=n)
    churn = (signal + rng.normal(0, 0.7, n) > 0).astype(int)
    churn[:15] = 0
    churn[15:30] = 1
    frame = pd.DataFrame({
        "iptal_tarihi": [None] * n,
        "usage": signal,
        "churn": churn,
    })
    results, warnings = build_classification_use_cases_v7(frame, envelope)
    assert len(results) == 1
    assert results[0]["metrics"]["target_column"] == "churn"
    assert not any("en az 40" in warning for warning in warnings)


def test_temporal_limitation_caps_classification_quality() -> None:
    rng = np.random.default_rng(52)
    n = 240
    signal = rng.normal(size=n)
    churn = (signal > 0).astype(int)
    frame = pd.DataFrame({
        "snapshot_date": pd.date_range("2025-01-01", periods=n, freq="D"),
        "signal": signal,
        "churn": churn,
    })
    results, _ = build_classification_use_cases_v7(frame, envelope)
    assert len(results) == 1
    metrics = results[0]["metrics"]
    assert results[0]["confidence"] <= 0.65
    assert "temporal_generalisation_not_validated" in metrics["quality_cap_reasons"]


def test_group_validation_fallback_is_explicit_and_quality_capped(monkeypatch: pytest.MonkeyPatch) -> None:
    import app.analytics_v7 as analytics

    rng = np.random.default_rng(53)
    entities = 60
    repeats = 3
    frame = pd.DataFrame({
        "customer_id": np.repeat([f"C{i:03d}" for i in range(entities)], repeats),
        "usage": rng.normal(size=entities * repeats),
        "churn": np.repeat([0, 1] * (entities // 2), repeats),
    })
    original = analytics.cross_val_predict
    calls = {"count": 0}

    def fail_group_once(*args, **kwargs):
        calls["count"] += 1
        if kwargs.get("groups") is not None:
            raise ValueError("forced group split failure")
        return original(*args, **kwargs)

    monkeypatch.setattr(analytics, "cross_val_predict", fail_group_once)
    results, _ = build_classification_use_cases_v7(frame, envelope)
    assert len(results) == 1
    metrics = results[0]["metrics"]
    assert metrics["validation_method"].endswith("group_fallback")
    assert "group_leakage_fallback" in metrics["quality_cap_reasons"]
    assert results[0]["confidence"] <= 0.45


def test_feature_limit_is_not_ranked_by_raw_currency_variance() -> None:
    from app.analytics_v7 import _finite_numeric_frame

    n = 100
    frame = pd.DataFrame({f"small_{i}": np.linspace(0, 1 + i / 100, n) for i in range(20)})
    frame["huge_currency"] = np.linspace(1_000_000, 2_000_000, n)
    _, _, diagnostics = _finite_numeric_frame(frame, list(frame.columns), max_features=20)
    assert "huge_currency" in diagnostics["dropped_columns"]
    assert diagnostics["dropped_columns"]["huge_currency"] == "feature_limit"
