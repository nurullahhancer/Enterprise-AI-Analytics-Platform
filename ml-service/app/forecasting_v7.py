from __future__ import annotations

import math
import re
import unicodedata
from dataclasses import dataclass
from typing import Any, Callable

import numpy as np
import pandas as pd
from sklearn.linear_model import HuberRegressor, LinearRegression
from sklearn.metrics import r2_score


@dataclass(frozen=True)
class CandidateSpec:
    name: str
    label: str
    parameters: dict[str, int | float]
    priority: int


def _normalize(value: str) -> str:
    normalized = unicodedata.normalize("NFD", str(value).lower().replace("ı", "i"))
    normalized = "".join(char for char in normalized if unicodedata.category(char) != "Mn")
    return re.sub(r"[^a-z0-9]+", " ", normalized).strip()


def _smape(actual: np.ndarray, predicted: np.ndarray) -> float:
    actual = np.asarray(actual, dtype=float)
    predicted = np.asarray(predicted, dtype=float)
    denominator = np.abs(actual) + np.abs(predicted)
    terms = np.divide(
        2.0 * np.abs(actual - predicted),
        denominator,
        out=np.zeros_like(actual, dtype=float),
        where=denominator > 1e-12,
    )
    return float(np.mean(terms) * 100.0)


def _safe_r2(actual: np.ndarray, predicted: np.ndarray) -> float | None:
    actual = np.asarray(actual, dtype=float)
    if len(actual) < 2:
        return None
    tolerance = max(1e-12, abs(float(np.mean(actual))) * 1e-12)
    if np.ptp(actual) <= tolerance:
        return None
    return float(r2_score(actual, predicted))


def _score(
    actual: np.ndarray,
    predicted: np.ndarray,
    scale_errors: np.ndarray | None = None,
    naive_predictions: np.ndarray | None = None,
) -> dict[str, float | None]:
    """Return out-of-sample metrics with honest baseline semantics.

    `mase` uses the in-sample one-step naive error scale. `mae_vs_naive_ratio`
    compares the candidate against an explicit out-of-sample naive forecast.
    They are deliberately separate because they answer different questions.
    """
    actual = np.asarray(actual, dtype=float)
    predicted = np.asarray(predicted, dtype=float)
    if len(actual) == 0 or len(actual) != len(predicted):
        raise ValueError("actual and predicted must be non-empty and have equal length")
    if not np.isfinite(actual).all() or not np.isfinite(predicted).all():
        raise ValueError("metrics require finite actual and predicted values")

    errors = actual - predicted
    mae = float(np.mean(np.abs(errors)))
    rmse = float(np.sqrt(np.mean(np.square(errors))))
    smape = _smape(actual, predicted)
    absolute_total = float(np.sum(np.abs(actual)))
    wape = float(np.sum(np.abs(errors)) / absolute_total * 100.0) if absolute_total > 1e-12 else None
    scale = max(float(np.mean(np.abs(actual))), 1e-9)
    relative_mae = mae / scale

    mase: float | None = None
    if scale_errors is not None:
        finite_scale = np.asarray(scale_errors, dtype=float)
        finite_scale = finite_scale[np.isfinite(finite_scale)]
        denominator = float(np.mean(np.abs(finite_scale))) if len(finite_scale) else 0.0
        if denominator > 1e-12:
            mase = mae / denominator

    mae_vs_naive_ratio: float | None = None
    if naive_predictions is not None:
        naive_predictions = np.asarray(naive_predictions, dtype=float)
        if len(naive_predictions) == len(actual) and np.isfinite(naive_predictions).all():
            naive_mae = float(np.mean(np.abs(actual - naive_predictions)))
            if naive_mae > 1e-12:
                mae_vs_naive_ratio = mae / naive_mae
            elif mae <= 1e-12:
                mae_vs_naive_ratio = 1.0

    return {
        "mae": mae,
        "rmse": rmse,
        "r2": _safe_r2(actual, predicted),
        "smape": smape,
        "wape": wape,
        "relative_mae": relative_mae,
        "mase": mase,
        "mae_vs_naive_ratio": mae_vs_naive_ratio,
    }


def _mase_scale_errors(history: np.ndarray, lag: int | None) -> np.ndarray | None:
    """Return the in-sample naive scale used by MASE.

    Seasonal series use the detected seasonal lag; non-seasonal series use lag 1.
    """
    values = np.asarray(history, dtype=float)
    effective_lag = max(1, int(lag or 1))
    if len(values) <= effective_lag:
        return None
    errors = values[effective_lag:] - values[:-effective_lag]
    errors = errors[np.isfinite(errors)]
    return errors if len(errors) else None


def _decision_support_level(quality_grade: str) -> str:
    return {
        "high": "supporting_signal_with_monitoring",
        "medium": "supporting_signal_with_scenario_checks",
        "low": "rough_baseline_do_not_use_alone",
        "very_low": "exploratory_only_revalidate_before_action",
    }.get(quality_grade, "exploratory_only_revalidate_before_action")


def select_target_column_v7(
    frame: pd.DataFrame,
    numeric_columns: list[str],
    requested: str | None,
) -> str | None:
    """Select a forecast target conservatively and fail closed on ambiguity.

    An explicit valid target always wins. Automatic selection is allowed only
    when one column has clear business-measure semantics and is meaningfully
    stronger than the runner-up. This prevents silently forecasting gross
    revenue when the user intended net revenue (or vice versa).
    """
    if requested:
        if requested in numeric_columns:
            return requested
        normalized_requested = _normalize(requested)
        matches = [column for column in numeric_columns if _normalize(column) == normalized_requested]
        return matches[0] if len(matches) == 1 else None
    if not numeric_columns:
        return None

    candidates: list[tuple[float, int, str]] = []
    for column in numeric_columns:
        name = _normalize(column)
        if re.search(r"(^| )(id|uuid|guid|key|sku|ean|iban|kod|code|telefon|phone)( |$)", name):
            continue
        if re.search(r"date|tarih|zaman|time|year|yil|month|ay", name):
            continue
        values = coerce_numeric_series(frame[column])
        valid = values.dropna()
        if len(valid) < max(3, int(math.ceil(len(frame) * 0.50))):
            continue
        semantic = 0
        if re.search(r"ciro|gelir|revenue|sales|satis|amount|tutar|toplam|total|cost|maliyet|expense|gider|profit|kar|loss|zarar", name):
            semantic += 10
        if re.search(r"demand|talep|volume|hacim|adet|quantity|qty|count|miktar", name):
            semantic += 6
        if re.search(r"price|fiyat|rate|oran|ratio|percent|yuzde|score|skor|average|ortalama", name):
            semantic += 3
        if re.search(r"birim|unit", name):
            semantic -= 4
        if semantic <= 0:
            continue
        coverage = float(valid.size / max(len(frame), 1))
        variation = 1.0 if valid.nunique(dropna=True) > 1 else -2.0
        score = float(semantic + coverage + variation)
        candidates.append((score, semantic, column))

    if not candidates:
        return None
    candidates.sort(key=lambda item: (-item[0], -item[1], _normalize(item[2])))
    best = candidates[0]
    if len(candidates) > 1:
        runner_up = candidates[1]
        # Similar strong semantic candidates are genuinely ambiguous. Require
        # an explicit target rather than resolving the tie alphabetically.
        if best[1] >= 6 and runner_up[1] >= 6 and best[0] - runner_up[0] < 1.0:
            return None
    return best[2]


def coerce_numeric_series(series: pd.Series) -> pd.Series:
    """Parse common Turkish/English numeric formats conservatively.

    Examples: ``₺1.234,56``, ``1,234.56``, ``%12,5`` and parenthesized
    negatives. A text column is accepted only when at least 70% of non-empty
    values are parseable, preventing arbitrary labels from becoming numbers.
    """
    if pd.api.types.is_numeric_dtype(series):
        return pd.to_numeric(series, errors="coerce").astype(float).replace([np.inf, -np.inf], np.nan)
    raw = series.astype("string").str.strip()
    nonempty = raw.notna() & raw.ne("")
    if int(nonempty.sum()) == 0:
        return pd.Series(np.nan, index=series.index, dtype=float)

    def parse_one(value: Any) -> float:
        if value is None or pd.isna(value):
            return math.nan
        text = str(value).strip()
        if not text:
            return math.nan
        is_percent = "%" in text
        negative = text.startswith("(") and text.endswith(")")
        text = re.sub(r"[\s\u00a0₺€£$%]", "", text.strip("()"))
        text = re.sub(r"[^0-9,\.\-+]", "", text)
        if text in {"", "+", "-", ".", ","}:
            return math.nan
        comma = text.rfind(",")
        dot = text.rfind(".")
        if comma >= 0 and dot >= 0:
            decimal_sep = "," if comma > dot else "."
            thousands_sep = "." if decimal_sep == "," else ","
            text = text.replace(thousands_sep, "").replace(decimal_sep, ".")
        elif comma >= 0:
            right = len(text) - comma - 1
            text = text.replace(",", "") if right == 3 and text.count(",") == 1 else text.replace(",", ".")
        elif dot >= 0 and text.count(".") > 1:
            parts = text.split(".")
            text = "".join(parts[:-1]) + "." + parts[-1]
        try:
            number = float(text)
        except ValueError:
            return math.nan
        if is_percent:
            number /= 100.0
        return -abs(number) if negative else number

    converted = raw.map(parse_one).astype(float).replace([np.inf, -np.inf], np.nan)
    if float(converted[nonempty].notna().mean()) < 0.70:
        return pd.Series(np.nan, index=series.index, dtype=float)
    return converted


def _huber_prediction(history: np.ndarray, periods: int, recent_window: int | None = None) -> np.ndarray:
    history = np.asarray(history, dtype=float)
    bounded = len(history) if recent_window is None else max(8, min(int(recent_window), len(history)))
    fitted = history[-bounded:]
    start = len(history) - bounded
    x = np.arange(start, len(history), dtype=float).reshape(-1, 1)
    try:
        model = HuberRegressor(epsilon=1.35, alpha=0.0001, max_iter=500).fit(x, fitted)
        future_x = np.arange(len(history), len(history) + periods, dtype=float).reshape(-1, 1)
        return model.predict(future_x).astype(float)
    except (ValueError, FloatingPointError):
        return _linear_prediction(history, periods, recent_window)


def _linear_prediction(history: np.ndarray, periods: int, recent_window: int | None = None) -> np.ndarray:
    history = np.asarray(history, dtype=float)
    if recent_window is not None:
        bounded = max(3, min(int(recent_window), len(history)))
        fitted_history = history[-bounded:]
        start = len(history) - bounded
    else:
        fitted_history = history
        start = 0
    x = np.arange(start, len(history), dtype=float).reshape(-1, 1)
    model = LinearRegression().fit(x, fitted_history)
    future_x = np.arange(len(history), len(history) + periods, dtype=float).reshape(-1, 1)
    return model.predict(future_x).astype(float)


def _moving_average_prediction(history: np.ndarray, periods: int, window: int = 3) -> np.ndarray:
    values = [float(value) for value in np.asarray(history, dtype=float)]
    window = max(1, min(window, len(values)))
    predictions: list[float] = []
    for _ in range(periods):
        prediction = float(np.mean(values[-window:]))
        predictions.append(prediction)
        values.append(prediction)
    return np.asarray(predictions, dtype=float)


def _seasonal_naive_prediction(history: np.ndarray, periods: int, lag: int) -> np.ndarray:
    values = [float(value) for value in np.asarray(history, dtype=float)]
    predictions: list[float] = []
    for _ in range(periods):
        prediction = values[-lag]
        predictions.append(prediction)
        values.append(prediction)
    return np.asarray(predictions, dtype=float)


def _seasonal_mean_prediction(history: np.ndarray, periods: int, lag: int, cycles: int = 4) -> np.ndarray:
    values = [float(value) for value in np.asarray(history, dtype=float)]
    predictions: list[float] = []
    for _ in range(periods):
        positions = []
        index = len(values) - lag
        while index >= 0 and len(positions) < cycles:
            positions.append(values[index])
            index -= lag
        prediction = float(np.mean(positions)) if positions else values[-1]
        predictions.append(prediction)
        values.append(prediction)
    return np.asarray(predictions, dtype=float)


def _seasonal_growth_prediction(history: np.ndarray, periods: int, lag: int) -> np.ndarray:
    values = [float(value) for value in np.asarray(history, dtype=float)]
    predictions: list[float] = []
    recent = np.asarray(values[-lag:], dtype=float)
    previous = np.asarray(values[-2 * lag:-lag], dtype=float)
    valid = np.abs(previous) > 1e-9
    if np.any(valid):
        growth = float(np.median(recent[valid] / previous[valid]))
        # Avoid explosive extrapolation from a single abnormal year.
        growth = float(np.clip(growth, 0.70, 1.30))
    else:
        growth = 1.0
    for _ in range(periods):
        base = values[-lag]
        prediction = base * growth
        predictions.append(prediction)
        values.append(prediction)
    return np.asarray(predictions, dtype=float)


def _damped_drift_prediction(history: np.ndarray, periods: int, phi: float = 0.90) -> np.ndarray:
    history = np.asarray(history, dtype=float)
    if len(history) < 2:
        return np.full(periods, float(history[-1]), dtype=float)
    differences = np.diff(history[-min(len(history), 31):])
    slope = float(np.median(differences)) if len(differences) else 0.0
    predictions = []
    cumulative = 0.0
    for step in range(1, periods + 1):
        cumulative += phi ** (step - 1)
        predictions.append(float(history[-1] + slope * cumulative))
    return np.asarray(predictions, dtype=float)


def _croston_prediction(history: np.ndarray, periods: int, alpha: float = 0.10) -> np.ndarray:
    """Croston-style forecast for intermittent non-negative demand."""
    history = np.asarray(history, dtype=float)
    nonzero_indices = np.flatnonzero(history > 1e-12)
    if len(nonzero_indices) == 0:
        return np.zeros(periods, dtype=float)
    first = int(nonzero_indices[0])
    demand_estimate = float(history[first])
    interval_estimate = float(first + 1)
    last_nonzero = first
    for index in nonzero_indices[1:]:
        interval = float(index - last_nonzero)
        demand_estimate += alpha * (float(history[index]) - demand_estimate)
        interval_estimate += alpha * (interval - interval_estimate)
        last_nonzero = int(index)
    forecast = demand_estimate / max(interval_estimate, 1e-9)
    return np.full(periods, forecast, dtype=float)


def _predict(spec: CandidateSpec, history: np.ndarray, periods: int) -> np.ndarray:
    if periods < 1:
        return np.asarray([], dtype=float)
    if spec.name == "naive_last_value":
        return np.full(periods, float(history[-1]), dtype=float)
    if spec.name == "moving_average_3":
        return _moving_average_prediction(history, periods, spec.parameters.get("window", 3))
    if spec.name == "seasonal_naive":
        return _seasonal_naive_prediction(history, periods, spec.parameters["lag"])
    if spec.name == "seasonal_mean":
        return _seasonal_mean_prediction(
            history,
            periods,
            spec.parameters["lag"],
            spec.parameters.get("cycles", 2),
        )
    if spec.name == "seasonal_growth":
        return _seasonal_growth_prediction(history, periods, spec.parameters["lag"])
    if spec.name == "linear_recent":
        return _linear_prediction(history, periods, int(spec.parameters.get("window", 90)))
    if spec.name == "huber_trend":
        return _huber_prediction(history, periods, None)
    if spec.name == "huber_recent":
        return _huber_prediction(history, periods, int(spec.parameters.get("window", 90)))
    if spec.name == "damped_drift":
        return _damped_drift_prediction(history, periods, float(spec.parameters.get("phi", 0.90)))
    if spec.name == "croston":
        return _croston_prediction(history, periods, float(spec.parameters.get("alpha", 0.10)))
    return _linear_prediction(history, periods)


def _infer_frequency(date_series: pd.Series) -> tuple[str | None, float, str]:
    dates = pd.DatetimeIndex(pd.to_datetime(date_series, errors="coerce")).dropna().sort_values().unique()
    if len(dates) < 2:
        return None, 1.0, "unknown"
    inferred: str | None = None
    if len(dates) >= 3:
        try:
            inferred = pd.infer_freq(dates)
        except ValueError:
            inferred = None
    differences = np.diff(dates.asi8) / 86_400_000_000_000
    differences = differences[differences > 0]
    median_days = float(np.median(differences)) if len(differences) else 1.0
    weekdays_only = bool(np.all(dates.weekday < 5))
    business_like = weekdays_only and len(differences) > 0 and float(
        np.mean(np.isin(np.round(differences).astype(int), [1, 3]))
    ) >= 0.80
    if business_like:
        return "B", 1.0, "business_day_pattern"
    tolerance = max(1.0, median_days * 0.15)
    regularity = float(np.mean(np.abs(differences - median_days) <= tolerance)) if len(differences) else 0.0
    if inferred:
        return inferred, median_days, "pandas_infer_freq"
    if regularity >= 0.95:
        if 0.75 <= median_days <= 1.5:
            return "D", median_days, "median_daily"
        if 5.5 <= median_days <= 8.5:
            return "7D", median_days, "median_weekly"
        if 25 <= median_days <= 35:
            return "MS", median_days, "median_monthly"
        if 75 <= median_days <= 105:
            return "QS", median_days, "median_quarterly"
    return None, max(median_days, 1.0), "irregular"


def _future_dates(date_series: pd.Series, periods: int, frequency: str | None, cadence_days: float) -> list[pd.Timestamp]:
    last_date = pd.Timestamp(pd.to_datetime(date_series).max())
    if frequency:
        try:
            return list(pd.date_range(start=last_date, periods=periods + 1, freq=frequency)[1:])
        except (ValueError, TypeError):
            pass
    return [last_date + pd.Timedelta(days=cadence_days * step) for step in range(1, periods + 1)]


def _seasonal_spec(frequency: str | None, cadence_days: float, n: int) -> tuple[int, str] | None:
    # Seasonality is enabled only for a regular, explicitly inferred frequency.
    # A median gap by itself is not enough: missing/irregular dates would make a
    # positional seasonal lag refer to the wrong calendar period.
    if frequency is None:
        return None
    normalized = frequency.upper()
    lag: int | None = None
    label = ""
    if normalized.startswith("B"):
        lag, label = 5, "weekly cycle in business-day data"
    elif normalized.startswith("D"):
        lag, label = 7, "weekly cycle in daily data"
    elif normalized.startswith("W") or normalized == "7D":
        lag, label = 52, "annual cycle in weekly data"
    elif normalized.startswith("M"):
        lag, label = 12, "annual cycle in monthly data"
    elif normalized.startswith("Q"):
        lag, label = 4, "annual cycle in quarterly data"
    if lag is None or n < lag * 2:
        return None
    return lag, label


def _validation_horizons(
    frequency: str | None,
    primary_horizon: int,
    development_rows: int,
) -> list[int]:
    """Choose calendar-appropriate horizons without overwhelming short series."""
    primary = max(1, min(int(primary_horizon), max(1, development_rows // 4)))
    candidates = [primary]
    normalized = (frequency or "").upper()
    if normalized.startswith(("D", "B")):
        candidates.extend([7, 14, 28])
    elif normalized.startswith("W") or normalized == "7D":
        candidates.extend([4, 13, 26])
    elif normalized.startswith("M"):
        candidates.extend([3, 6, 12])
    elif normalized.startswith("Q"):
        candidates.extend([2, 4])
    # At least roughly three horizons must fit: two for training context and one
    # for validation. This avoids a single long, weakly supported fold.
    return sorted({h for h in candidates if h >= 1 and development_rows >= h * 3}) or [primary]


def _final_test_rows(observation_count: int, periods: int) -> int:
    """Reserve an untouched test without consuming most of seasonal history."""
    base = max(2, int(math.ceil(observation_count * 0.20)))
    requested_horizon = min(max(2, int(periods)), max(2, observation_count // 4))
    return min(max(base, requested_horizon), max(2, observation_count // 3))


def _infer_bounds(values: np.ndarray, target_column: str) -> tuple[float | None, float | None]:
    """Infer only defensible domain bounds from target semantics.

    Historical observations being non-negative is not enough to prove that the
    underlying variable can never be negative. Bounds are therefore applied only
    when the target name clearly denotes a non-negative business quantity.
    """
    del values  # Kept in the signature for API compatibility and future rules.
    name = _normalize(target_column)
    non_negative = bool(re.search(
        r"ciro|gelir|revenue|sales|satis|amount|tutar|adet|quantity|qty|miktar|count|stok|stock|price|fiyat|visitor|ziyaret|traffic|trafik|demand|talep",
        name,
    ))
    signed = bool(re.search(
        r"kar|profit|loss|zarar|margin|marj|growth|buyume|change|degisim|delta|fark|difference|variance|varyans|balance|bakiye|cash flow|nakit akis|temperature|sicaklik",
        name,
    ))
    if non_negative and not signed:
        return 0.0, None
    return None, None


def _clip(values: np.ndarray, lower: float | None, upper: float | None) -> np.ndarray:
    result = np.asarray(values, dtype=float)
    if lower is not None:
        result = np.maximum(result, lower)
    if upper is not None:
        result = np.minimum(result, upper)
    return result


def _candidate_specs(
    seasonal: tuple[int, str] | None,
    development_values: np.ndarray,
) -> list[CandidateSpec]:
    development_rows = len(development_values)
    specs = [
        CandidateSpec("naive_last_value", "Naive last value", {}, 0),
        CandidateSpec("moving_average_3", "3-point moving average", {"window": 3}, 1),
        CandidateSpec("damped_drift", "Damped robust drift", {"phi": 0.90}, 2),
        CandidateSpec("huber_trend", "Robust Huber trend", {}, 3),
        CandidateSpec("linear_trend", "Linear trend", {}, 5),
    ]
    if development_rows >= 30:
        window = min(90, development_rows)
        specs.append(CandidateSpec("huber_recent", "Recent-window robust Huber trend", {"window": window}, 3))
        specs.append(CandidateSpec("linear_recent", "Recent-window linear trend", {"window": window}, 4))
    if seasonal is not None:
        lag, _ = seasonal
        specs.extend([
            CandidateSpec("seasonal_naive", f"Seasonal naive (lag {lag})", {"lag": lag}, 2),
            CandidateSpec("seasonal_mean", f"Seasonal mean (lag {lag})", {"lag": lag, "cycles": 3}, 4),
        ])
        # Multiplicative seasonal growth is meaningful only for predominantly
        # positive, non-negative level series. Profit/loss and balance series can
        # cross zero, where ratios become unstable or economically meaningless.
        positive_share = float(np.mean(development_values > 1e-9))
        if np.all(development_values >= -1e-12) and positive_share >= 0.80:
            specs.append(CandidateSpec("seasonal_growth", f"Seasonal growth (lag {lag})", {"lag": lag}, 3))
    if development_rows >= 20 and np.all(development_values >= -1e-12):
        zero_fraction = float(np.mean(np.abs(development_values) <= 1e-12))
        if zero_fraction >= 0.20:
            specs.append(CandidateSpec("croston", "Croston intermittent-demand baseline", {"alpha": 0.10}, 3))
    return specs

def _rolling_origins(n: int, horizon: int, minimum_train: int, max_folds: int = 8) -> list[int]:
    latest_origin = n - horizon
    if latest_origin < minimum_train:
        return []
    available = list(range(minimum_train, latest_origin + 1, horizon))
    if not available or available[-1] != latest_origin:
        available.append(latest_origin)
    if len(available) <= max_folds:
        return available
    indices = np.linspace(0, len(available) - 1, max_folds, dtype=int)
    return sorted({available[int(index)] for index in indices})


def _evaluate_candidate(
    spec: CandidateSpec,
    values: np.ndarray,
    origins: list[int],
    horizon: int,
    lower: float | None,
    upper: float | None,
    mase_lag: int | None,
) -> dict[str, Any] | None:
    actual_parts: list[np.ndarray] = []
    predicted_parts: list[np.ndarray] = []
    naive_prediction_parts: list[np.ndarray] = []
    scale_error_parts: list[np.ndarray] = []
    horizon_steps: list[int] = []
    used_origins = 0
    for origin in origins:
        history = values[:origin]
        if len(history) < 2:
            continue
        if spec.name.startswith("seasonal") and len(history) < spec.parameters["lag"] * 2:
            continue
        actual = values[origin : origin + horizon]
        if len(actual) == 0:
            continue
        predicted = _clip(_predict(spec, history, len(actual)), lower, upper)
        naive = np.full(len(actual), float(history[-1]), dtype=float)
        actual_parts.append(actual)
        predicted_parts.append(predicted)
        naive_prediction_parts.append(naive)
        scale = _mase_scale_errors(history, mase_lag)
        if scale is not None:
            scale_error_parts.append(scale)
        horizon_steps.extend(range(1, len(actual) + 1))
        used_origins += 1
    if not actual_parts:
        return None
    actual_all = np.concatenate(actual_parts)
    predicted_all = np.concatenate(predicted_parts)
    naive_predictions = np.concatenate(naive_prediction_parts)
    scale_errors = np.concatenate([part for part in scale_error_parts if len(part)]) if any(len(part) for part in scale_error_parts) else None
    metrics = _score(actual_all, predicted_all, scale_errors, naive_predictions)
    scale = max(float(np.mean(np.abs(actual_all))), 1e-9)
    wape_component = (metrics["wape"] or 0.0) / 100.0 if metrics["wape"] is not None else metrics["smape"] / 100.0
    baseline_ratio = metrics["mae_vs_naive_ratio"]
    baseline_penalty = min(float(baseline_ratio), 2.0) if baseline_ratio is not None else 2.0
    composite = (
        0.35 * min(metrics["smape"] / 100.0, 2.0)
        + 0.25 * min(wape_component, 2.0)
        + 0.20 * min(metrics["mae"] / scale, 2.0)
        + 0.10 * min(metrics["rmse"] / scale, 2.0)
        + 0.10 * baseline_penalty
    )
    return {
        "spec": spec,
        "actual": actual_all,
        "predicted": predicted_all,
        "naive_predictions": naive_predictions,
        "residuals": np.abs(actual_all - predicted_all),
        "horizon_steps": np.asarray(horizon_steps, dtype=int),
        "composite_score": float(composite),
        "fold_count": used_origins,
        **metrics,
    }

def _evaluate_candidate_multi(
    spec: CandidateSpec,
    values: np.ndarray,
    horizons: list[int],
    minimum_train: int,
    lower: float | None,
    upper: float | None,
    primary_horizon: int,
    mase_lag: int | None,
) -> dict[str, Any] | None:
    evaluations: list[dict[str, Any]] = []
    for horizon in sorted(set(max(1, int(h)) for h in horizons)):
        origins = _rolling_origins(len(values), horizon, max(minimum_train, horizon * 2), max_folds=8)
        result = _evaluate_candidate(spec, values, origins, horizon, lower, upper, mase_lag)
        if result is not None:
            result["validation_horizon"] = horizon
            evaluations.append(result)
    if not evaluations:
        return None
    if len(evaluations) == 1:
        weights = [1.0]
    else:
        secondary_weight = 0.40 / max(1, len(evaluations) - 1)
        weights = [0.60 if item["validation_horizon"] == primary_horizon else secondary_weight for item in evaluations]
        total_weight = sum(weights)
        weights = [weight / total_weight for weight in weights]
    composite_score = float(sum(weight * item["composite_score"] for weight, item in zip(weights, evaluations, strict=True)))
    actual = np.concatenate([item["actual"] for item in evaluations])
    predicted = np.concatenate([item["predicted"] for item in evaluations])
    naive_predictions = np.concatenate([item["naive_predictions"] for item in evaluations])
    residuals = np.concatenate([item["residuals"] for item in evaluations])
    horizon_steps = np.concatenate([item["horizon_steps"] for item in evaluations])
    aggregate = _score(actual, predicted, _mase_scale_errors(values, mase_lag), naive_predictions)
    primary = min(evaluations, key=lambda item: abs(item["validation_horizon"] - primary_horizon))
    return {
        "spec": spec,
        "actual": actual,
        "predicted": predicted,
        "residuals": residuals,
        "horizon_steps": horizon_steps,
        "composite_score": composite_score,
        "per_horizon": [
            {
                "horizon": item["validation_horizon"],
                "weight": weights[index],
                "folds": item["fold_count"],
                "mae": item["mae"],
                "rmse": item["rmse"],
                "smape": item["smape"],
                "wape": item["wape"],
                "mase": item["mase"],
                "mae_vs_naive_ratio": item["mae_vs_naive_ratio"],
                "composite_score": item["composite_score"],
            }
            for index, item in enumerate(evaluations)
        ],
        "primary_residuals": primary["residuals"],
        "primary_horizon_steps": primary["horizon_steps"],
        **aggregate,
    }

def _walk_forward_test(
    spec: CandidateSpec,
    development_values: np.ndarray,
    test_values: np.ndarray,
    horizon: int,
    lower: float | None,
    upper: float | None,
    baseline_spec: CandidateSpec | None = None,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    history = [float(v) for v in development_values]
    predictions: list[float] = []
    naive_predictions: list[float] = []
    steps: list[int] = []
    cursor = 0
    reference = baseline_spec or CandidateSpec("naive_last_value", "Naive last value", {}, 0)
    while cursor < len(test_values):
        chunk_size = min(horizon, len(test_values) - cursor)
        history_array = np.asarray(history, dtype=float)
        chunk_prediction = _clip(_predict(spec, history_array, chunk_size), lower, upper)
        chunk_baseline = _clip(_predict(reference, history_array, chunk_size), lower, upper)
        predictions.extend(float(v) for v in chunk_prediction)
        naive_predictions.extend(float(v) for v in chunk_baseline)
        steps.extend(range(1, chunk_size + 1))
        actual_chunk = test_values[cursor : cursor + chunk_size]
        history.extend(float(v) for v in actual_chunk)
        cursor += chunk_size
    return (
        np.asarray(predictions, dtype=float),
        np.asarray(naive_predictions, dtype=float),
        np.asarray(steps, dtype=int),
    )

def _conformal_quantile(residuals: np.ndarray, coverage: float = 0.90) -> float:
    residuals = np.asarray(residuals, dtype=float)
    residuals = residuals[np.isfinite(residuals)]
    if len(residuals) == 0:
        return 0.0
    quantile_level = min(1.0, math.ceil((len(residuals) + 1) * coverage) / len(residuals))
    return float(np.quantile(residuals, quantile_level, method="higher"))


def _interval_widths(residuals: np.ndarray, steps: np.ndarray, periods: int, coverage: float = 0.90) -> np.ndarray:
    fallback = _conformal_quantile(residuals, coverage)
    widths = []
    for step in range(1, periods + 1):
        step_residuals = residuals[steps == step]
        width = _conformal_quantile(step_residuals, coverage) if len(step_residuals) >= 4 else fallback
        widths.append(width)
    return np.asarray(widths, dtype=float)


def _metric_value(metrics: dict[str, float | None], key: str, default: float) -> float:
    value = metrics.get(key)
    return default if value is None or not math.isfinite(float(value)) else float(value)


def _quality_score(
    metrics: dict[str, float | None],
    interval_coverage: float | None,
    train_rows: int,
    test_rows: int,
    has_date: bool,
) -> tuple[float, str]:
    """Heuristic historical validation quality; never a probability."""
    smape = _metric_value(metrics, "smape", 200.0)
    wape = _metric_value(metrics, "wape", smape)
    relative_mae = _metric_value(metrics, "relative_mae", 2.0)
    baseline_ratio = metrics.get("mae_vs_naive_ratio")
    r2 = metrics.get("r2")

    smape_component = max(0.0, 1.0 - min(smape, 100.0) / 100.0)
    wape_component = max(0.0, 1.0 - min(wape, 100.0) / 100.0)
    mae_component = max(0.0, 1.0 - min(relative_mae, 1.0))
    skill_component = 0.0
    if baseline_ratio is not None and math.isfinite(float(baseline_ratio)):
        skill_component = max(0.0, min(1.0, 1.0 - float(baseline_ratio)))
    r2_component = max(0.0, min(float(r2), 1.0)) if r2 is not None and math.isfinite(float(r2)) else 0.0

    coverage_component = 0.0
    if interval_coverage is not None and math.isfinite(float(interval_coverage)) and test_rows >= 8:
        coverage_component = max(0.0, 1.0 - abs(float(interval_coverage) - 0.90) / 0.40)

    score = (
        0.24 * smape_component
        + 0.18 * wape_component
        + 0.20 * mae_component
        + 0.18 * skill_component
        + 0.12 * r2_component
        + 0.08 * coverage_component
    )
    history_depth = min(1.0, train_rows / 60.0)
    test_depth = min(1.0, test_rows / 20.0)
    score *= 0.45 + 0.35 * history_depth + 0.20 * test_depth
    if not has_date:
        score *= 0.50
    if r2 is not None and float(r2) <= 0:
        score = min(score, 0.45)
    if smape >= 50 or wape >= 50:
        score = min(score, 0.35)
    if baseline_ratio is not None and float(baseline_ratio) >= 1:
        score = min(score, 0.40)
    score = float(max(0.0, min(score, 0.95)))
    if score >= 0.75:
        grade = "high"
    elif score >= 0.55:
        grade = "medium"
    elif score >= 0.35:
        grade = "low"
    else:
        grade = "very_low"
    return score, grade

def _regime_shift_score(values: np.ndarray, seasonal_lag: int | None = None) -> float:
    """Robust recent level/seasonal-pattern shift diagnostic.

    The maximum of the raw-level score and seasonally differenced score is used.
    Using only seasonal differences can hide a persistent step change once the
    shifted level has lasted longer than one seasonal cycle.
    """
    values = np.asarray(values, dtype=float)

    def score(series: np.ndarray) -> float:
        if len(series) < 12:
            return 0.0
        window = max(4, min(len(series) // 4, 30))
        recent = series[-window:]
        previous = series[-2 * window:-window]
        if len(previous) < 4:
            return 0.0
        center_delta = abs(float(np.median(recent) - np.median(previous)))
        mad = float(np.median(np.abs(previous - np.median(previous))))
        scale = max(1.4826 * mad, float(np.std(previous)), abs(float(np.mean(previous))) * 0.05, 1e-9)
        return center_delta / scale

    scores = [score(values)]
    if seasonal_lag and len(values) >= seasonal_lag * 3:
        scores.append(score(values[seasonal_lag:] - values[:-seasonal_lag]))
    return float(max(scores))


def _regularize_additive_series(
    series: pd.DataFrame,
    aggregation: str,
    frequency: str | None,
    warnings: list[str],
    transaction_like: bool,
) -> pd.DataFrame:
    """Fill absent periods only when zero is defensible from transaction rows.

    A single already-aggregated observation per date does not prove that a
    missing date means zero. In that case the gap is left untouched and the
    forecast is flagged as irregular instead of silently fabricating zeros.
    """
    if aggregation != "sum" or frequency not in {"D", "B", "7D"} or len(series) < 2:
        return series
    full_index = pd.date_range(series["date"].min(), series["date"].max(), freq=frequency)
    missing_count = len(full_index) - len(series)
    if missing_count <= 0:
        return series
    missing_ratio = missing_count / max(len(full_index), 1)
    if not transaction_like:
        warnings.append(
            f"{missing_count} missing periods were preserved because the input appears already aggregated; missing does not necessarily mean zero."
        )
        return series
    if missing_ratio > 0.25:
        warnings.append(
            f"{missing_count} missing periods were not filled because the gap ratio ({missing_ratio:.1%}) is too high; data completeness must be checked."
        )
        return series
    regularized = series.set_index("date").reindex(full_index)
    regularized.index.name = "date"
    regularized["target"] = regularized["target"].fillna(0.0)
    warnings.append(
        f"{missing_count} absent transaction periods were inserted as 0 to create a regular {frequency} series."
    )
    return regularized.reset_index()

def build_regression_forecast_v7(
    frame: pd.DataFrame,
    target_column: str | None,
    date_columns: list[str],
    periods: int,
    envelope_factory: Callable[..., Any],
    target_aggregation: Callable[[str], tuple[str, str | None]],
) -> tuple[Any | None, list[str]]:
    warnings: list[str] = []
    if target_column is None:
        return None, ["Forecast was skipped because no unambiguous numeric target was available; choose target_column explicitly."]

    target_values = coerce_numeric_series(frame[target_column])
    target_missing_rows = int(target_values.isna().sum())
    if target_missing_rows:
        warnings.append(f"{target_missing_rows} rows with missing or invalid target values were excluded.")

    if not date_columns:
        return None, warnings + [
            "Forecast was skipped because no usable date column exists; row order is not a defensible time axis."
        ]

    date_column: str | None = None
    invalid_date_rows = 0
    aggregation = "unknown"
    frequency: str | None = None
    frequency_method = "unknown"
    cadence_days = 1.0
    future_dates: list[pd.Timestamp] = []
    transaction_like = False

    if date_columns:
        parsed_candidates = [
            (column, pd.to_datetime(frame[column], errors="coerce", dayfirst=True, format="mixed"))
            for column in date_columns
        ]
        date_column, parsed_dates = max(parsed_candidates, key=lambda item: int(item[1].notna().sum()))
        invalid_date_rows = int(frame[date_column].notna().sum() - parsed_dates.notna().sum())
        if invalid_date_rows:
            warnings.append(f"{invalid_date_rows} rows with invalid dates were excluded.")
        valid_dates = parsed_dates.dropna()
        if len(valid_dates) and float((valid_dates.dt.normalize() != valid_dates).mean()) > 0.05:
            return None, warnings + [
                "Forecast was skipped because sub-daily timestamps are present; hourly data must be aggregated explicitly before forecasting."
            ]
        work = pd.DataFrame({"date": parsed_dates.dt.normalize(), "target": target_values}).dropna()
        duplicate_date_rows = int(len(work) - work["date"].nunique())
        transaction_like = duplicate_date_rows > 0
        aggregation, aggregation_warning = target_aggregation(target_column)
        if aggregation_warning:
            warnings.append(aggregation_warning)
        if aggregation == "sum":
            series = work.groupby("date", as_index=False, sort=True)["target"].sum()
        else:
            series = work.groupby("date", as_index=False, sort=True)["target"].mean()
        series = series.sort_values("date").reset_index(drop=True)
        frequency, cadence_days, frequency_method = _infer_frequency(series["date"])
        series = _regularize_additive_series(series, aggregation, frequency, warnings, transaction_like)
        if frequency is not None and len(series) >= 3:
            try:
                remaining_frequency = pd.infer_freq(pd.DatetimeIndex(series["date"]))
            except ValueError:
                remaining_frequency = None
            if remaining_frequency is None:
                frequency = None
                frequency_method = f"{frequency_method}_irregular_gaps_preserved"
        if frequency is None:
            return None, warnings + [
                "Forecast was skipped because dated observations do not form a defensible regular daily, business-day, weekly, monthly or quarterly series."
            ]
        future_dates = _future_dates(series["date"], periods, frequency, cadence_days)

    observation_count = len(series)
    if observation_count < 3:
        warnings.append("Forecast was skipped because fewer than 3 valid chronological observations remained.")
        return None, warnings

    values = series["target"].to_numpy(dtype=float)
    lower_bound, upper_bound = _infer_bounds(values, target_column)
    is_constant = bool(np.ptp(values) <= max(1e-12, abs(float(np.mean(values))) * 1e-12))

    minimum_validated_rows = max(12, periods * 4)
    if observation_count < minimum_validated_rows:
        fallback_spec = CandidateSpec(
            "naive_last_value" if is_constant else "damped_drift",
            "Naive last value" if is_constant else "Damped robust drift",
            {"phi": 0.90} if not is_constant else {},
            0,
        )
        future_prediction = _clip(_predict(fallback_spec, values, periods), lower_bound, upper_bound)
        forecast_data = []
        for index, prediction in enumerate(future_prediction):
            point: dict[str, Any] = {"row": f"T+{index + 1}", "predicted": round(float(prediction), 4)}
            if future_dates:
                point["date"] = future_dates[index].date().isoformat()
            forecast_data.append(point)
        warnings.append(
            f"At least {minimum_validated_rows} observations are required for nested validation; this forecast is unvalidated and quality is 0."
        )
        if is_constant:
            warnings.append("The target is constant; the fallback preserves the last value but predictive skill cannot be validated on this short series.")
        metrics = {
            "mae": None, "rmse": None, "r2": None, "smape": None, "wape": None, "mase": None,
            "mae_vs_naive_ratio": None, "relative_mae": None,
            "train_rows": observation_count, "test_rows": 0,
            "validation_method": "insufficient_data_no_holdout",
            "validation": {"method": "insufficient_data_no_holdout", "required_rows": minimum_validated_rows, "development_rows": observation_count, "test_rows": 0},
            "selection_metric": None, "selected_model": fallback_spec.name,
            "selected_model_parameters": fallback_spec.parameters, "candidate_metrics": [],
            "quality_score": 0.0, "quality_grade": "very_low",
            "decision_support": _decision_support_level("very_low"),
            "confidence_semantics": "historical_validation_quality_not_probability",
            "confidence_is_probability": False, "date_column": date_column,
            "aggregation": aggregation, "forecast_frequency": frequency,
            "frequency_detection_method": frequency_method, "interval_method": None,
            "interval_target_coverage": None, "interval_test_coverage": None,
            "interval_residual_count": 0, "domain_lower_bound": lower_bound,
            "domain_upper_bound": upper_bound, "target_missing_rows": target_missing_rows,
            "invalid_date_rows": invalid_date_rows, "transaction_like_input": transaction_like,
            "zero_fraction": round(float(np.mean(np.abs(values) <= 1e-12)), 4),
            "data_warnings": warnings, "engine_version": "forecasting_v7.1",
        }
        return envelope_factory(
            type="forecast", confidence=0.0,
            model=f"{fallback_spec.label} (unvalidated small-series fallback)",
            metrics=metrics, data=forecast_data,
        ), warnings

    test_rows = _final_test_rows(observation_count, periods)
    development_rows = observation_count - test_rows
    if development_rows < max(8, periods * 2):
        test_rows = max(2, observation_count - max(8, periods * 2))
        development_rows = observation_count - test_rows
    development_values = values[:development_rows]
    test_values = values[development_rows:]

    seasonal = _seasonal_spec(frequency, cadence_days, development_rows) if date_column else None
    specs = _candidate_specs(seasonal, development_values)
    cv_horizon = max(1, min(periods, max(1, development_rows // 4)))
    validation_horizons = _validation_horizons(frequency, cv_horizon, development_rows)
    minimum_train = max(5, cv_horizon * 2)
    if seasonal is not None:
        minimum_train = max(minimum_train, min(seasonal[0] * 2, max(8, development_rows // 2)))

    evaluations: list[dict[str, Any]] = []
    for spec in specs:
        evaluated = _evaluate_candidate_multi(
            spec, development_values, validation_horizons, minimum_train, lower_bound, upper_bound, cv_horizon,
            seasonal[0] if seasonal else 1,
        )
        if evaluated is not None:
            evaluations.append(evaluated)
    if not evaluations:
        # Keep the API useful for tiny demo datasets, but make the lack of
        # validation explicit and never claim quality/confidence.
        fallback_spec = CandidateSpec(
            "naive_last_value" if is_constant else "linear_trend",
            "Naive last value" if is_constant else "Linear trend",
            {},
            0,
        )
        future_prediction = _clip(_predict(fallback_spec, values, periods), lower_bound, upper_bound)
        forecast_data = []
        for index, prediction in enumerate(future_prediction):
            point: dict[str, Any] = {"row": f"T+{index + 1}", "predicted": round(float(prediction), 4)}
            if future_dates:
                point["date"] = future_dates[index].date().isoformat()
            forecast_data.append(point)
        warnings.append(
            "The series is too short for nested rolling-origin validation; forecast quality is unvalidated and set to 0."
        )
        metrics = {
            "mae": None, "rmse": None, "r2": None, "smape": None, "wape": None, "mase": None,
            "mae_vs_naive_ratio": None, "relative_mae": None, "train_rows": observation_count, "test_rows": 0,
            "validation_method": "insufficient_data_no_holdout",
            "validation": {"method": "insufficient_data_no_holdout", "development_rows": observation_count, "test_rows": 0},
            "selection_metric": None, "selected_model": fallback_spec.name,
            "selected_model_parameters": {}, "candidate_metrics": [],
            "quality_score": 0.0, "quality_grade": "very_low",
            "decision_support": _decision_support_level("very_low"),
            "confidence_semantics": "historical_validation_quality_not_probability",
            "confidence_is_probability": False, "date_column": date_column,
            "aggregation": aggregation, "forecast_frequency": frequency,
            "frequency_detection_method": frequency_method, "interval_method": None,
            "interval_target_coverage": None, "interval_test_coverage": None,
            "interval_residual_count": 0, "domain_lower_bound": lower_bound,
            "domain_upper_bound": upper_bound, "target_missing_rows": target_missing_rows,
            "invalid_date_rows": invalid_date_rows, "data_warnings": warnings, "engine_version": "forecasting_v7.1",
        }
        return envelope_factory(
            type="forecast", confidence=0.0,
            model=f"{fallback_spec.label} (unvalidated small-series fallback)",
            metrics=metrics, data=forecast_data,
        ), warnings

    winner = min(evaluations, key=lambda item: (item["composite_score"], item["spec"].priority, item["spec"].name))
    selected_spec: CandidateSpec = winner["spec"]
    reference_candidates = [
        item for item in evaluations if item["spec"].name in {"naive_last_value", "seasonal_naive"}
    ]
    reference_winner = min(
        reference_candidates,
        key=lambda item: (item["composite_score"], item["spec"].priority, item["spec"].name),
    ) if reference_candidates else None
    reference_spec = reference_winner["spec"] if reference_winner else CandidateSpec(
        "naive_last_value", "Naive last value", {}, 0
    )

    test_prediction, test_naive_predictions, test_steps = _walk_forward_test(
        selected_spec,
        development_values,
        test_values,
        max(1, periods),
        lower_bound,
        upper_bound,
        reference_spec,
    )
    test_metrics = _score(test_values, test_prediction, _mase_scale_errors(development_values, seasonal[0] if seasonal else 1), test_naive_predictions)

    cv_widths_for_test = _interval_widths(
        winner["primary_residuals"], winner["primary_horizon_steps"], max(1, periods), coverage=0.90
    )
    test_interval_lower = np.empty(len(test_values), dtype=float)
    test_interval_upper = np.empty(len(test_values), dtype=float)
    for index, (prediction, step) in enumerate(zip(test_prediction, test_steps, strict=True)):
        width = cv_widths_for_test[min(step, len(cv_widths_for_test)) - 1]
        test_interval_lower[index] = prediction - width
        test_interval_upper[index] = prediction + width
    if lower_bound is not None:
        test_interval_lower = np.maximum(test_interval_lower, lower_bound)
    if upper_bound is not None:
        test_interval_upper = np.minimum(test_interval_upper, upper_bound)
    interval_coverage = float(np.mean((test_values >= test_interval_lower) & (test_values <= test_interval_upper)))

    combined_residuals = np.concatenate([winner["primary_residuals"], np.abs(test_values - test_prediction)])
    combined_steps = np.concatenate([winner["primary_horizon_steps"], test_steps])
    future_widths = _interval_widths(combined_residuals, combined_steps, periods, coverage=0.90)

    quality, quality_grade = _quality_score(test_metrics, interval_coverage, development_rows, test_rows, True)
    if is_constant:
        quality = min(0.40, 0.25 + 0.15 * min(1.0, development_rows / 60.0))
        quality_grade = "low" if quality >= 0.35 else "very_low"
        warnings.append(
            "The target is constant; stability is observable, but superiority over a reference baseline cannot be established."
        )
    regime_shift = _regime_shift_score(values, seasonal[0] if seasonal else None)
    if regime_shift >= 3.0:
        quality = min(quality * 0.70, 0.45)
        quality_grade = "low" if quality >= 0.35 else "very_low"
        warnings.append(
            f"A recent level/regime shift was detected (robust score {regime_shift:.2f}); historical validation may not represent the next periods."
        )
    if test_metrics["r2"] is not None and test_metrics["r2"] <= 0:
        warnings.append("Out-of-sample R² is not positive; the forecast should be treated as a rough baseline, not a reliable operational prediction.")
    if test_metrics["smape"] >= 30:
        warnings.append(f"Out-of-sample SMAPE is high ({test_metrics['smape']:.1f}%); avoid using the point estimate alone for stock or staffing decisions.")
    if test_metrics["mae_vs_naive_ratio"] is not None and test_metrics["mae_vs_naive_ratio"] >= 1:
        warnings.append(
            f"The selected model did not outperform the reference baseline ({reference_spec.label}) on the final walk-forward test."
        )
    if len(combined_residuals) < 20:
        warnings.append("Prediction intervals are based on fewer than 20 residuals and may be unstable.")

    future_prediction = _clip(_predict(selected_spec, values, periods), lower_bound, upper_bound)
    forecast_data: list[dict[str, Any]] = []
    for index, prediction in enumerate(future_prediction):
        lower = float(prediction - future_widths[index])
        upper = float(prediction + future_widths[index])
        if lower_bound is not None:
            lower = max(lower_bound, lower)
        if upper_bound is not None:
            upper = min(upper_bound, upper)
        point: dict[str, Any] = {
            "row": f"T+{index + 1}",
            "predicted": round(float(prediction), 4),
            "lower": round(lower, 4),
            "upper": round(upper, 4),
        }
        if future_dates:
            point["date"] = future_dates[index].date().isoformat()
        forecast_data.append(point)

    ranked = sorted(evaluations, key=lambda item: (item["composite_score"], item["spec"].priority, item["spec"].name))
    candidate_metrics = []
    for rank, item in enumerate(ranked, start=1):
        candidate_metrics.append({
            "model": item["spec"].name,
            "label": item["spec"].label,
            "parameters": item["spec"].parameters,
            "mae": round(float(item["mae"]), 4),
            "rmse": round(float(item["rmse"]), 4),
            "r2": round(float(item["r2"]), 4) if item["r2"] is not None else None,
            "smape": round(float(item["smape"]), 4),
            "wape": round(float(item["wape"]), 4) if item["wape"] is not None else None,
            "mase": round(float(item["mase"]), 4) if item["mase"] is not None else None,
            "mae_vs_naive_ratio": round(float(item["mae_vs_naive_ratio"]), 4) if item["mae_vs_naive_ratio"] is not None else None,
            "composite_score": round(float(item["composite_score"]), 6),
            "rank": rank,
            "selected": item["spec"].name == selected_spec.name,
            "validation_scope": "development_multi_horizon_rolling_origin",
            "per_horizon": [
                {**entry, **{key: round(float(value), 4) for key, value in entry.items() if key not in {"horizon", "folds"} and value is not None}}
                for entry in item["per_horizon"]
            ],
        })

    metrics: dict[str, Any] = {
        "mae": round(float(test_metrics["mae"]), 4),
        "rmse": round(float(test_metrics["rmse"]), 4),
        "r2": round(float(test_metrics["r2"]), 4) if test_metrics["r2"] is not None else None,
        "smape": round(float(test_metrics["smape"]), 4),
        "wape": round(float(test_metrics["wape"]), 4) if test_metrics["wape"] is not None else None,
        "mase": round(float(test_metrics["mase"]), 4) if test_metrics["mase"] is not None else None,
        "mase_scale_lag": int(seasonal[0] if seasonal else 1),
        "mae_vs_naive_ratio": round(float(test_metrics["mae_vs_naive_ratio"]), 4) if test_metrics["mae_vs_naive_ratio"] is not None else None,
        "relative_mae": round(float(test_metrics["relative_mae"]), 4),
        "train_rows": development_rows,
        "test_rows": test_rows,
        "validation_method": "nested_time_series_validation",
        "validation": {
            "method": "nested_time_series_validation",
            "selection_strategy": "requested-horizon-weighted rolling-origin cross-validation on development rows",
            "final_test_strategy": f"walk-forward test in chunks of {max(1, periods)} period(s)",
            "cv_folds": sum(item["folds"] for item in winner["per_horizon"]),
            "cv_horizon": cv_horizon,
            "validation_horizons": validation_horizons,
            "development_rows": development_rows,
            "test_rows": test_rows,
        },
        "selection_metric": "requested_horizon_weighted_composite_smape_wape_mae_rmse_reference_skill",
        "reference_baseline_model": reference_spec.name,
        "selected_model": selected_spec.name,
        "selected_model_parameters": selected_spec.parameters,
        "candidate_metrics": candidate_metrics,
        "quality_score": round(quality, 4),
        "quality_grade": quality_grade,
        "decision_support": _decision_support_level(quality_grade),
        "confidence_semantics": "historical_validation_quality_not_probability",
        "confidence_is_probability": False,
        "date_column": date_column,
        "aggregation": aggregation,
        "forecast_frequency": frequency,
        "frequency_detection_method": frequency_method,
        "interval_method": "rolling_origin_conformal_absolute_residuals_90pct",
        "interval_target_coverage": 0.90,
        "interval_test_coverage": round(interval_coverage, 4),
        "interval_residual_count": int(len(combined_residuals)),
        "domain_lower_bound": lower_bound,
        "domain_upper_bound": upper_bound,
        "target_missing_rows": target_missing_rows,
        "invalid_date_rows": invalid_date_rows,
        "transaction_like_input": transaction_like,
        "zero_fraction": round(float(np.mean(np.abs(values) <= 1e-12)), 4),
        "regime_shift_score": round(float(regime_shift), 4),
        "data_warnings": warnings,
        "engine_version": "forecasting_v7.1",
    }

    time_basis = f"{aggregation} aggregation on {date_column}"
    model_label = (
        f"{selected_spec.label} selected with rolling-origin CV; evaluated on an untouched walk-forward test "
        f"({time_basis})"
    )
    return envelope_factory(
        type="forecast",
        confidence=round(quality, 4),
        model=model_label,
        metrics=metrics,
        data=forecast_data,
    ), warnings


def predict_history_v7(history: list[dict[str, Any]], periods: int) -> dict[str, Any]:
    """Production-oriented replacement for /predict while keeping its compact response shape.

    Metrics are out-of-sample walk-forward metrics, not training-fit metrics.
    """
    frame = pd.DataFrame(history)
    if "date" not in frame or "value" not in frame:
        raise ValueError("history must contain date and value fields")
    frame["date"] = pd.to_datetime(frame["date"], errors="coerce", dayfirst=True, format="mixed")
    frame["value"] = coerce_numeric_series(frame["value"])
    if frame[["date", "value"]].isna().any(axis=None):
        raise ValueError("history contains invalid date or value entries")
    if frame["date"].duplicated().any():
        raise ValueError("history contains duplicate dates; aggregate them explicitly before forecasting")
    if float((frame["date"].dt.normalize() != frame["date"]).mean()) > 0.05:
        raise ValueError("sub-daily timestamps are not supported; aggregate them explicitly before forecasting")
    frame["date"] = frame["date"].dt.normalize()
    if frame["date"].duplicated().any():
        raise ValueError("history contains multiple observations for the same calendar period; aggregate them explicitly before forecasting")
    frame = frame.sort_values("date").reset_index(drop=True)
    periods = max(1, int(periods))
    frequency, cadence_days, frequency_method = _infer_frequency(frame["date"])
    if frequency is None:
        raise ValueError("history dates are irregular; provide a regular daily, business-day, weekly, monthly or quarterly series")
    expected = pd.date_range(frame["date"].min(), frame["date"].max(), freq=frequency)
    if len(expected) != len(frame) or not np.array_equal(expected.values, pd.DatetimeIndex(frame["date"]).values):
        raise ValueError("history contains missing periods; aggregate and regularize the series explicitly before forecasting")
    minimum_rows = max(12, periods * 4)
    values = frame["value"].to_numpy(dtype=float)
    if len(frame) < minimum_rows:
        lower, upper = _infer_bounds(values, "value")
        is_constant = bool(np.ptp(values) <= max(1e-12, abs(float(np.mean(values))) * 1e-12))
        spec = CandidateSpec(
            "naive_last_value" if is_constant else "damped_drift",
            "Naive last value" if is_constant else "Damped robust drift",
            {} if is_constant else {"phi": 0.90},
            0,
        )
        predicted = _clip(_predict(spec, values, periods), lower, upper)
        dates = _future_dates(frame["date"], periods, frequency, cadence_days)
        return {
            "forecast": [
                {"date": dates[i].date().isoformat(), "value": round(float(value), 2)}
                for i, value in enumerate(predicted)
            ],
            "mae": None,
            "rmse": None,
            "model": f"{spec.name}_unvalidated_small_series",
            "smape": None,
            "wape": None,
            "mase": None,
            "mae_vs_naive_ratio": None,
            "r2": None,
            "validation_method": "insufficient_data_no_holdout",
            "quality_score": 0.0,
            "quality_grade": "very_low",
            "decision_support": _decision_support_level("very_low"),
            "interval_test_coverage": None,
            "confidence_semantics": "historical_validation_quality_not_probability",
            "confidence_is_probability": False,
            "forecast_frequency": frequency,
            "frequency_detection_method": frequency_method,
            "engine_version": "forecasting_v7.1",
            "warnings": [f"At least {minimum_rows} observations are required for validated metrics; forecast is unvalidated."],
        }
    seasonal = _seasonal_spec(frequency, cadence_days, len(values))
    lower, upper = _infer_bounds(values, "value")
    test_rows = _final_test_rows(len(values), periods)
    dev = values[:-test_rows]
    test = values[-test_rows:]
    validation_horizons = _validation_horizons(frequency, max(1, periods), len(dev))
    evaluations = [
        result
        for spec in _candidate_specs(seasonal, dev)
        if (result := _evaluate_candidate_multi(
            spec, dev, validation_horizons, max(5, periods * 2), lower, upper, max(1, periods),
            seasonal[0] if seasonal else 1,
        )) is not None
    ]
    if not evaluations:
        raise ValueError("not enough history for rolling-origin validation")
    winner = min(evaluations, key=lambda item: (item["composite_score"], item["spec"].priority, item["spec"].name))
    spec: CandidateSpec = winner["spec"]
    reference_candidates = [
        item for item in evaluations if item["spec"].name in {"naive_last_value", "seasonal_naive"}
    ]
    reference_winner = min(
        reference_candidates,
        key=lambda item: (item["composite_score"], item["spec"].priority, item["spec"].name),
    ) if reference_candidates else None
    reference_spec = reference_winner["spec"] if reference_winner else CandidateSpec(
        "naive_last_value", "Naive last value", {}, 0
    )
    test_prediction, test_naive_predictions, test_steps = _walk_forward_test(
        spec, dev, test, max(1, periods), lower, upper, reference_spec
    )
    metrics = _score(test, test_prediction, _mase_scale_errors(dev, seasonal[0] if seasonal else 1), test_naive_predictions)
    cv_widths = _interval_widths(
        winner["primary_residuals"], winner["primary_horizon_steps"], max(1, periods), coverage=0.90
    )
    test_lower = np.asarray([
        prediction - cv_widths[min(int(step), len(cv_widths)) - 1]
        for prediction, step in zip(test_prediction, test_steps, strict=True)
    ])
    test_upper = np.asarray([
        prediction + cv_widths[min(int(step), len(cv_widths)) - 1]
        for prediction, step in zip(test_prediction, test_steps, strict=True)
    ])
    if lower is not None:
        test_lower = np.maximum(test_lower, lower)
    if upper is not None:
        test_upper = np.minimum(test_upper, upper)
    interval_coverage = float(np.mean((test >= test_lower) & (test <= test_upper)))
    quality, quality_grade = _quality_score(metrics, interval_coverage, len(dev), len(test), True)
    warnings: list[str] = []
    is_constant = bool(np.ptp(values) <= max(1e-12, abs(float(np.mean(values))) * 1e-12))
    if is_constant:
        quality = min(0.40, 0.25 + 0.15 * min(1.0, len(dev) / 60.0))
        quality_grade = "low" if quality >= 0.35 else "very_low"
        warnings.append("The target is constant; quality reflects stability, not superiority over a baseline.")
    regime_shift = _regime_shift_score(values, seasonal[0] if seasonal else None)
    if regime_shift >= 3.0:
        quality = min(quality * 0.70, 0.45)
        quality_grade = "low" if quality >= 0.35 else "very_low"
        warnings.append(
            f"A recent level/regime shift was detected (robust score {regime_shift:.2f}); historical validation may not represent the next periods."
        )
    if metrics["r2"] is not None and metrics["r2"] <= 0:
        warnings.append("Out-of-sample R² is not positive; treat this as a rough baseline.")
    if metrics["smape"] >= 30:
        warnings.append(f"Out-of-sample SMAPE is high ({metrics['smape']:.1f}%).")
    if metrics["mae_vs_naive_ratio"] is not None and metrics["mae_vs_naive_ratio"] >= 1:
        warnings.append(f"The selected model did not beat the reference baseline ({reference_spec.label}) on the final test.")

    residuals = np.concatenate([winner["primary_residuals"], np.abs(test - test_prediction)])
    steps = np.concatenate([winner["primary_horizon_steps"], test_steps])
    widths = _interval_widths(residuals, steps, periods, coverage=0.90)
    predicted = _clip(_predict(spec, values, periods), lower, upper)
    dates = _future_dates(frame["date"], periods, frequency, cadence_days)
    forecast = []
    for i, value in enumerate(predicted):
        low = value - widths[i]
        high = value + widths[i]
        if lower is not None:
            low = max(lower, low)
        if upper is not None:
            high = min(upper, high)
        forecast.append({
            "date": dates[i].date().isoformat(),
            "value": round(float(value), 2),
            "lower": round(float(low), 2),
            "upper": round(float(high), 2),
        })
    return {
        "forecast": forecast,
        "mae": round(float(metrics["mae"]), 4),
        "rmse": round(float(metrics["rmse"]), 4),
        "model": spec.name,
        "smape": round(float(metrics["smape"]), 4),
        "wape": round(float(metrics["wape"]), 4) if metrics["wape"] is not None else None,
        "mase": round(float(metrics["mase"]), 4) if metrics["mase"] is not None else None,
        "mase_scale_lag": int(seasonal[0] if seasonal else 1),
        "mae_vs_naive_ratio": round(float(metrics["mae_vs_naive_ratio"]), 4) if metrics["mae_vs_naive_ratio"] is not None else None,
        "r2": round(float(metrics["r2"]), 4) if metrics["r2"] is not None else None,
        "validation_method": "nested_time_series_validation",
        "reference_baseline_model": reference_spec.name,
        "quality_score": round(quality, 4),
        "quality_grade": quality_grade,
        "decision_support": _decision_support_level(quality_grade),
        "interval_test_coverage": round(interval_coverage, 4),
        "forecast_frequency": frequency,
        "frequency_detection_method": frequency_method,
        "regime_shift_score": round(float(regime_shift), 4),
        "engine_version": "forecasting_v7.1",
        "confidence_semantics": "historical_validation_quality_not_probability",
        "confidence_is_probability": False,
        "warnings": warnings,
    }
