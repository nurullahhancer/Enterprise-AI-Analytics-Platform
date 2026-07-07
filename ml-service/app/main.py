from __future__ import annotations

import hashlib
import logging
import re
import threading
import unicodedata
from typing import Any

import numpy as np
import pandas as pd
from fastapi import FastAPI, Header
from pydantic import BaseModel, Field
from sklearn.cluster import KMeans
from sklearn.ensemble import IsolationForest
from sklearn.linear_model import LinearRegression
from sklearn.compose import ColumnTransformer
from sklearn.impute import SimpleImputer
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder, StandardScaler

try:
    import mlflow
except ImportError:
    mlflow = None

logger = logging.getLogger("ml-service")
logging.basicConfig(level=logging.INFO)

app = FastAPI(title="Enterprise AI ML Service")


# ---------------------------------------------------------------------------
# Tenant-scoped model cache
# ---------------------------------------------------------------------------

class _CacheEntry:
    """Holds a fitted model bundle for a specific (tenant, data_hash) pair."""

    def __init__(self, model: Any, metrics: dict[str, float], extra: dict[str, Any] | None = None) -> None:
        self.model = model
        self.metrics = metrics
        self.extra = extra or {}


class TenantModelCache:
    """Thread-safe, in-memory cache keyed by ``tenant_id:data_hash``.

    Cache is automatically invalidated when the input data changes (hash
    mismatch), so tenants always get a fresh model when their dataset evolves.
    """

    def __init__(self) -> None:
        self._store: dict[str, _CacheEntry] = {}
        self._lock = threading.Lock()

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def get(self, tenant_id: str, data_hash: str, model_type: str) -> _CacheEntry | None:
        key = self._key(tenant_id, data_hash, model_type)
        with self._lock:
            entry = self._store.get(key)
        if entry is not None:
            logger.info(
                "Cache HIT",
                extra={"tenant_id": tenant_id, "model_type": model_type, "key": key},
            )
        return entry

    def put(self, tenant_id: str, data_hash: str, model_type: str, model: Any, metrics: dict[str, float], extra: dict[str, Any] | None = None) -> None:
        key = self._key(tenant_id, data_hash, model_type)
        entry = _CacheEntry(model=model, metrics=metrics, extra=extra or {})
        with self._lock:
            self._store[key] = entry
        logger.info(
            "Cache STORE",
            extra={"tenant_id": tenant_id, "model_type": model_type, "key": key},
        )

    def clear(self, tenant_id: str) -> int:
        prefix = f"{tenant_id}:"
        with self._lock:
            keys_to_delete = [k for k in self._store if k.startswith(prefix)]
            for k in keys_to_delete:
                del self._store[k]
        logger.info("Cache CLEAR", extra={"tenant_id": tenant_id, "cleared": len(keys_to_delete)})
        return len(keys_to_delete)

    def stats(self) -> dict[str, Any]:
        with self._lock:
            entries = list(self._store.keys())
        tenants: dict[str, int] = {}
        for key in entries:
            tid = key.split(":")[0]
            tenants[tid] = tenants.get(tid, 0) + 1
        return {"total_entries": len(entries), "tenants": tenants}

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _key(tenant_id: str, data_hash: str, model_type: str) -> str:
        return f"{tenant_id}:{model_type}:{data_hash}"


# Singleton cache shared across all requests
_cache = TenantModelCache()


def _hash_data(data: Any) -> str:
    """Return a short SHA-256 hex digest of the JSON-serialised data."""
    raw = str(data).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()[:16]


# ---------------------------------------------------------------------------
# Request / Response models
# ---------------------------------------------------------------------------

class SeriesPoint(BaseModel):
    date: str
    value: float


class PredictRequest(BaseModel):
    history: list[SeriesPoint] = Field(min_length=2)
    periods: int = Field(default=3, ge=1, le=24)


class PredictResponse(BaseModel):
    forecast: list[dict[str, Any]]
    mae: float
    rmse: float
    cached: bool = False


class AnalyzeRequest(BaseModel):
    rows: list[dict[str, Any]] = Field(min_length=3)
    target_column: str | None = None
    periods: int = Field(default=3, ge=1, le=12)


class ModelEnvelope(BaseModel):
    type: str
    confidence: float
    model: str
    metrics: dict[str, float] = Field(default_factory=dict)
    data: list[dict[str, Any]]


class AnalyzeResponse(BaseModel):
    dataset_type: str
    feature_columns: list[str]
    target_column: str | None
    forecast: ModelEnvelope | None
    anomalies: ModelEnvelope | None
    segments: ModelEnvelope | None
    cached: bool = False


class CacheStatsResponse(BaseModel):
    total_entries: int
    tenants: dict[str, int]


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "ml-service"}


@app.get("/ml/cache", response_model=CacheStatsResponse)
def cache_stats() -> CacheStatsResponse:
    """Return current model cache statistics."""
    stats = _cache.stats()
    return CacheStatsResponse(**stats)


@app.delete("/ml/cache/{tenant_id}")
def cache_clear(tenant_id: str) -> dict[str, Any]:
    """Clear all cached models for the given tenant."""
    cleared = _cache.clear(tenant_id)
    return {"tenant_id": tenant_id, "cleared_entries": cleared}


@app.post("/predict", response_model=PredictResponse)
def predict(
    request: PredictRequest,
    x_tenant_id: str = Header(default="anonymous"),
) -> PredictResponse:
    tenant_id = x_tenant_id or "anonymous"
    history_hash = _hash_data([p.model_dump() for p in request.history])

    # --- Cache lookup ---
    cached_entry = _cache.get(tenant_id, history_hash, "predict")
    if cached_entry is not None:
        model: LinearRegression = cached_entry.model
        frame: pd.DataFrame = cached_entry.extra["frame"]
        mae: float = cached_entry.metrics["mae"]
        rmse: float = cached_entry.metrics["rmse"]
        cache_hit = True
    else:
        frame = pd.DataFrame([p.model_dump() for p in request.history])
        frame["date"] = pd.to_datetime(frame["date"])
        frame = frame.sort_values("date").reset_index(drop=True)
        frame["t"] = np.arange(len(frame))

        model = LinearRegression()
        x_feat = frame[["t"]]
        y = frame["value"]
        model.fit(x_feat, y)
        fitted = model.predict(x_feat)

        mae = round(float(mean_absolute_error(y, fitted)), 4)
        rmse = round(float(mean_squared_error(y, fitted) ** 0.5), 4)

        _cache.put(
            tenant_id,
            history_hash,
            "predict",
            model=model,
            metrics={"mae": mae, "rmse": rmse},
            extra={"frame": frame},
        )
        cache_hit = False

    future_t = np.arange(len(frame), len(frame) + request.periods).reshape(-1, 1)
    future_values = model.predict(future_t)
    last_date = frame["date"].max()
    forecast = [
        {"date": (last_date + pd.DateOffset(months=i + 1)).date().isoformat(), "value": round(float(value), 2)}
        for i, value in enumerate(future_values)
    ]

    response = PredictResponse(
        forecast=forecast,
        mae=mae,
        rmse=rmse,
        cached=cache_hit,
    )
    log_experiment(
        "sales-forecast-linear-regression",
        {"periods": request.periods, "rows": len(frame), "tenant_id": tenant_id, "cache_hit": cache_hit},
        {"mae": response.mae, "rmse": response.rmse},
        tenant_id=tenant_id,
    )
    return response


@app.post("/anomalies")
def anomalies(
    values: list[float],
    x_tenant_id: str = Header(default="anonymous"),
) -> dict[str, Any]:
    tenant_id = x_tenant_id or "anonymous"
    data_hash = _hash_data(values)

    cached_entry = _cache.get(tenant_id, data_hash, "anomaly")
    if cached_entry is not None:
        return {**cached_entry.extra, "cached": True}

    model = IsolationForest(contamination="auto", random_state=42)
    labels = model.fit_predict(np.array(values).reshape(-1, 1))
    result = {"anomalies": [index for index, label in enumerate(labels) if label == -1]}

    _cache.put(tenant_id, data_hash, "anomaly", model=model, metrics={}, extra=result)
    return {**result, "cached": False}


@app.post("/clusters")
def clusters(
    values: list[float],
    k: int = 2,
    x_tenant_id: str = Header(default="anonymous"),
) -> dict[str, Any]:
    tenant_id = x_tenant_id or "anonymous"
    data_hash = _hash_data((values, k))

    cached_entry = _cache.get(tenant_id, data_hash, "cluster")
    if cached_entry is not None:
        return {**cached_entry.extra, "cached": True}

    bounded_k = max(1, min(k, len(values)))
    model = KMeans(n_clusters=bounded_k, random_state=42, n_init="auto")
    labels = model.fit_predict(np.array(values).reshape(-1, 1))
    result = {
        "clusters": labels.tolist(),
        "centers": [round(float(center[0]), 4) for center in model.cluster_centers_],
    }

    _cache.put(tenant_id, data_hash, "cluster", model=model, metrics={}, extra=result)
    return {**result, "cached": False}


@app.post("/analyze", response_model=AnalyzeResponse)
def analyze(
    request: AnalyzeRequest,
    x_tenant_id: str = Header(default="anonymous"),
) -> AnalyzeResponse:
    tenant_id = x_tenant_id or "anonymous"
    data_hash = _hash_data(request.rows)

    # --- Cache lookup for full analyze bundle ---
    cached_entry = _cache.get(tenant_id, data_hash, "analyze")
    if cached_entry is not None:
        extra = cached_entry.extra
        return AnalyzeResponse(
            dataset_type=extra["dataset_type"],
            feature_columns=extra["feature_columns"],
            target_column=extra["target_column"],
            forecast=ModelEnvelope(**extra["forecast"]) if extra.get("forecast") else None,
            anomalies=ModelEnvelope(**extra["anomalies"]) if extra.get("anomalies") else None,
            segments=ModelEnvelope(**extra["segments"]) if extra.get("segments") else None,
            cached=True,
        )

    frame = pd.DataFrame(request.rows).replace({"": np.nan})
    date_columns = [
        column
        for column in frame.columns
        if is_date_column(column, frame[column]) and not is_identifier_column(column, frame[column])
    ]
    numeric_columns = [
        column
        for column in frame.select_dtypes(include=["number"]).columns.tolist()
        if column not in date_columns and not is_identifier_column(column, frame[column])
    ]
    for column in frame.columns:
        if column not in numeric_columns and column not in date_columns and not is_identifier_column(column, frame[column]):
            converted = pd.to_numeric(frame[column], errors="coerce")
            if converted.notna().mean() >= 0.7:
                frame[column] = converted
                numeric_columns.append(column)

    date_diagnostics = {
        column: {
            "valid": int(pd.to_datetime(frame[column], errors="coerce", dayfirst=True).notna().sum()),
            "invalid": int(frame[column].notna().sum() - pd.to_datetime(frame[column], errors="coerce", dayfirst=True).notna().sum()),
        }
        for column in date_columns
    }
    categorical_columns = [column for column in frame.columns if column not in numeric_columns and column not in date_columns]
    target_column = select_target_column(frame, numeric_columns, request.target_column)
    dataset_type = "time_series" if date_columns and target_column else (
        "crm" if any("customer" in column.lower() or "musteri" in column.lower() for column in frame.columns)
        else "tabular"
    )

    logger.info(
        "ML analyze target selected",
        extra={
            "tenant_id": tenant_id,
            "target_column": target_column,
            "date_columns": date_columns,
            "date_diagnostics": date_diagnostics,
            "numeric_columns": numeric_columns,
            "rows": len(frame),
        },
    )

    forecast_result = build_regression_forecast(frame, target_column, numeric_columns, categorical_columns, request.periods)
    anomaly_result = build_anomaly_detection(frame, numeric_columns)
    segment_result = build_segments(frame, numeric_columns)

    feature_columns = [column for column in frame.columns if column != target_column]

    # Store results in cache
    _cache.put(
        tenant_id,
        data_hash,
        "analyze",
        model=None,
        metrics={},
        extra={
            "dataset_type": dataset_type,
            "feature_columns": feature_columns,
            "target_column": target_column,
            "forecast": forecast_result.model_dump() if forecast_result else None,
            "anomalies": anomaly_result.model_dump() if anomaly_result else None,
            "segments": segment_result.model_dump() if segment_result else None,
        },
    )

    return AnalyzeResponse(
        dataset_type=dataset_type,
        feature_columns=feature_columns,
        target_column=target_column,
        forecast=forecast_result,
        anomalies=anomaly_result,
        segments=segment_result,
        cached=False,
    )


# ---------------------------------------------------------------------------
# Helper functions
# ---------------------------------------------------------------------------

def normalize_column_name(value: str) -> str:
    normalized = unicodedata.normalize("NFD", value.lower().replace("ı", "i"))
    normalized = "".join(char for char in normalized if unicodedata.category(char) != "Mn")
    return re.sub(r"[^a-z0-9]+", " ", normalized).strip()


def is_identifier_column(column: str, series: pd.Series) -> bool:
    name = normalize_column_name(column)
    if not re.search(r"(^id$| id$|^id | uuid| key| kod| code| email| mail|siparis id|order id)", name):
        return False

    non_null = series.dropna()
    if len(non_null) == 0:
        return False
    return non_null.astype(str).nunique() >= max(len(non_null) * 0.8, 1)


def is_date_column(column: str, series: pd.Series) -> bool:
    name = normalize_column_name(column)
    has_date_hint = bool(re.search(r"date|tarih|zaman|time|gun|ay|month", name))
    if pd.api.types.is_numeric_dtype(series) and not has_date_hint:
        return False
    return pd.to_datetime(series, errors="coerce", dayfirst=True).notna().mean() >= 0.7


def select_target_column(frame: pd.DataFrame, numeric_columns: list[str], requested: str | None) -> str | None:
    if requested in numeric_columns:
        return requested
    if not numeric_columns:
        logger.warning("No numeric target candidate found")
        return None

    scored: list[tuple[float, str]] = []
    for column in numeric_columns:
        values = pd.to_numeric(frame[column], errors="coerce")
        non_null = int(values.notna().sum())
        non_zero = int((values.fillna(0) != 0).sum())
        variance = float(values.var(skipna=True) or 0)
        name = normalize_column_name(column)
        total_value_hint = 6 if re.search(r"ciro|gelir|revenue|sales|satis|amount|tutar|toplam|total|net|brut", name) else 0
        unit_price_hint = 2 if re.search(r"fiyat|price", name) else 0
        weak_hint = -2 if re.search(r"birim|unit|adet|quantity|qty|miktar|count|sayi|number", name) else 0
        id_penalty = -5 if re.search(r"(^id$| id$|_id|kod|code|telefon|phone|email|mail)", name) else 0
        date_penalty = -5 if re.search(r"date|tarih|zaman|time", name) else 0
        coverage = non_null / len(frame) if len(frame) else 0
        score = total_value_hint + unit_price_hint + weak_hint + id_penalty + date_penalty + coverage + (1 if non_zero else -3) + (1 if variance > 0 else -2)
        scored.append((score, column))

    scored.sort(reverse=True)
    logger.info("Target candidates scored: %s", scored[:5])
    return scored[0][1]


def build_regression_forecast(
    frame: pd.DataFrame,
    target_column: str | None,
    numeric_columns: list[str],
    categorical_columns: list[str],
    periods: int,
) -> ModelEnvelope | None:
    if target_column is None or len(frame) < 3:
        logger.warning("Forecast skipped: target is missing or row count is below 3")
        return None

    work = frame.copy()
    raw_target_sample = work[target_column].head(10).tolist()
    work[target_column] = pd.to_numeric(work[target_column], errors="coerce")
    target_missing_rows = int(work[target_column].isna().sum())
    work = work.dropna(subset=[target_column])
    if len(work) < 3:
        logger.warning("Forecast skipped after target cleanup: fewer than 3 valid target rows", extra={"target_column": target_column})
        return None

    feature_columns = [column for column in work.columns if column != target_column]
    usable_numeric = [column for column in numeric_columns if column in feature_columns]
    usable_categorical = [column for column in categorical_columns if column in feature_columns]
    if not usable_numeric and not usable_categorical:
        work["_row_index"] = np.arange(len(work))
        usable_numeric = ["_row_index"]
        feature_columns = ["_row_index"]

    preprocessor = ColumnTransformer(
        transformers=[
            ("num", Pipeline([("imputer", SimpleImputer(strategy="median")), ("scale", StandardScaler())]), usable_numeric),
            ("cat", Pipeline([("imputer", SimpleImputer(strategy="most_frequent")), ("encode", OneHotEncoder(handle_unknown="ignore"))]), usable_categorical),
        ],
        remainder="drop",
    )
    model = Pipeline([("features", preprocessor), ("model", LinearRegression())])
    logger.info(
        "Forecast training sample",
        extra={
            "target_column": target_column,
            "feature_columns": feature_columns,
            "numeric_features": usable_numeric,
            "categorical_features": usable_categorical,
            "target_missing_rows": target_missing_rows,
            "imputation": "Target is never filled with 0; rows with empty/non-numeric target are dropped. Feature numeric imputation uses median, categorical uses most_frequent.",
            "first10_raw_target": raw_target_sample,
            "first10_parsed_target": work[target_column].head(10).tolist(),
            "first10_features": work[feature_columns].head(10).to_dict(orient="records"),
        },
    )
    model.fit(work[feature_columns], work[target_column])
    fitted = model.predict(work[feature_columns])
    mae = float(mean_absolute_error(work[target_column], fitted))
    rmse = float(mean_squared_error(work[target_column], fitted) ** 0.5)
    r2 = float(r2_score(work[target_column], fitted)) if len(work[target_column].unique()) > 1 else 0.0

    last_row = work[feature_columns].tail(1)
    forecast_rows = pd.concat([last_row] * periods, ignore_index=True)
    if "_row_index" in forecast_rows:
        forecast_rows["_row_index"] = np.arange(len(work), len(work) + periods)
    predicted = model.predict(forecast_rows)
    rmse_is_suspicious = rmse == 0 and len(work[target_column].unique()) > 1
    if rmse_is_suspicious:
        logger.warning("RMSE is 0 on non-constant target; confidence is forced to 0", extra={"target_column": target_column})
    confidence = 0.0 if rmse_is_suspicious else max(0.35, min(0.95, 0.55 + max(r2, 0) * 0.4))

    return ModelEnvelope(
        type="forecast",
        confidence=round(confidence, 4),
        model="sklearn LinearRegression + preprocessing pipeline",
        metrics={"mae": round(mae, 4), "rmse": round(rmse, 4), "r2": round(r2, 4), "rmse_is_suspicious": float(rmse_is_suspicious)},
        data=[{"row": f"T+{index + 1}", "predicted": round(float(value), 4)} for index, value in enumerate(predicted)],
    )


def build_anomaly_detection(frame: pd.DataFrame, numeric_columns: list[str]) -> ModelEnvelope | None:
    if len(numeric_columns) == 0 or len(frame) < 4:
        return None

    numeric_frame = frame[numeric_columns].apply(pd.to_numeric, errors="coerce")
    all_missing_columns = [column for column in numeric_frame.columns if numeric_frame[column].isna().all()]
    if all_missing_columns:
        logger.warning("Anomaly feature columns are fully missing and will fall back to 0", extra={"columns": all_missing_columns})
    numeric_frame = numeric_frame.fillna(numeric_frame.median(numeric_only=True)).fillna(0)
    model = IsolationForest(contamination="auto", random_state=42)
    labels = model.fit_predict(numeric_frame)
    scores = -model.score_samples(numeric_frame)
    data = [
        {"row": int(index), "score": round(float(scores[index]), 4)}
        for index, label in enumerate(labels)
        if label == -1
    ]
    return ModelEnvelope(
        type="anomaly",
        confidence=0.82 if data else 0.55,
        model="sklearn IsolationForest",
        metrics={"anomaly_count": float(len(data))},
        data=data,
    )


def build_segments(frame: pd.DataFrame, numeric_columns: list[str]) -> ModelEnvelope | None:
    if len(numeric_columns) == 0 or len(frame) < 4:
        return None

    numeric_frame = frame[numeric_columns].apply(pd.to_numeric, errors="coerce")
    all_missing_columns = [column for column in numeric_frame.columns if numeric_frame[column].isna().all()]
    if all_missing_columns:
        logger.warning("Segment feature columns are fully missing and will fall back to 0", extra={"columns": all_missing_columns})
    numeric_frame = numeric_frame.fillna(numeric_frame.median(numeric_only=True)).fillna(0)
    k = max(2, min(4, len(frame) // 2))
    model = KMeans(n_clusters=k, random_state=42, n_init="auto")
    labels = model.fit_predict(numeric_frame)
    data = []
    for segment in sorted(set(labels.tolist())):
        segment_frame = numeric_frame[labels == segment]
        data.append({
            "segment": int(segment),
            "count": int(len(segment_frame)),
            "averages": {column: round(float(segment_frame[column].mean()), 4) for column in numeric_columns[:5]},
        })
    return ModelEnvelope(
        type="segment",
        confidence=0.78 if len(data) >= 2 else 0.0,
        model="sklearn KMeans",
        metrics={"segments": float(len(data))},
        data=data,
    )


def log_experiment(
    name: str,
    params: dict[str, Any],
    metrics: dict[str, float],
    tenant_id: str = "anonymous",
) -> None:
    if mlflow is None:
        return
    try:
        mlflow.set_experiment("enterprise-ai-analytics")
        with mlflow.start_run(run_name=name):
            mlflow.set_tag("tenant_id", tenant_id)
            mlflow.log_params(params)
            mlflow.log_metrics(metrics)
    except Exception:
        logger.exception("MLflow logging failed")
