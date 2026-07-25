from __future__ import annotations

import hmac
import hashlib
import logging
import os
import re
import threading
import unicodedata
from collections import OrderedDict
from typing import Annotated, Any
try:
    from typing import Self
except ImportError:
    try:
        from typing_extensions import Self
    except ImportError:
        Self = Any

import numpy as np
import pandas as pd
from fastapi import Body, FastAPI, Header, HTTPException, Path, Query, Response, status
from pydantic import BaseModel, Field, model_validator

try:
    import mlflow
except ImportError:
    mlflow = None

logger = logging.getLogger("ml-service")
logging.basicConfig(level=logging.INFO)

app = FastAPI(title="Enterprise AI ML Service")

MAX_PREDICT_POINTS = 10_000
MAX_NUMERIC_VALUES = 50_000
# Row count and cell count are bounded independently. This permits moderately
# wide, combined datasets while the cell cap remains the primary memory guard.
MAX_ANALYZE_ROWS = 50_000
MAX_ANALYZE_COLUMNS = 100
MAX_ANALYZE_CELLS = 500_000
MAX_COLUMN_NAME_LENGTH = 128
MAX_CELL_TEXT_LENGTH = 16_384
MAX_TENANT_ID_LENGTH = 128
DEFAULT_CACHE_MAX_ENTRIES = 256
MAX_CONFIGURED_CACHE_ENTRIES = 10_000


def _bounded_env_int(name: str, default: int, minimum: int, maximum: int) -> int:
    raw_value = os.getenv(name)
    if raw_value is None:
        return default
    try:
        return max(minimum, min(int(raw_value), maximum))
    except ValueError:
        logger.warning("Invalid integer configuration; using the default", extra={"setting": name})
        return default


def _tenant_scope(tenant_id: str) -> str:
    """Return a stable opaque tenant scope without retaining the clear identifier."""
    return hashlib.sha256(tenant_id.encode("utf-8")).hexdigest()[:24]


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
    """Thread-safe, bounded LRU cache with opaque tenant-scoped keys.

    Cache is automatically invalidated when the input data changes (hash
    mismatch). Least-recently-used entries are evicted once the configured
    capacity is reached.
    """

    def __init__(self, max_entries: int = DEFAULT_CACHE_MAX_ENTRIES) -> None:
        if max_entries < 1:
            raise ValueError("max_entries must be at least 1")
        self._max_entries = max_entries
        self._store: OrderedDict[str, _CacheEntry] = OrderedDict()
        self._lock = threading.Lock()
        self._evictions = 0

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def get(self, tenant_id: str, data_hash: str, model_type: str) -> _CacheEntry | None:
        key = self._key(tenant_id, data_hash, model_type)
        with self._lock:
            entry = self._store.get(key)
            if entry is not None:
                self._store.move_to_end(key)
        if entry is not None:
            logger.info("Cache HIT", extra={"model_type": model_type})
        return entry

    def put(self, tenant_id: str, data_hash: str, model_type: str, model: Any, metrics: dict[str, float], extra: dict[str, Any] | None = None) -> None:
        key = self._key(tenant_id, data_hash, model_type)
        entry = _CacheEntry(model=model, metrics=metrics, extra=extra or {})
        with self._lock:
            self._store[key] = entry
            self._store.move_to_end(key)
            if len(self._store) > self._max_entries:
                self._store.popitem(last=False)
                self._evictions += 1
            entry_count = len(self._store)
        logger.info("Cache STORE", extra={"model_type": model_type, "entry_count": entry_count})

    def clear(self, tenant_id: str) -> int:
        prefix = f"{_tenant_scope(tenant_id)}:"
        with self._lock:
            keys_to_delete = [k for k in self._store if k.startswith(prefix)]
            for k in keys_to_delete:
                del self._store[k]
        logger.info("Cache CLEAR", extra={"cleared": len(keys_to_delete)})
        return len(keys_to_delete)

    def stats(self) -> dict[str, Any]:
        with self._lock:
            entries = list(self._store.keys())
            evictions = self._evictions
        tenant_count = len({key.split(":", 1)[0] for key in entries})
        return {
            "total_entries": len(entries),
            "tenant_count": tenant_count,
            "max_entries": self._max_entries,
            "evictions": evictions,
        }

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _key(tenant_id: str, data_hash: str, model_type: str) -> str:
        return f"{_tenant_scope(tenant_id)}:{model_type}:{data_hash}"


# Singleton cache shared across all requests
_cache = TenantModelCache(
    max_entries=_bounded_env_int(
        "ML_CACHE_MAX_ENTRIES",
        DEFAULT_CACHE_MAX_ENTRIES,
        1,
        MAX_CONFIGURED_CACHE_ENTRIES,
    )
)


def _hash_data(data: Any) -> str:
    """Return a short SHA-256 hex digest of the JSON-serialised data."""
    raw = str(data).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()[:16]


# ---------------------------------------------------------------------------
# Request / Response models
# ---------------------------------------------------------------------------

class SeriesPoint(BaseModel):
    date: str = Field(min_length=1, max_length=64)
    value: float = Field(allow_inf_nan=False)


class PredictRequest(BaseModel):
    history: list[SeriesPoint] = Field(min_length=2, max_length=MAX_PREDICT_POINTS)
    periods: int = Field(default=3, ge=1, le=24)


class PredictResponse(BaseModel):
    forecast: list[dict[str, Any]]
    mae: float | None = None
    rmse: float | None = None
    cached: bool = False
    model: str | None = None
    smape: float | None = None
    wape: float | None = None
    mase: float | None = None
    mase_scale_lag: int | None = None
    mae_vs_naive_ratio: float | None = None
    r2: float | None = None
    validation_method: str | None = None
    reference_baseline_model: str | None = None
    quality_score: float | None = None
    quality_grade: str | None = None
    decision_support: str | None = None
    interval_test_coverage: float | None = None
    forecast_frequency: str | None = None
    frequency_detection_method: str | None = None
    regime_shift_score: float | None = None
    engine_version: str | None = None
    confidence_semantics: str | None = None
    confidence_is_probability: bool = False
    warnings: list[str] = Field(default_factory=list)


class AnalyzeRequest(BaseModel):
    rows: list[dict[str, Any]] = Field(min_length=3, max_length=MAX_ANALYZE_ROWS)
    target_column: str | None = Field(default=None, max_length=MAX_COLUMN_NAME_LENGTH)
    periods: int = Field(default=3, ge=1, le=12)

    @model_validator(mode="after")
    def validate_shape(self) -> Self:
        columns: set[str] = set()
        cell_count = 0
        for row in self.rows:
            if len(row) > MAX_ANALYZE_COLUMNS:
                raise ValueError(f"Each row may contain at most {MAX_ANALYZE_COLUMNS} columns.")
            columns.update(row)
            if len(columns) > MAX_ANALYZE_COLUMNS:
                raise ValueError(f"The dataset may contain at most {MAX_ANALYZE_COLUMNS} columns.")
            cell_count += len(row)
            if cell_count > MAX_ANALYZE_CELLS:
                raise ValueError(f"The dataset may contain at most {MAX_ANALYZE_CELLS} cells.")
            for column, value in row.items():
                if len(column) > MAX_COLUMN_NAME_LENGTH:
                    raise ValueError(f"Column names may contain at most {MAX_COLUMN_NAME_LENGTH} characters.")
                if isinstance(value, (dict, list, tuple, set)):
                    raise ValueError("Dataset cells must contain scalar values.")
                if isinstance(value, str) and len(value) > MAX_CELL_TEXT_LENGTH:
                    raise ValueError(f"Text cells may contain at most {MAX_CELL_TEXT_LENGTH} characters.")
        return self


class ModelEnvelope(BaseModel):
    type: str
    confidence: float
    model: str
    metrics: dict[str, Any] = Field(default_factory=dict)
    data: list[dict[str, Any]]


class AnalyzeResponse(BaseModel):
    dataset_type: str
    feature_columns: list[str]
    target_column: str | None
    forecast: ModelEnvelope | None
    anomalies: ModelEnvelope | None
    segments: ModelEnvelope | None
    classifications: list[ModelEnvelope] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    cached: bool = False


class CacheStatsResponse(BaseModel):
    total_entries: int
    tenant_count: int
    max_entries: int
    evictions: int


FiniteFloat = Annotated[float, Field(allow_inf_nan=False)]
BoundedNumericValues = Annotated[
    list[FiniteFloat],
    Body(min_length=1, max_length=MAX_NUMERIC_VALUES),
]


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "ml-service"}


@app.get("/metrics", response_class=Response)
def metrics() -> Response:
    stats = _cache.stats()
    body = "\n".join([
        "# HELP reai_ml_cache_entries Current tenant-scoped ML cache entries.",
        "# TYPE reai_ml_cache_entries gauge",
        f"reai_ml_cache_entries {stats['total_entries']}",
        "# HELP reai_ml_cache_tenants Current tenant scopes represented in cache.",
        "# TYPE reai_ml_cache_tenants gauge",
        f"reai_ml_cache_tenants {stats['tenant_count']}",
        "# HELP reai_ml_cache_evictions_total Total LRU cache evictions.",
        "# TYPE reai_ml_cache_evictions_total counter",
        f"reai_ml_cache_evictions_total {stats['evictions']}",
    ]) + "\n"
    return Response(content=body, media_type="text/plain; version=0.0.4")


@app.get("/ml/cache", response_model=CacheStatsResponse)
def cache_stats() -> CacheStatsResponse:
    """Return current model cache statistics."""
    stats = _cache.stats()
    return CacheStatsResponse(**stats)


@app.delete("/ml/cache/{tenant_id}")
def cache_clear(
    tenant_id: Annotated[str, Path(min_length=1, max_length=MAX_TENANT_ID_LENGTH)],
    x_internal_api_key: Annotated[str | None, Header(max_length=512)] = None,
) -> dict[str, Any]:
    """Clear all cached models for the given tenant."""
    expected_key = os.getenv("ML_INTERNAL_API_KEY")
    if expected_key and (
        x_internal_api_key is None
        or not hmac.compare_digest(x_internal_api_key.encode("utf-8"), expected_key.encode("utf-8"))
    ):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid internal API key.")
    cleared = _cache.clear(tenant_id)
    return {"cleared_entries": cleared}


@app.post("/predict", response_model=PredictResponse)
def predict(
    request: PredictRequest,
    x_tenant_id: Annotated[str, Header(max_length=MAX_TENANT_ID_LENGTH)] = "anonymous",
) -> PredictResponse:
    """Forecast with honest validation semantics and period-aware caching."""
    from app.forecasting_v7 import predict_history_v7

    tenant_id = x_tenant_id or "anonymous"
    history_payload = [point.model_dump() for point in request.history]
    history_hash = _hash_data({"history": history_payload, "periods": request.periods, "engine": "v7.1"})
    cached_entry = _cache.get(tenant_id, history_hash, "predict_v7_1")
    if cached_entry is not None:
        cached_result = dict(cached_entry.extra["result"])
        cached_result["cached"] = True
        return PredictResponse(**cached_result)

    try:
        result = predict_history_v7(history_payload, request.periods)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)) from exc

    _cache.put(
        tenant_id,
        history_hash,
        "predict_v7_1",
        model=None,
        metrics={
            key: float(value)
            for key, value in {"mae": result.get("mae"), "rmse": result.get("rmse")}.items()
            if value is not None
        },
        extra={"result": result},
    )
    response = PredictResponse(**result, cached=False)
    experiment_metrics = {
        key: float(value)
        for key, value in {
            "mae": result.get("mae"),
            "rmse": result.get("rmse"),
            "smape": result.get("smape"),
            "r2": result.get("r2"),
        }.items()
        if value is not None
    }
    if experiment_metrics:
        log_experiment(
            "sales-forecast-robust-v7.1",
            {"periods": request.periods, "rows": len(history_payload), "cache_hit": False},
            experiment_metrics,
            tenant_id=tenant_id,
        )
    return response

@app.post("/anomalies")
def anomalies(
    values: BoundedNumericValues,
    x_tenant_id: Annotated[str, Header(max_length=MAX_TENANT_ID_LENGTH)] = "anonymous",
) -> dict[str, Any]:
    from app.analytics_v7 import anomaly_indices_v7

    tenant_id = x_tenant_id or "anonymous"
    data_hash = _hash_data({"values": values, "engine": "v7.1"})
    cached_entry = _cache.get(tenant_id, data_hash, "anomaly_v7_1")
    if cached_entry is not None:
        return {**cached_entry.extra, "cached": True}
    result = anomaly_indices_v7(values)
    _cache.put(tenant_id, data_hash, "anomaly_v7_1", model=None, metrics={}, extra=result)
    return {**result, "cached": False}


@app.post("/clusters")
def clusters(
    values: BoundedNumericValues,
    k: Annotated[int, Query(ge=1, le=100)] = 2,
    x_tenant_id: Annotated[str, Header(max_length=MAX_TENANT_ID_LENGTH)] = "anonymous",
) -> dict[str, Any]:
    from app.analytics_v7 import cluster_values_v7

    tenant_id = x_tenant_id or "anonymous"
    data_hash = _hash_data({"values": values, "k": k, "engine": "v7.1"})
    cached_entry = _cache.get(tenant_id, data_hash, "cluster_v7_1")
    if cached_entry is not None:
        return {**cached_entry.extra, "cached": True}
    result = cluster_values_v7(values, k)
    _cache.put(tenant_id, data_hash, "cluster_v7_1", model=None, metrics={}, extra=result)
    return {**result, "cached": False}


@app.post("/analyze", response_model=AnalyzeResponse)
def analyze(
    request: AnalyzeRequest,
    x_tenant_id: Annotated[str, Header(max_length=MAX_TENANT_ID_LENGTH)] = "anonymous",
) -> AnalyzeResponse:
    tenant_id = x_tenant_id or "anonymous"
    data_hash = _hash_data(
        {
            "rows": request.rows,
            "target_column": request.target_column,
            "periods": request.periods,
        }
    )

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
            classifications=[ModelEnvelope(**item) for item in extra.get("classifications", [])],
            warnings=extra.get("warnings", []),
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
            "valid": int(pd.to_datetime(frame[column], errors="coerce", dayfirst=True, format="mixed").notna().sum()),
            "invalid": int(frame[column].notna().sum() - pd.to_datetime(frame[column], errors="coerce", dayfirst=True, format="mixed").notna().sum()),
        }
        for column in date_columns
    }
    target_column = select_target_column(frame, numeric_columns, request.target_column)
    dataset_type = "time_series" if date_columns and target_column else (
        "crm" if any("customer" in column.lower() or "musteri" in column.lower() for column in frame.columns)
        else "tabular"
    )

    logger.info(
        "ML analyze target selected",
        extra={
            "target_selected": target_column is not None,
            "date_column_count": len(date_columns),
            "invalid_date_count": sum(item["invalid"] for item in date_diagnostics.values()),
            "numeric_column_count": len(numeric_columns),
            "rows": len(frame),
        },
    )

    forecast_result, forecast_warnings = build_regression_forecast(
        frame,
        target_column,
        date_columns,
        request.periods,
    )
    anomaly_result = build_anomaly_detection(frame, numeric_columns)
    segment_result = build_segments(frame, numeric_columns)
    classification_results, classification_warnings = build_classification_use_cases(frame)
    forecast_warnings.extend(classification_warnings)

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
            "classifications": [item.model_dump() for item in classification_results],
            "warnings": forecast_warnings,
        },
    )

    return AnalyzeResponse(
        dataset_type=dataset_type,
        feature_columns=feature_columns,
        target_column=target_column,
        forecast=forecast_result,
        anomalies=anomaly_result,
        segments=segment_result,
        classifications=classification_results,
        warnings=forecast_warnings,
        cached=False,
    )


# ---------------------------------------------------------------------------
# Helper functions
# ---------------------------------------------------------------------------

def normalize_column_name(value: str) -> str:
    normalized = unicodedata.normalize("NFD", value.lower().replace("ı", "i"))
    normalized = "".join(char for char in normalized if unicodedata.category(char) != "Mn")
    return re.sub(r"[^a-z0-9]+", " ", normalized).strip()


def is_identifier_name(value: str) -> bool:
    name = normalize_column_name(value)
    return bool(
        re.search(r"(^| )(id|uuid|guid|key|sku|ean|iban)( |$)", name)
        or re.search(
            r"(^| )(kod|kodu|code|ref|referans|barkod|barcode|email|mail|telefon|phone|gsm|zip)( |$)",
            name,
        )
        or re.search(
            r"posta kodu|postal code|tc kimlik|vergi no|vergi numarasi|tax no|tax number",
            name,
        )
        or re.search(
            r"(siparis|order|fatura|invoice|musteri|customer|urun|product|stok|stock|islem|transaction|kayit|record|personel|employee|calisan) (no|numara|numarasi|number)$",
            name,
        )
    )


def is_identifier_column(column: str, series: pd.Series) -> bool:
    # Identifiers can legitimately repeat, such as an order number repeated for
    # every line item. Repetition must not turn a key into a measurable value.
    return is_identifier_name(column) and bool(series.notna().any())


def is_date_column(column: str, series: pd.Series) -> bool:
    name = normalize_column_name(column)
    has_date_hint = bool(re.search(r"\b(date|tarih|zaman|time|gun|ay|month)\b", name))
    if pd.api.types.is_numeric_dtype(series) and not has_date_hint:
        return False
    return pd.to_datetime(series, errors="coerce", dayfirst=True, format="mixed").notna().mean() >= 0.7


def select_target_column(
    frame: pd.DataFrame,
    numeric_columns: list[str],
    requested: str | None,
) -> str | None:
    from app.forecasting_v7 import select_target_column_v7

    return select_target_column_v7(frame, numeric_columns, requested)


def _target_aggregation(target_column: str) -> tuple[str, str | None]:
    """Choose a defensible daily aggregation from the target's business meaning."""
    name = normalize_column_name(target_column)
    average_hint = re.search(
        r"fiyat|price|oran|rate|ratio|percent|yuzde|score|skor|average|ortalama|temperature|sicaklik",
        name,
    )
    additive_hint = re.search(
        r"ciro|gelir|revenue|sales|satis|amount|tutar|toplam|total|cost|maliyet|expense|gider|adet|quantity|qty|miktar|count|volume",
        name,
    )
    if average_hint:
        return "mean", None
    if additive_hint:
        return "sum", None
    return "mean", "Target semantics were unclear; duplicate dates were aggregated with the mean."



def build_regression_forecast(
    frame: pd.DataFrame,
    target_column: str | None,
    date_columns: list[str],
    periods: int,
) -> tuple[ModelEnvelope | None, list[str]]:
    from app.forecasting_v7 import build_regression_forecast_v7

    return build_regression_forecast_v7(
        frame=frame,
        target_column=target_column,
        date_columns=date_columns,
        periods=periods,
        envelope_factory=ModelEnvelope,
        target_aggregation=_target_aggregation,
    )


def build_anomaly_detection(frame: pd.DataFrame, numeric_columns: list[str]) -> ModelEnvelope | None:
    from app.analytics_v7 import build_anomaly_detection_v7

    return build_anomaly_detection_v7(frame, numeric_columns, ModelEnvelope)


def build_classification_use_cases(frame: pd.DataFrame) -> tuple[list[ModelEnvelope], list[str]]:
    from app.analytics_v7 import build_classification_use_cases_v7

    return build_classification_use_cases_v7(frame, ModelEnvelope)


def build_segments(frame: pd.DataFrame, numeric_columns: list[str]) -> ModelEnvelope | None:
    from app.analytics_v7 import build_segments_v7

    return build_segments_v7(frame, numeric_columns, ModelEnvelope)


def log_experiment(
    name: str,
    params: dict[str, Any],
    metrics: dict[str, float],
    tenant_id: str = "anonymous",
) -> None:
    tracking_uri = os.getenv("MLFLOW_TRACKING_URI")
    if mlflow is None or not tracking_uri:
        return
    try:
        mlflow.set_tracking_uri(tracking_uri)
        mlflow.set_experiment("enterprise-ai-analytics")
        with mlflow.start_run(run_name=name):
            mlflow.set_tag("tenant_scope", _tenant_scope(tenant_id))
            mlflow.log_params(params)
            mlflow.log_metrics(metrics)
    except Exception as exc:
        logger.warning("MLflow logging failed", extra={"error_type": type(exc).__name__})
