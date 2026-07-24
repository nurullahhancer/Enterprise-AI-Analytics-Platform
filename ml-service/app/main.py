from __future__ import annotations

import hmac
import hashlib
import logging
import os
import re
import threading
import unicodedata
from collections import OrderedDict
from typing import Annotated, Any, Self

import numpy as np
import pandas as pd
from fastapi import Body, FastAPI, Header, HTTPException, Path, Query, Response, status
from pydantic import BaseModel, Field, model_validator
from sklearn.cluster import KMeans
from sklearn.ensemble import IsolationForest
from sklearn.linear_model import LinearRegression, LogisticRegression
from sklearn.metrics import (
    accuracy_score,
    f1_score,
    mean_absolute_error,
    mean_squared_error,
    precision_score,
    r2_score,
    recall_score,
    roc_auc_score,
)
from sklearn.model_selection import train_test_split

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
    mae: float
    rmse: float
    cached: bool = False


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

    future_t = pd.DataFrame({"t": np.arange(len(frame), len(frame) + request.periods)})
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
        {"periods": request.periods, "rows": len(frame), "cache_hit": cache_hit},
        {"mae": response.mae, "rmse": response.rmse},
        tenant_id=tenant_id,
    )
    return response


@app.post("/anomalies")
def anomalies(
    values: BoundedNumericValues,
    x_tenant_id: Annotated[str, Header(max_length=MAX_TENANT_ID_LENGTH)] = "anonymous",
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
    values: BoundedNumericValues,
    k: Annotated[int, Query(ge=1, le=100)] = 2,
    x_tenant_id: Annotated[str, Header(max_length=MAX_TENANT_ID_LENGTH)] = "anonymous",
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
    has_date_hint = bool(re.search(r"date|tarih|zaman|time|gun|ay|month", name))
    if pd.api.types.is_numeric_dtype(series) and not has_date_hint:
        return False
    return pd.to_datetime(series, errors="coerce", dayfirst=True, format="mixed").notna().mean() >= 0.7


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
    logger.info(
        "Target candidates scored",
        extra={"candidate_count": len(scored), "best_score": round(scored[0][0], 4)},
    )
    return scored[0][1]


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


def _smape(actual: np.ndarray, predicted: np.ndarray) -> float:
    denominator = np.abs(actual) + np.abs(predicted)
    terms = np.divide(
        2.0 * np.abs(actual - predicted),
        denominator,
        out=np.zeros_like(actual, dtype=float),
        where=denominator > 1e-12,
    )
    return float(np.mean(terms) * 100.0)


MODEL_TIE_BREAK_PRIORITY = {
    "naive_last_value": 0,
    "moving_average_3": 1,
    "seasonal_naive": 2,
    "linear_trend": 3,
}


def _linear_trend_predictions(
    train_time: np.ndarray,
    train_values: np.ndarray,
    prediction_time: np.ndarray,
) -> np.ndarray:
    model = LinearRegression()
    model.fit(train_time.reshape(-1, 1), train_values)
    return model.predict(prediction_time.reshape(-1, 1))


def _recursive_moving_average(values: np.ndarray, periods: int, window: int = 3) -> np.ndarray:
    history = [float(value) for value in values]
    predictions: list[float] = []
    bounded_window = max(1, min(window, len(history)))
    for _ in range(periods):
        prediction = float(np.mean(history[-bounded_window:]))
        predictions.append(prediction)
        history.append(prediction)
    return np.asarray(predictions, dtype=float)


def _recursive_seasonal_naive(values: np.ndarray, periods: int, lag: int) -> np.ndarray:
    history = [float(value) for value in values]
    predictions: list[float] = []
    for _ in range(periods):
        prediction = history[-lag]
        predictions.append(prediction)
        history.append(prediction)
    return np.asarray(predictions, dtype=float)


def _infer_training_seasonality(train_dates: pd.Series) -> tuple[int, str] | None:
    """Infer a conservative seasonal lag from regular training dates only."""
    date_index = pd.DatetimeIndex(train_dates)
    if len(date_index) < 2:
        return None

    differences = np.diff(date_index.asi8) / 86_400_000_000_000
    differences = differences[differences > 0]
    if len(differences) == 0:
        return None

    median_days = float(np.median(differences))
    tolerance_days = max(1.0, median_days * 0.15)
    regularity = float(np.mean(np.abs(differences - median_days) <= tolerance_days))
    if regularity < 0.80:
        return None

    seasonal_spec: tuple[int, str] | None = None
    if 0.75 <= median_days <= 1.5:
        seasonal_spec = (7, "weekly cycle in daily data")
    elif 5.5 <= median_days <= 8.5:
        seasonal_spec = (52, "annual cycle in weekly data")
    elif 25 <= median_days <= 35:
        seasonal_spec = (12, "annual cycle in monthly data")
    elif 75 <= median_days <= 105:
        seasonal_spec = (4, "annual cycle in quarterly data")

    if seasonal_spec is None:
        return None

    lag, label = seasonal_spec
    if len(date_index) < lag * 2:
        return None
    return lag, label


def _score_forecast_candidate(actual: np.ndarray, predicted: np.ndarray) -> dict[str, float | None]:
    mae = float(mean_absolute_error(actual, predicted))
    rmse = float(mean_squared_error(actual, predicted) ** 0.5)
    smape = _smape(actual, predicted)
    r2: float | None = None
    if np.ptp(actual) > max(1e-12, abs(float(np.mean(actual))) * 1e-12):
        r2 = float(r2_score(actual, predicted))
    return {"mae": mae, "rmse": rmse, "r2": r2, "smape": smape}


def _future_dates(dates: pd.Series, periods: int) -> tuple[list[pd.Timestamp], float, str]:
    date_index = pd.DatetimeIndex(dates)
    inferred_frequency: str | None = None
    if len(date_index) >= 3:
        try:
            inferred_frequency = pd.infer_freq(date_index)
        except ValueError:
            inferred_frequency = None

    if inferred_frequency:
        generated = pd.date_range(start=date_index[-1], periods=periods + 1, freq=inferred_frequency)[1:]
        cadence_days = float(np.median(np.diff(date_index.asi8) / 86_400_000_000_000))
        return list(generated), max(cadence_days, 1.0), inferred_frequency

    positive_differences = np.diff(date_index.asi8) / 86_400_000_000_000
    positive_differences = positive_differences[positive_differences > 0]
    cadence_days = float(np.median(positive_differences)) if len(positive_differences) else 1.0
    generated = [date_index[-1] + pd.Timedelta(days=cadence_days * step) for step in range(1, periods + 1)]
    return generated, max(cadence_days, 1.0), "median_observed_interval"


def build_regression_forecast(
    frame: pd.DataFrame,
    target_column: str | None,
    date_columns: list[str],
    periods: int,
) -> tuple[ModelEnvelope | None, list[str]]:
    warnings: list[str] = []
    if target_column is None:
        warning = "Forecast was skipped because no numeric target column was available."
        logger.warning(warning)
        return None, [warning]

    target_values = pd.to_numeric(frame[target_column], errors="coerce")
    target_missing_rows = int(target_values.isna().sum())
    if target_missing_rows:
        warnings.append(f"{target_missing_rows} rows with missing or invalid target values were excluded.")

    date_column: str | None = None
    invalid_date_rows = 0
    aggregation = "row_order"
    forecast_frequency = "row_step"
    future_dates: list[pd.Timestamp] = []

    if date_columns:
        parsed_candidates = [
            (
                column,
                pd.to_datetime(frame[column], errors="coerce", dayfirst=True, format="mixed"),
            )
            for column in date_columns
        ]
        date_column, parsed_dates = max(
            parsed_candidates,
            key=lambda item: int(item[1].notna().sum()),
        )
        invalid_date_rows = int(frame[date_column].notna().sum() - parsed_dates.notna().sum())
        if invalid_date_rows:
            warnings.append(f"{invalid_date_rows} rows with invalid dates were excluded.")

        work = pd.DataFrame({"date": parsed_dates.dt.floor("D"), "target": target_values}).dropna()
        aggregation, aggregation_warning = _target_aggregation(target_column)
        if aggregation_warning:
            warnings.append(aggregation_warning)
        if aggregation == "sum":
            series = work.groupby("date", as_index=False, sort=True)["target"].sum()
        else:
            series = work.groupby("date", as_index=False, sort=True)["target"].mean()
        series = series.sort_values("date").reset_index(drop=True)
        if len(series) >= 1:
            elapsed_days = (series["date"] - series["date"].iloc[0]).dt.total_seconds() / 86_400
            series["t"] = elapsed_days.astype(float)
            future_dates, _cadence_days, forecast_frequency = _future_dates(series["date"], periods)
            future_t = np.array(
                [
                    (date - series["date"].iloc[0]).total_seconds() / 86_400
                    for date in future_dates
                ],
                dtype=float,
            )
        else:
            future_t = np.array([], dtype=float)
    else:
        warnings.append("No usable date column was found; the forecast uses input row order as an explicit fallback.")
        series = pd.DataFrame({"target": target_values}).dropna().reset_index(drop=True)
        series["t"] = np.arange(len(series), dtype=float)
        future_t = np.arange(len(series), len(series) + periods, dtype=float)

    observation_count = len(series)
    if observation_count < 3:
        warning = "Forecast was skipped because fewer than 3 valid chronological observations remained."
        warnings.append(warning)
        logger.warning(warning)
        return None, warnings

    values = series["target"].to_numpy(dtype=float)
    time_values = series["t"].to_numpy(dtype=float)
    is_constant = bool(np.ptp(values) <= max(1e-12, abs(float(np.mean(values))) * 1e-12))
    if is_constant:
        warnings.append("The target is constant; predictive confidence is set to 0 because trend skill cannot be validated.")

    requested_test_rows = max(2, int(np.ceil(observation_count * 0.20)))
    has_holdout = observation_count - requested_test_rows >= 3
    train_rows = observation_count - requested_test_rows if has_holdout else observation_count
    test_rows = requested_test_rows if has_holdout else 0
    validation_method = "chronological_last_20_percent" if has_holdout else "insufficient_data_no_holdout"

    mae: float | None = None
    rmse: float | None = None
    r2: float | None = None
    smape: float | None = None
    confidence = 0.0
    interval_base: float | None = None
    interval_method: str | None = None
    candidate_metrics: list[dict[str, Any]] = []
    selected_model = "linear_trend"
    selected_model_label = "Linear trend"
    selected_parameters: dict[str, int] = {}

    if has_holdout:
        train_time = time_values[:train_rows]
        train_values = values[:train_rows]
        holdout_time = time_values[train_rows:]
        holdout_actual = values[train_rows:]

        candidates: list[dict[str, Any]] = [
            {
                "model": "linear_trend",
                "label": "Linear trend",
                "parameters": {},
                "predictions": _linear_trend_predictions(train_time, train_values, holdout_time),
            },
            {
                "model": "naive_last_value",
                "label": "Naive last value",
                "parameters": {},
                "predictions": np.full(test_rows, train_values[-1], dtype=float),
            },
            {
                "model": "moving_average_3",
                "label": "3-point moving average",
                "parameters": {"window": 3},
                "predictions": _recursive_moving_average(train_values, test_rows, window=3),
            },
        ]

        seasonal_spec = None
        if date_column:
            seasonal_spec = _infer_training_seasonality(series["date"].iloc[:train_rows])
        if seasonal_spec is not None:
            seasonal_lag, seasonal_label = seasonal_spec
            candidates.append(
                {
                    "model": "seasonal_naive",
                    "label": f"Seasonal naive (lag {seasonal_lag})",
                    "parameters": {"lag": seasonal_lag},
                    "seasonality": seasonal_label,
                    "predictions": _recursive_seasonal_naive(
                        train_values,
                        test_rows,
                        seasonal_lag,
                    ),
                }
            )

        scored_candidates: list[dict[str, Any]] = []
        for candidate in candidates:
            candidate_scores = _score_forecast_candidate(
                holdout_actual,
                candidate["predictions"],
            )
            scored_candidates.append({**candidate, **candidate_scores})

        winner = min(
            scored_candidates,
            key=lambda candidate: (
                candidate["mae"],
                MODEL_TIE_BREAK_PRIORITY[candidate["model"]],
                candidate["model"],
            ),
        )
        selected_model = winner["model"]
        selected_model_label = winner["label"]
        selected_parameters = winner["parameters"]
        holdout_prediction = winner["predictions"]
        mae = winner["mae"]
        rmse = winner["rmse"]
        r2 = winner["r2"]
        smape = winner["smape"]

        ranked_candidates = sorted(
            scored_candidates,
            key=lambda candidate: (
                candidate["mae"],
                MODEL_TIE_BREAK_PRIORITY[candidate["model"]],
                candidate["model"],
            ),
        )
        for rank, candidate in enumerate(ranked_candidates, start=1):
            candidate_metrics.append(
                {
                    "model": candidate["model"],
                    "label": candidate["label"],
                    "parameters": candidate["parameters"],
                    "mae": round(candidate["mae"], 4),
                    "rmse": round(candidate["rmse"], 4),
                    "r2": round(candidate["r2"], 4) if candidate["r2"] is not None else None,
                    "smape": round(candidate["smape"], 4),
                    "rank": rank,
                    "selected": candidate["model"] == selected_model,
                }
            )

        if r2 is None:
            warnings.append("Holdout target values are constant, so out-of-sample R² is undefined.")

        scale = max(float(np.mean(np.abs(holdout_actual))), float(np.std(values[:train_rows])), 1e-9)
        mae_score = max(0.0, 1.0 - min(1.0, mae / scale))
        rmse_score = max(0.0, 1.0 - min(1.0, rmse / scale))
        smape_score = max(0.0, 1.0 - min(1.0, smape / 100.0))
        error_score = 0.30 * mae_score + 0.40 * rmse_score + 0.30 * smape_score
        depth_factor = min(1.0, train_rows / 20.0)
        confidence = min(0.95, error_score * (0.45 + 0.55 * depth_factor))
        absolute_residuals = np.abs(holdout_actual - holdout_prediction)
        interval_base = float(np.quantile(absolute_residuals, 0.95, method="higher"))
        interval_method = "empirical_holdout_absolute_error_95pct_with_horizon_scaling"
    else:
        warnings.append(
            "At least 5 valid chronological observations are required for a 3-row train / 2-row holdout split; confidence is set to 0."
        )

    if is_constant:
        confidence = 0.0

    if selected_model == "naive_last_value":
        predicted = np.full(periods, values[-1], dtype=float)
    elif selected_model == "moving_average_3":
        predicted = _recursive_moving_average(values, periods, window=3)
    elif selected_model == "seasonal_naive":
        predicted = _recursive_seasonal_naive(
            values,
            periods,
            selected_parameters["lag"],
        )
    else:
        predicted = _linear_trend_predictions(time_values, values, future_t)

    forecast_data: list[dict[str, Any]] = []
    for index, value in enumerate(predicted):
        point: dict[str, Any] = {
            "row": f"T+{index + 1}",
            "predicted": round(float(value), 4),
        }
        if future_dates:
            point["date"] = future_dates[index].date().isoformat()
        if interval_base is not None:
            width = interval_base * np.sqrt(1.0 + (index + 1) / max(train_rows, 1))
            point["lower"] = round(float(value - width), 4)
            point["upper"] = round(float(value + width), 4)
        forecast_data.append(point)

    metrics: dict[str, Any] = {
        "mae": round(mae, 4) if mae is not None else None,
        "rmse": round(rmse, 4) if rmse is not None else None,
        "r2": round(r2, 4) if r2 is not None else None,
        "smape": round(smape, 4) if smape is not None else None,
        "train_rows": train_rows,
        "test_rows": test_rows,
        "validation_method": validation_method,
        "validation": {
            "method": validation_method,
            "strategy": "all candidates fit on training rows only; holdout used only for scoring",
            "holdout_fraction": 0.20 if has_holdout else 0.0,
            "train_rows": train_rows,
            "test_rows": test_rows,
        },
        "selection_metric": "mae",
        "selected_model": selected_model,
        "selected_model_parameters": selected_parameters,
        "candidate_metrics": candidate_metrics,
        "date_column": date_column,
        "aggregation": aggregation,
        "forecast_frequency": forecast_frequency,
        "interval_method": interval_method,
        "interval_residual_count": test_rows if interval_method else 0,
        "target_missing_rows": target_missing_rows,
        "invalid_date_rows": invalid_date_rows,
        "data_warnings": warnings,
    }
    time_basis = f"daily {aggregation} aggregation on {date_column}" if date_column else "explicit row-order fallback"
    if has_holdout:
        model_label = (
            f"{selected_model_label} selected by lowest holdout MAE from "
            f"{len(candidate_metrics)} training-only candidates "
            f"({time_basis}; chronological holdout validation)"
        )
    else:
        model_label = (
            f"sklearn LinearRegression time trend ({time_basis}; "
            "insufficient data for chronological holdout model selection)"
        )

    logger.info(
        "Forecast validation completed",
        extra={
            "observation_count": observation_count,
            "train_rows": train_rows,
            "test_rows": test_rows,
            "validation_method": validation_method,
            "selected_model": selected_model,
            "candidate_count": len(candidate_metrics),
            "confidence": round(confidence, 4),
        },
    )
    return ModelEnvelope(
        type="forecast",
        confidence=round(confidence, 4),
        model=model_label,
        metrics=metrics,
        data=forecast_data,
    ), warnings


def build_anomaly_detection(frame: pd.DataFrame, numeric_columns: list[str]) -> ModelEnvelope | None:
    if len(numeric_columns) == 0 or len(frame) < 4:
        return None

    numeric_frame = frame[numeric_columns].apply(pd.to_numeric, errors="coerce")
    all_missing_columns = [column for column in numeric_frame.columns if numeric_frame[column].isna().all()]
    if all_missing_columns:
        logger.warning(
            "Anomaly feature columns are fully missing and will fall back to 0",
            extra={"column_count": len(all_missing_columns)},
        )
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


CLASSIFICATION_USE_CASES = (
    ("churn_risk", "Müşteri kaybı riski", re.compile(r"churn|kayip|terk|iptal|lost customer")),
    ("fraud_risk", "Dolandırıcılık riski", re.compile(r"fraud|dolandir|sahte|supheli|risk flag")),
    ("employee_turnover", "Personel devir riski", re.compile(r"turnover|attrition|isten ayril|personel kayip")),
)


def _binary_target(series: pd.Series) -> pd.Series:
    positive = {"1", "true", "yes", "evet", "e", "y", "churn", "lost", "fraud", "ayrildi", "terk"}
    negative = {"0", "false", "no", "hayir", "h", "n", "active", "retained", "normal", "devam"}

    def convert(value: Any) -> float:
        if pd.isna(value):
            return np.nan
        if isinstance(value, (int, float, np.integer, np.floating)) and float(value) in (0.0, 1.0):
            return float(value)
        normalized = normalize_column_name(str(value))
        if normalized in positive:
            return 1.0
        if normalized in negative:
            return 0.0
        return np.nan

    return series.map(convert).astype(float)


def build_classification_use_cases(frame: pd.DataFrame) -> tuple[list[ModelEnvelope], list[str]]:
    results: list[ModelEnvelope] = []
    warnings: list[str] = []
    hinted_columns = {
        column
        for column in frame.columns
        if any(pattern.search(normalize_column_name(column)) for _, _, pattern in CLASSIFICATION_USE_CASES)
    }

    for use_case, label, pattern in CLASSIFICATION_USE_CASES:
        target_column = next(
            (column for column in frame.columns if pattern.search(normalize_column_name(column))),
            None,
        )
        if target_column is None:
            continue
        target = _binary_target(frame[target_column])
        valid = target.notna()
        class_counts = target[valid].value_counts()
        if int(valid.sum()) < 20 or len(class_counts) != 2 or int(class_counts.min()) < 5:
            warnings.append(
                f"{label} modeli için '{target_column}' bulundu ancak en az 20 etiketli satır ve her sınıfta 5 örnek gerekir."
            )
            continue

        feature_data: dict[str, pd.Series] = {}
        for column in frame.columns:
            if column in hinted_columns or is_identifier_column(column, frame[column]) or is_date_column(column, frame[column]):
                continue
            source = frame.loc[valid, column]
            numeric = pd.to_numeric(source, errors="coerce")
            if numeric.notna().mean() >= 0.7:
                feature_data[column] = numeric.fillna(numeric.median()).fillna(0)
                continue
            unique_count = int(source.dropna().astype(str).nunique())
            if 1 < unique_count <= 50:
                feature_data[column] = source.fillna("Bilinmiyor").astype(str)
            if len(feature_data) >= 30:
                break

        if not feature_data:
            warnings.append(f"{label} modeli için kullanılabilir açıklayıcı kolon bulunamadı.")
            continue

        features = pd.DataFrame(feature_data, index=frame.index[valid])
        encoded = pd.get_dummies(features, dummy_na=False, dtype=float)
        encoded = encoded.replace([np.inf, -np.inf], np.nan).fillna(0)
        encoded = encoded.loc[:, encoded.nunique(dropna=False) > 1]
        if encoded.shape[1] == 0:
            warnings.append(f"{label} modeli için değişken özellik bulunamadı.")
            continue

        y = target.loc[encoded.index].astype(int)
        x_train, x_test, y_train, y_test = train_test_split(
            encoded,
            y,
            test_size=0.25,
            random_state=42,
            stratify=y,
        )
        validation_model = LogisticRegression(max_iter=1_000, class_weight="balanced", random_state=42)
        validation_model.fit(x_train, y_train)
        predicted = validation_model.predict(x_test)
        probabilities = validation_model.predict_proba(x_test)[:, 1]
        roc_auc = float(roc_auc_score(y_test, probabilities)) if y_test.nunique() == 2 else 0.0

        model = LogisticRegression(max_iter=1_000, class_weight="balanced", random_state=42)
        model.fit(encoded, y)
        all_probabilities = model.predict_proba(encoded)[:, 1]
        ranked = sorted(
            (
                {"row": int(index), "risk_score": round(float(score), 4)}
                for index, score in zip(encoded.index.tolist(), all_probabilities, strict=True)
            ),
            key=lambda item: item["risk_score"],
            reverse=True,
        )[:10]
        drivers = sorted(
            (
                {"feature": str(feature), "coefficient": round(float(coefficient), 4)}
                for feature, coefficient in zip(encoded.columns, model.coef_[0], strict=True)
            ),
            key=lambda item: abs(item["coefficient"]),
            reverse=True,
        )[:8]
        metrics: dict[str, Any] = {
            "use_case": use_case,
            "label": label,
            "target_column": target_column,
            "train_rows": int(len(x_train)),
            "test_rows": int(len(x_test)),
            "positive_rows": int((y == 1).sum()),
            "accuracy": round(float(accuracy_score(y_test, predicted)), 4),
            "precision": round(float(precision_score(y_test, predicted, zero_division=0)), 4),
            "recall": round(float(recall_score(y_test, predicted, zero_division=0)), 4),
            "f1": round(float(f1_score(y_test, predicted, zero_division=0)), 4),
            "roc_auc": round(roc_auc, 4),
            "validation_method": "stratified_25_percent_holdout",
            "drivers": drivers,
        }
        results.append(ModelEnvelope(
            type="classification",
            confidence=round(roc_auc, 4),
            model="Açıklanabilir LogisticRegression + stratified holdout",
            metrics=metrics,
            data=ranked,
        ))

    return results, warnings


def build_segments(frame: pd.DataFrame, numeric_columns: list[str]) -> ModelEnvelope | None:
    if len(numeric_columns) == 0 or len(frame) < 4:
        return None

    numeric_frame = frame[numeric_columns].apply(pd.to_numeric, errors="coerce")
    all_missing_columns = [column for column in numeric_frame.columns if numeric_frame[column].isna().all()]
    if all_missing_columns:
        logger.warning(
            "Segment feature columns are fully missing and will fall back to 0",
            extra={"column_count": len(all_missing_columns)},
        )
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
