import numpy as np
import pandas as pd
from fastapi import HTTPException, status
from sklearn.ensemble import RandomForestClassifier, RandomForestRegressor
from sklearn.metrics import (
    accuracy_score,
    f1_score,
    mean_absolute_error,
    precision_score,
    recall_score,
    r2_score,
)
from sklearn.model_selection import train_test_split

from app.models import Dataset


def _clean_numeric_series(series: pd.Series) -> pd.Series:
    """Para birimi ($), yüzde (%) veya virgül içeren metinsel sayıları float yapar."""
    if series.dtype == object or isinstance(series.dtype, pd.CategoricalDtype):
        cleaned = (
            series.astype(str)
            .str.replace(r"[\$,%]", "", regex=True)
            .str.replace(r"\s+", "", regex=True)
            .str.strip()
        )
        converted = pd.to_numeric(cleaned, errors="coerce")
        if len(series) > 0 and (converted.notna().sum() / len(series)) >= 0.7:
            return converted
    return series


def train_preview_model(dataset: Dataset, target_column: str, problem_type: str) -> dict:
    frame = pd.DataFrame(dataset.preview)
    if frame.empty:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Dataset preview is empty")
    if target_column not in frame.columns:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Target column not found")

    # 1. Target NaN satırlarını temizle
    frame = frame.dropna(subset=[target_column]).copy()
    if len(frame) < 4:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="At least 4 non-empty target rows are required for training",
        )

    # 2. Metinsel sayıları (para birimi vb.) float tipine dönüştür
    for col in frame.columns:
        frame[col] = _clean_numeric_series(frame[col])

    y = frame[target_column]
    x = frame.drop(columns=[target_column])

    # 3. Yüksek kardinaliteli ID / Tarih / UUID sütunlarını ele
    columns_to_keep = []
    for col in x.columns:
        col_lower = str(col).lower()
        if any(col_lower.endswith(s) for s in ["_id", "id", "uuid", "guid", "timestamp", "created_at"]):
            continue
        unique_ratio = x[col].nunique(dropna=True) / len(x) if len(x) > 0 else 0
        if x[col].dtype == object and unique_ratio > 0.6 and len(x) > 5:
            continue
        columns_to_keep.append(col)

    x = x[columns_to_keep]

    # 4. Sayısal sütunlarda medyan doldurma, kategorik sütunlarda dummification
    num_cols = x.select_dtypes(include=[np.number]).columns
    cat_cols = x.select_dtypes(exclude=[np.number]).columns

    for col in num_cols:
        median_val = x[col].median()
        x[col] = x[col].fillna(0.0 if pd.isna(median_val) else median_val)

    for col in cat_cols:
        x[col] = x[col].fillna("missing")

    if x.empty or x.shape[1] == 0:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="No usable feature columns found after cleaning"
        )

    x = pd.get_dummies(x, drop_first=True if len(x) > 10 else False)

    if x.empty or x.shape[1] == 0:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="No usable feature columns found after cleaning"
        )

    x_train, x_test, y_train, y_test = train_test_split(x, y, test_size=0.3, random_state=42)

    if problem_type == "classification":
        model = RandomForestClassifier(n_estimators=50, random_state=42)
        model.fit(x_train, y_train)
        predictions = model.predict(x_test)

        acc = float(accuracy_score(y_test, predictions))
        prec = float(precision_score(y_test, predictions, average="weighted", zero_division=0))
        rec = float(recall_score(y_test, predictions, average="weighted", zero_division=0))
        f1 = float(f1_score(y_test, predictions, average="weighted", zero_division=0))

        metrics = {
            "accuracy": acc,
            "precision": prec,
            "recall": rec,
            "f1_score": f1,
        }
    else:
        y_train_numeric = pd.to_numeric(y_train, errors="coerce")
        y_test_numeric = pd.to_numeric(y_test, errors="coerce")

        if y_train_numeric.isna().any() or y_test_numeric.isna().any():
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST, detail="Regression target must be numeric"
            )

        model = RandomForestRegressor(n_estimators=50, random_state=42)
        model.fit(x_train, y_train_numeric)
        predictions = model.predict(x_test)

        mae = float(mean_absolute_error(y_test_numeric, predictions))
        raw_r2 = float(r2_score(y_test_numeric, predictions)) if len(y_test_numeric) > 1 else 0.0

        metrics = {
            "mean_absolute_error": mae,
            "r2": max(0.0, raw_r2) if not np.isnan(raw_r2) else 0.0,
            "raw_r2": raw_r2,
        }

    metrics["training_rows"] = int(len(x_train))
    metrics["test_rows"] = int(len(x_test))
    metrics["feature_count"] = int(x.shape[1])
    return metrics
