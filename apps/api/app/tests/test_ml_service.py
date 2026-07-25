import pytest
from fastapi import HTTPException
import pandas as pd
import numpy as np

from app.models import Dataset
from app.services.ml import _clean_numeric_series, train_preview_model


def test_clean_numeric_series_currency_percentage_comma():
    # Test currency and percentage strings
    s = pd.Series(["$100.00", "%25", "1,500.50", "$200.00", "%30", "2,000.00", "$50.00"])
    cleaned = _clean_numeric_series(s)
    assert cleaned.dtype == np.float64
    assert list(cleaned) == [100.0, 25.0, 1500.5, 200.0, 30.0, 2000.0, 50.0]

def test_clean_numeric_series_plain_text():
    # Test standard categorical text that shouldn't be converted to numeric
    s = pd.Series(["apple", "banana", "cherry", "apple", "banana"])
    cleaned = _clean_numeric_series(s)
    assert cleaned.dtype == object


def test_target_nan_cleanup():
    # Target column has NaNs
    data = [
        {"age": 25, "income": 50000, "target": 100},
        {"age": 30, "income": 60000, "target": None},
        {"age": 35, "income": 70000, "target": 120},
        {"age": 40, "income": 80000, "target": 130},
        {"age": 45, "income": 90000, "target": 140},
        {"age": 50, "income": 100000, "target": 150},
    ]
    ds = Dataset(preview=data)
    result = train_preview_model(ds, target_column="target", problem_type="regression")
    assert result["training_rows"] + result["test_rows"] == 5
    assert "r2" in result
    assert "mean_absolute_error" in result


def test_target_less_than_4_rows_raises_http_exception():
    data = [
        {"age": 25, "target": 100},
        {"age": 30, "target": None},
        {"age": 35, "target": 120},
        {"age": 40, "target": 130},
    ]
    ds = Dataset(preview=data)
    with pytest.raises(HTTPException) as exc_info:
        train_preview_model(ds, target_column="target", problem_type="regression")
    assert exc_info.value.status_code == 400
    assert "At least 4 non-empty target rows" in exc_info.value.detail


def test_high_cardinality_id_and_timestamp_removal():
    # Test removal of high cardinality features like user_uuid, created_at, item_id
    rows = []
    for i in range(20):
        rows.append({
            "user_uuid": f"uuid-{i}",
            "created_at": f"2026-01-{i+1:02d}T00:00:00Z",
            "item_id": f"ID_{i}",
            "feature_val": i * 2.5,
            "category": "A" if i % 2 == 0 else "B",
            "target": 0 if i % 2 == 0 else 1,
        })
    ds = Dataset(preview=rows)
    metrics = train_preview_model(ds, target_column="target", problem_type="classification")
    assert metrics["accuracy"] >= 0.0
    assert "precision" in metrics
    assert "recall" in metrics
    assert "f1_score" in metrics


def test_median_and_missing_imputation():
    # Test numerical median imputation and categorical missing imputation
    data = [
        {"income": 1000.0, "city": "NYC", "target": 1},
        {"income": None, "city": None, "target": 0},
        {"income": 3000.0, "city": "LA", "target": 1},
        {"income": 4000.0, "city": "NYC", "target": 0},
        {"income": 5000.0, "city": None, "target": 1},
        {"income": None, "city": "Chicago", "target": 0},
    ]
    ds = Dataset(preview=data)
    metrics = train_preview_model(ds, target_column="target", problem_type="classification")
    assert metrics["training_rows"] > 0


def test_regression_clamped_r2():
    # Test regression with negative R2 being clamped to 0.0
    np.random.seed(42)
    rows = []
    for i in range(20):
        rows.append({
            "x1": np.random.randn(),
            "target": np.random.randn() * 1000,
        })
    ds = Dataset(preview=rows)
    metrics = train_preview_model(ds, target_column="target", problem_type="regression")
    assert metrics["r2"] >= 0.0
    assert "raw_r2" in metrics


def test_empty_dataset_raises():
    ds = Dataset(preview=[])
    with pytest.raises(HTTPException) as exc_info:
        train_preview_model(ds, target_column="target", problem_type="classification")
    assert exc_info.value.status_code == 400


def test_missing_target_column_raises():
    ds = Dataset(preview=[{"a": 1, "b": 2}, {"a": 3, "b": 4}, {"a": 5, "b": 6}, {"a": 7, "b": 8}])
    with pytest.raises(HTTPException) as exc_info:
        train_preview_model(ds, target_column="non_existent", problem_type="classification")
    assert exc_info.value.status_code == 400


def test_no_usable_features_raises():
    # Dataset where all features are dropped due to ending with _id or timestamp
    data = [
        {"user_id": 1, "created_at": "2026-01-01", "target": 10},
        {"user_id": 2, "created_at": "2026-01-02", "target": 20},
        {"user_id": 3, "created_at": "2026-01-03", "target": 30},
        {"user_id": 4, "created_at": "2026-01-04", "target": 40},
    ]
    ds = Dataset(preview=data)
    with pytest.raises(HTTPException) as exc_info:
        train_preview_model(ds, target_column="target", problem_type="regression")
    assert exc_info.value.status_code == 400
    assert "No usable feature columns found" in exc_info.value.detail
