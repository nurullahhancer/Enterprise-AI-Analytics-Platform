from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from app.forecasting_v7 import (
    _quality_score,
    build_regression_forecast_v7,
    predict_history_v7,
)


def envelope(**kwargs):
    return kwargs


def additive(_column: str):
    return "sum", None


def average(_column: str):
    return "mean", None


def test_linear_series_uses_nested_validation_and_non_probability_quality() -> None:
    rows = pd.DataFrame({
        "date": pd.date_range("2025-01-01", periods=120, freq="D"),
        "revenue": np.arange(120, dtype=float) * 10 + 1_000,
    })
    result, warnings = build_regression_forecast_v7(rows, "revenue", ["date"], 3, envelope, additive)
    assert result is not None
    assert result["metrics"]["validation_method"] == "nested_time_series_validation"
    assert result["metrics"]["confidence_is_probability"] is False
    assert result["metrics"]["selected_model"] in {"linear_trend", "linear_recent", "huber_trend", "huber_recent", "damped_drift"}
    assert result["metrics"]["mae"] < 1e-6
    assert result["metrics"]["wape"] < 1e-6
    assert warnings == []


def test_zero_error_quality_is_not_treated_as_missing() -> None:
    metrics = {
        "smape": 0.0,
        "wape": 0.0,
        "relative_mae": 0.0,
        "mae_vs_naive_ratio": 0.0,
        "r2": 1.0,
    }
    score, grade = _quality_score(metrics, 0.90, train_rows=100, test_rows=30, has_date=True)
    assert score >= 0.75
    assert grade == "high"


def test_negative_revenue_forecasts_are_clipped() -> None:
    rows = pd.DataFrame({
        "date": pd.date_range("2025-01-01", periods=100, freq="D"),
        "Brüt_Ciro_TL": np.maximum(0, 1_000 - np.arange(100) * 20),
    })
    result, _ = build_regression_forecast_v7(rows, "Brüt_Ciro_TL", ["date"], 12, envelope, additive)
    assert result is not None
    assert all(point["predicted"] >= 0 for point in result["data"])
    assert all(point["lower"] >= 0 for point in result["data"])


def test_exact_monthly_seasonality_is_selected() -> None:
    seasonal = [20, 45, 30, 80, 55, 100, 70, 120, 65, 95, 40, 25]
    rows = pd.DataFrame({
        "date": pd.date_range("2021-01-01", periods=60, freq="MS"),
        "revenue": seasonal * 5,
    })
    result, _ = build_regression_forecast_v7(rows, "revenue", ["date"], 4, envelope, additive)
    assert result is not None
    assert result["metrics"]["selected_model"] in {"seasonal_naive", "seasonal_mean"}
    assert [point["predicted"] for point in result["data"]] == seasonal[:4]


def test_small_series_is_explicitly_unvalidated() -> None:
    rows = pd.DataFrame({
        "date": pd.date_range("2026-01-01", periods=8, freq="MS"),
        "revenue": [100, 110, 120, 130, 140, 150, 160, 170],
    })
    result, warnings = build_regression_forecast_v7(rows, "revenue", ["date"], 3, envelope, additive)
    assert result is not None
    assert result["confidence"] == 0
    assert result["metrics"]["validation_method"] == "insufficient_data_no_holdout"
    assert all("lower" not in point for point in result["data"])
    assert any("unvalidated" in warning.lower() for warning in warnings)


def test_predict_marks_short_history_unvalidated_and_rejects_duplicates() -> None:
    short = [{"date": f"2025-{m:02d}-01", "value": float(m)} for m in range(1, 8)]
    short_result = predict_history_v7(short, 2)
    assert short_result["mae"] is None
    assert short_result["rmse"] is None
    assert short_result["quality_score"] == 0
    assert short_result["validation_method"] == "insufficient_data_no_holdout"

    duplicate = [{"date": f"2025-{m:02d}-01", "value": float(m)} for m in range(1, 13)]
    duplicate[-1]["date"] = duplicate[-2]["date"]
    with pytest.raises(ValueError, match="duplicate dates"):
        predict_history_v7(duplicate, 2)


def test_predict_frequency_and_period_count() -> None:
    history = [
        {"date": f"{year}-{month:02d}-01", "value": 100 + (year - 2023) * 20 + month * 10}
        for year in (2023, 2024, 2025)
        for month in range(1, 13)
    ]
    result = predict_history_v7(history, 3)
    assert len(result["forecast"]) == 3
    assert result["forecast"][0]["date"] == "2026-01-01"
    assert result["forecast"][2]["date"] == "2026-03-01"
    assert result["validation_method"] == "nested_time_series_validation"


def test_aggregated_missing_dates_are_not_silently_zero_filled() -> None:
    dates = pd.date_range("2025-01-01", periods=90, freq="D").delete([10, 20, 30])
    rows = pd.DataFrame({"date": dates, "revenue": np.linspace(100, 200, len(dates))})
    result, warnings = build_regression_forecast_v7(rows, "revenue", ["date"], 3, envelope, additive)
    assert result is None
    assert any("preserved" in warning for warning in warnings)
    assert any("regular" in warning for warning in warnings)


def test_transaction_rows_can_fill_absent_daily_periods_as_zero() -> None:
    rows = []
    for date in pd.date_range("2025-01-01", periods=90, freq="D"):
        if date.day in {10, 20}:
            continue
        rows.append({"date": date, "revenue": 100.0})
        rows.append({"date": date, "revenue": 50.0})
    frame = pd.DataFrame(rows)
    result, warnings = build_regression_forecast_v7(frame, "revenue", ["date"], 3, envelope, additive)
    assert result is not None
    assert result["metrics"]["transaction_like_input"] is True
    assert any("inserted as 0" in warning for warning in warnings)


def test_quality_is_capped_when_out_of_sample_skill_is_bad() -> None:
    rng = np.random.default_rng(42)
    rows = pd.DataFrame({
        "date": pd.date_range("2025-01-01", periods=180, freq="D"),
        "revenue": rng.uniform(0, 100_000, size=180),
    })
    result, _ = build_regression_forecast_v7(rows, "revenue", ["date"], 3, envelope, additive)
    assert result is not None
    if (result["metrics"]["r2"] or 0) <= 0:
        assert result["confidence"] <= 0.45


def test_constant_series_is_only_low_quality_stability_signal() -> None:
    rows = pd.DataFrame({
        "date": pd.date_range("2024-01-01", periods=120, freq="D"),
        "revenue": np.full(120, 500.0),
    })
    result, warnings = build_regression_forecast_v7(rows, "revenue", ["date"], 3, envelope, additive)
    assert result is not None
    assert 0.25 <= result["confidence"] <= 0.40
    assert result["metrics"]["quality_grade"] in {"very_low", "low"}
    assert result["metrics"]["decision_support"] == "rough_baseline_do_not_use_alone"
    assert result["metrics"]["r2"] is None
    assert result["metrics"]["confidence_is_probability"] is False
    assert any("stability" in warning.lower() for warning in warnings)


def test_predict_returns_quality_fields_for_validated_history() -> None:
    history = [
        {"date": date.date().isoformat(), "value": float(1_000 + index * 5)}
        for index, date in enumerate(pd.date_range("2025-01-01", periods=120, freq="D"))
    ]
    result = predict_history_v7(history, 3)
    assert result["quality_score"] >= 0
    assert result["quality_grade"] in {"very_low", "low", "medium", "high"}
    assert result["confidence_is_probability"] is False
    assert result["interval_test_coverage"] is not None
    assert isinstance(result["warnings"], list)


def test_monthly_validation_uses_calendar_appropriate_horizons() -> None:
    rows = pd.DataFrame({
        "date": pd.date_range("2018-01-01", periods=84, freq="MS"),
        "revenue": [100 + 10 * (index % 12) + index for index in range(84)],
    })
    result, _ = build_regression_forecast_v7(rows, "revenue", ["date"], 3, envelope, additive)
    assert result is not None
    horizons = result["metrics"]["validation"]["validation_horizons"]
    assert all(horizon in {3, 6, 12} for horizon in horizons)
    assert 14 not in horizons and 28 not in horizons


def test_irregular_daily_gaps_fail_closed_instead_of_positional_forecasting() -> None:
    dates = pd.date_range("2025-01-01", periods=180, freq="D")
    dates = dates.delete(list(range(5, 160, 9)))
    rows = pd.DataFrame({"date": dates, "revenue": 100 + np.sin(np.arange(len(dates)))})
    result, warnings = build_regression_forecast_v7(rows, "revenue", ["date"], 3, envelope, average)
    assert result is None
    assert any("regular" in warning for warning in warnings)


def test_turkish_and_english_number_formats_are_parsed() -> None:
    from app.forecasting_v7 import coerce_numeric_series

    parsed = coerce_numeric_series(pd.Series(["₺1.234,56", "$1,234.56", "(2.500,00)", "%12,5"]))
    assert parsed.tolist() == pytest.approx([1234.56, 1234.56, -2500.0, 0.125])


def test_forecast_is_skipped_without_real_date_axis() -> None:
    frame = pd.DataFrame({"revenue": np.arange(40, dtype=float)})
    result, warnings = build_regression_forecast_v7(frame, "revenue", [], 3, envelope, additive)
    assert result is None
    assert any("row order" in warning for warning in warnings)


def test_subdaily_data_is_not_silently_collapsed() -> None:
    frame = pd.DataFrame({
        "date": pd.date_range("2025-01-01", periods=80, freq="h"),
        "revenue": np.arange(80, dtype=float),
    })
    result, warnings = build_regression_forecast_v7(frame, "revenue", ["date"], 3, envelope, additive)
    assert result is None
    assert any("hourly" in warning or "sub-daily" in warning for warning in warnings)


def test_business_day_frequency_skips_weekends() -> None:
    dates = pd.bdate_range("2025-01-01", periods=80)
    history = [{"date": d.isoformat(), "value": 100 + i * 0.5} for i, d in enumerate(dates)]
    result = predict_history_v7(history, 3)
    future = [pd.Timestamp(point["date"]) for point in result["forecast"]]
    assert result["forecast_frequency"] == "B"
    assert all(date.weekday() < 5 for date in future)


def test_predict_rejects_missing_periods_and_subdaily_history() -> None:
    dates = pd.date_range("2025-01-01", periods=60, freq="D")
    missing = [{"date": d.isoformat(), "value": float(i)} for i, d in enumerate(dates) if i != 20]
    with pytest.raises(ValueError, match="missing periods"):
        predict_history_v7(missing, 3)

    hourly = [{"date": d.isoformat(), "value": float(i)} for i, d in enumerate(pd.date_range("2025-01-01", periods=60, freq="h"))]
    with pytest.raises(ValueError, match="sub-daily"):
        predict_history_v7(hourly, 3)


def test_requested_horizon_receives_highest_validation_weight() -> None:
    rows = pd.DataFrame({
        "date": pd.date_range("2024-01-01", periods=180, freq="D"),
        "revenue": 1000 + np.arange(180) * 2 + np.sin(np.arange(180) / 7) * 30,
    })
    result, _ = build_regression_forecast_v7(rows, "revenue", ["date"], 3, envelope, additive)
    assert result is not None
    selected = next(item for item in result["metrics"]["candidate_metrics"] if item["selected"])
    weights = {entry["horizon"]: entry["weight"] for entry in selected["per_horizon"]}
    assert weights[3] == max(weights.values())


def test_regime_shift_penalizes_historical_quality() -> None:
    values = np.r_[np.full(100, 100.0), np.full(20, 500.0)]
    rows = pd.DataFrame({"date": pd.date_range("2025-01-01", periods=len(values), freq="D"), "revenue": values})
    result, warnings = build_regression_forecast_v7(rows, "revenue", ["date"], 3, envelope, additive)
    assert result is not None
    assert result["metrics"]["regime_shift_score"] >= 3.0
    assert result["confidence"] <= 0.45
    assert any("regime" in warning for warning in warnings)


def test_monthly_mase_uses_detected_seasonal_scale() -> None:
    seasonal = [10, 20, 15, 30, 25, 40, 35, 50, 45, 60, 55, 12]
    rows = pd.DataFrame({
        "date": pd.date_range("2019-01-01", periods=72, freq="MS"),
        "revenue": seasonal * 6,
    })
    result, _ = build_regression_forecast_v7(rows, "revenue", ["date"], 3, envelope, additive)
    assert result is not None
    assert result["metrics"]["mase_scale_lag"] == 12


def test_predict_exposes_engine_and_decision_support_fields() -> None:
    history = [
        {"date": d.date().isoformat(), "value": float(1000 + index * 4)}
        for index, d in enumerate(pd.date_range("2024-01-01", periods=120, freq="D"))
    ]
    result = predict_history_v7(history, 3)
    assert result["engine_version"] == "forecasting_v7.1"
    assert result["decision_support"] in {
        "supporting_signal_with_monitoring",
        "supporting_signal_with_scenario_checks",
        "rough_baseline_do_not_use_alone",
        "exploratory_only_revalidate_before_action",
    }
    assert result["mase_scale_lag"] == 7



def test_domain_bounds_require_explicit_non_negative_semantics() -> None:
    from app.forecasting_v7 import _infer_bounds

    assert _infer_bounds(np.array([1.0, 2.0, 3.0]), "value") == (None, None)
    assert _infer_bounds(np.array([1.0, 2.0, 3.0]), "revenue") == (0.0, None)
    assert _infer_bounds(np.array([10.0, 20.0]), "account_balance") == (None, None)
    assert _infer_bounds(np.array([10.0, 20.0]), "nakit_akisi") == (None, None)


def test_seasonal_growth_is_not_offered_for_signed_series() -> None:
    from app.forecasting_v7 import _candidate_specs

    values = np.array([(-1.0) ** index * (100 + index) for index in range(48)], dtype=float)
    names = {spec.name for spec in _candidate_specs((12, "annual"), values)}
    assert "seasonal_naive" in names
    assert "seasonal_mean" in names
    assert "seasonal_growth" not in names


def test_numeric_parser_converts_infinity_to_missing() -> None:
    from app.forecasting_v7 import coerce_numeric_series

    parsed = coerce_numeric_series(pd.Series([1.0, np.inf, -np.inf]))
    assert parsed.iloc[0] == 1.0
    assert parsed.iloc[1:].isna().all()


def test_predict_rechecks_duplicate_calendar_days_after_normalization() -> None:
    history = [
        {"date": date.isoformat(), "value": float(index)}
        for index, date in enumerate(pd.date_range("2025-01-01", periods=60, freq="D"))
    ]
    history[-1]["date"] = "2025-02-28T12:00:00"
    history[-2]["date"] = "2025-02-28T00:00:00"
    with pytest.raises(ValueError, match="same calendar period"):
        predict_history_v7(history, 3)


def test_target_selection_fails_closed_on_ambiguous_revenue_columns() -> None:
    from app.forecasting_v7 import select_target_column_v7

    frame = pd.DataFrame({"Brut_Ciro": [100, 120, 130], "Net_Ciro": [90, 108, 117]})
    assert select_target_column_v7(frame, ["Brut_Ciro", "Net_Ciro"], None) is None
    assert select_target_column_v7(frame, ["Brut_Ciro", "Net_Ciro"], "Net_Ciro") == "Net_Ciro"


def test_target_selection_chooses_single_clear_measure_and_rejects_identifier() -> None:
    from app.forecasting_v7 import select_target_column_v7

    frame = pd.DataFrame({"Musteri_ID": [101, 102, 103, 104], "Revenue": [10, 20, 25, 30]})
    assert select_target_column_v7(frame, ["Musteri_ID", "Revenue"], None) == "Revenue"
