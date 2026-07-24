from fastapi.testclient import TestClient

from app.main import AnalyzeRequest, TenantModelCache, app, _cache


# ---------------------------------------------------------------------------
# Fixtures / helpers
# ---------------------------------------------------------------------------

TENANT_A = "tenant-a"
TENANT_B = "tenant-b"

ROWS_SMALL = [
    {"region": "A", "revenue": 100, "cost": 60},
    {"region": "B", "revenue": 120, "cost": 72},
    {"region": "C", "revenue": 140, "cost": 82},
    {"region": "D", "revenue": 1000, "cost": 100},
    {"region": "E", "revenue": 160, "cost": 90},
]

HISTORY = [
    {"date": "2026-01-01", "value": 100},
    {"date": "2026-02-01", "value": 120},
    {"date": "2026-03-01", "value": 140},
]


def _clear_all() -> None:
    """Wipe the entire cache between tests."""
    with _cache._lock:
        _cache._store.clear()


# ---------------------------------------------------------------------------
# Existing tests (unchanged behaviour)
# ---------------------------------------------------------------------------

def test_health() -> None:
    client = TestClient(app)
    assert client.get("/health").json()["status"] == "ok"


def test_predict_returns_forecast() -> None:
    client = TestClient(app)
    response = client.post(
        "/predict",
        json={"history": HISTORY, "periods": 2},
    )
    assert response.status_code == 200
    assert len(response.json()["forecast"]) == 2


def test_predict_requires_two_points() -> None:
    client = TestClient(app)
    response = client.post(
        "/predict",
        json={"history": [{"date": "2026-01-01", "value": 100}], "periods": 2},
    )
    assert response.status_code == 422


def test_anomalies_and_clusters() -> None:
    client = TestClient(app)
    anomaly_response = client.post("/anomalies", json=[10, 11, 12, 1000])
    cluster_response = client.post("/clusters?k=2", json=[10, 11, 12, 1000])

    assert anomaly_response.status_code == 200
    assert 3 in anomaly_response.json()["anomalies"]
    assert cluster_response.status_code == 200
    assert len(cluster_response.json()["clusters"]) == 4


def test_analyze_trains_models() -> None:
    client = TestClient(app)
    response = client.post(
        "/analyze",
        json={"rows": ROWS_SMALL, "target_column": "revenue", "periods": 2},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["forecast"]["type"] == "forecast"
    assert body["forecast"]["metrics"]["rmse"] >= 0
    assert body["forecast"]["metrics"]["train_rows"] == 3
    assert body["forecast"]["metrics"]["test_rows"] == 2
    assert body["forecast"]["metrics"]["validation_method"] == "chronological_last_20_percent"
    assert any("row order" in warning.lower() for warning in body["warnings"])
    assert body["anomalies"]["type"] == "anomaly"
    assert body["segments"]["type"] == "segment"


def test_analyze_never_averages_business_identifiers() -> None:
    client = TestClient(app)
    rows = [
        {"Sipariş No": 1001, "musteri_numarasi": 42, "Tarih": "2026-01-01", "ciro": 100},
        {"Sipariş No": 1001, "musteri_numarasi": 42, "Tarih": "2026-01-02", "ciro": 120},
        {"Sipariş No": 1002, "musteri_numarasi": 51, "Tarih": "2026-01-03", "ciro": 140},
        {"Sipariş No": 1003, "musteri_numarasi": 51, "Tarih": "2026-01-04", "ciro": 160},
        {"Sipariş No": 1004, "musteri_numarasi": 63, "Tarih": "2026-01-05", "ciro": 180},
    ]

    response = client.post("/analyze", json={"rows": rows, "periods": 2})

    assert response.status_code == 200
    body = response.json()
    assert body["target_column"] == "ciro"
    assert body["segments"] is not None
    for segment in body["segments"]["data"]:
        assert "Sipariş No" not in segment["averages"]
        assert "musteri_numarasi" not in segment["averages"]


def test_analyze_trains_explainable_churn_risk_model() -> None:
    client = TestClient(app)
    rows = []
    for index in range(40):
        churn = 1 if index % 4 == 0 or index > 34 else 0
        rows.append({
            "customer_id": f"C-{index:03d}",
            "tenure_months": 2 + index,
            "monthly_spend": 100 + index * 8,
            "support_tickets": 5 if churn else index % 2,
            "contract": "monthly" if churn else "annual",
            "churn": churn,
        })

    response = client.post(
        "/analyze",
        json={"rows": rows, "target_column": "monthly_spend", "periods": 2},
        headers={"x-tenant-id": "churn-use-case"},
    )

    assert response.status_code == 200
    classifications = response.json()["classifications"]
    assert len(classifications) == 1
    churn_model = classifications[0]
    assert churn_model["type"] == "classification"
    assert churn_model["metrics"]["use_case"] == "churn_risk"
    assert churn_model["metrics"]["target_column"] == "churn"
    assert churn_model["metrics"]["test_rows"] == 10
    assert len(churn_model["metrics"]["drivers"]) > 0
    assert len(churn_model["data"]) == 10
    assert all("risk_score" in row and "customer_id" not in row for row in churn_model["data"])


def test_analyze_time_series_sorts_aggregates_and_validates_future_horizon() -> None:
    client = TestClient(app)
    rows = []
    for month in range(1, 11):
        date = f"2026-{month:02d}-01"
        # Two rows per date verify that additive targets are aggregated before
        # the chronological split. Reverse input order verifies date sorting.
        rows.extend(
            [
                {"date": date, "region": "A", "revenue": 40 + month * 5},
                {"date": date, "region": "B", "revenue": 60 + month * 5},
            ]
        )
    rows.reverse()

    response = client.post(
        "/analyze",
        json={"rows": rows, "target_column": "revenue", "periods": 3},
        headers={"x-tenant-id": "validated-time-series"},
    )

    assert response.status_code == 200
    forecast = response.json()["forecast"]
    metrics = forecast["metrics"]
    assert metrics["aggregation"] == "sum"
    assert metrics["date_column"] == "date"
    assert metrics["train_rows"] == 8
    assert metrics["test_rows"] == 2
    assert metrics["validation_method"] == "chronological_last_20_percent"
    assert metrics["mae"] >= 0
    assert metrics["rmse"] >= 0
    assert metrics["smape"] >= 0
    assert len(forecast["data"]) == 3
    assert forecast["data"][0]["date"] == "2026-11-01"
    for point in forecast["data"]:
        assert point["lower"] <= point["predicted"] <= point["upper"]
    assert "chronological holdout" in forecast["model"].lower()


def test_analyze_selects_linear_trend_by_training_only_holdout_mae() -> None:
    client = TestClient(app)
    rows = [
        {
            "date": f"2026-01-{day:02d}",
            "revenue": 25 + day * 7,
        }
        for day in range(1, 16)
    ]

    response = client.post(
        "/analyze",
        json={"rows": rows, "target_column": "revenue", "periods": 3},
        headers={"x-tenant-id": "linear-model-selection"},
    )

    assert response.status_code == 200
    forecast = response.json()["forecast"]
    metrics = forecast["metrics"]
    assert metrics["selected_model"] == "linear_trend"
    assert metrics["selection_metric"] == "mae"
    assert metrics["validation"]["method"] == "chronological_last_20_percent"
    assert "training rows only" in metrics["validation"]["strategy"]
    assert len(metrics["candidate_metrics"]) == 3
    assert metrics["candidate_metrics"][0]["model"] == "linear_trend"
    assert metrics["candidate_metrics"][0]["selected"] is True
    assert metrics["candidate_metrics"][0]["mae"] == 0
    assert len([candidate for candidate in metrics["candidate_metrics"] if candidate["selected"]]) == 1


def test_analyze_selects_monthly_seasonal_naive_when_it_wins_holdout() -> None:
    client = TestClient(app)
    seasonal_values = [20, 45, 30, 80, 55, 100, 70, 120, 65, 95, 40, 25]
    rows = []
    for index in range(36):
        year = 2023 + index // 12
        month = index % 12 + 1
        rows.append(
            {
                "date": f"{year}-{month:02d}-01",
                "revenue": seasonal_values[index % 12],
            }
        )

    response = client.post(
        "/analyze",
        json={"rows": rows, "target_column": "revenue", "periods": 4},
        headers={"x-tenant-id": "seasonal-model-selection"},
    )

    assert response.status_code == 200
    forecast = response.json()["forecast"]
    metrics = forecast["metrics"]
    assert metrics["selected_model"] == "seasonal_naive"
    assert metrics["selected_model_parameters"] == {"lag": 12}
    assert len(metrics["candidate_metrics"]) == 4
    assert metrics["candidate_metrics"][0]["model"] == "seasonal_naive"
    assert metrics["candidate_metrics"][0]["mae"] == 0
    assert [point["predicted"] for point in forecast["data"]] == seasonal_values[:4]
    assert "seasonal naive (lag 12)" in forecast["model"].lower()
    assert metrics["interval_method"] == "empirical_holdout_absolute_error_95pct_with_horizon_scaling"


def test_analyze_constant_target_never_claims_predictive_confidence() -> None:
    client = TestClient(app)
    rows = [
        {"date": f"2026-{month:02d}-01", "revenue": 100}
        for month in range(1, 9)
    ]

    response = client.post(
        "/analyze",
        json={"rows": rows, "target_column": "revenue", "periods": 2},
        headers={"x-tenant-id": "constant-target"},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["forecast"]["confidence"] == 0
    assert body["forecast"]["metrics"]["train_rows"] == 6
    assert body["forecast"]["metrics"]["test_rows"] == 2
    assert body["forecast"]["metrics"]["selected_model"] == "naive_last_value"
    assert len(body["forecast"]["metrics"]["candidate_metrics"]) == 3
    assert any("constant" in warning.lower() for warning in body["warnings"])


def test_analyze_small_series_returns_forecast_with_zero_unvalidated_confidence() -> None:
    client = TestClient(app)
    rows = [
        {"date": f"2026-0{month}-01", "revenue": month * 100}
        for month in range(1, 5)
    ]

    response = client.post(
        "/analyze",
        json={"rows": rows, "target_column": "revenue", "periods": 4},
        headers={"x-tenant-id": "small-series"},
    )

    assert response.status_code == 200
    body = response.json()
    forecast = body["forecast"]
    assert forecast["confidence"] == 0
    assert forecast["metrics"]["train_rows"] == 4
    assert forecast["metrics"]["test_rows"] == 0
    assert forecast["metrics"]["validation_method"] == "insufficient_data_no_holdout"
    assert forecast["metrics"]["mae"] is None
    assert forecast["metrics"]["selected_model"] == "linear_trend"
    assert forecast["metrics"]["candidate_metrics"] == []
    assert len(forecast["data"]) == 4
    assert all("lower" not in point and "upper" not in point for point in forecast["data"])
    assert any("holdout" in warning.lower() for warning in body["warnings"])


# ---------------------------------------------------------------------------
# Tenant-based model cache tests
# ---------------------------------------------------------------------------

def test_predict_cache_hit_same_tenant_same_data() -> None:
    """Second call with identical data returns cached=True."""
    _clear_all()
    client = TestClient(app)
    headers = {"x-tenant-id": TENANT_A}
    payload = {"history": HISTORY, "periods": 2}

    r1 = client.post("/predict", json=payload, headers=headers)
    r2 = client.post("/predict", json=payload, headers=headers)

    assert r1.status_code == 200
    assert r2.status_code == 200
    assert r1.json()["cached"] is False
    assert r2.json()["cached"] is True
    # Results must be identical
    assert r1.json()["forecast"] == r2.json()["forecast"]


def test_predict_different_tenants_separate_cache() -> None:
    """Different tenants produce separate cache entries."""
    _clear_all()
    client = TestClient(app)
    payload = {"history": HISTORY, "periods": 2}

    r_a1 = client.post("/predict", json=payload, headers={"x-tenant-id": TENANT_A})
    r_a2 = client.post("/predict", json=payload, headers={"x-tenant-id": TENANT_A})
    r_b1 = client.post("/predict", json=payload, headers={"x-tenant-id": TENANT_B})
    r_b2 = client.post("/predict", json=payload, headers={"x-tenant-id": TENANT_B})

    assert r_a1.json()["cached"] is False
    assert r_a2.json()["cached"] is True   # cache hit for A
    assert r_b1.json()["cached"] is False  # separate entry for B
    assert r_b2.json()["cached"] is True   # cache hit for B

    stats = client.get("/ml/cache").json()
    assert stats["tenant_count"] >= 2
    assert "tenants" not in stats


def test_predict_cache_miss_on_data_change() -> None:
    """Changed data invalidates the cache (new hash → miss)."""
    _clear_all()
    client = TestClient(app)
    headers = {"x-tenant-id": TENANT_A}

    history_v1 = [
        {"date": "2026-01-01", "value": 100},
        {"date": "2026-02-01", "value": 120},
        {"date": "2026-03-01", "value": 140},
    ]
    history_v2 = [
        {"date": "2026-01-01", "value": 200},
        {"date": "2026-02-01", "value": 220},
        {"date": "2026-03-01", "value": 240},
    ]

    r1 = client.post("/predict", json={"history": history_v1, "periods": 2}, headers=headers)
    r2 = client.post("/predict", json={"history": history_v2, "periods": 2}, headers=headers)

    assert r1.json()["cached"] is False
    assert r2.json()["cached"] is False  # different hash → miss


def test_analyze_cache_hit_same_tenant() -> None:
    """Analyze endpoint: second identical call is served from cache."""
    _clear_all()
    client = TestClient(app)
    headers = {"x-tenant-id": TENANT_A}
    payload = {"rows": ROWS_SMALL, "target_column": "revenue", "periods": 2}

    r1 = client.post("/analyze", json=payload, headers=headers)
    r2 = client.post("/analyze", json=payload, headers=headers)

    assert r1.status_code == 200
    assert r2.status_code == 200
    assert r1.json()["cached"] is False
    assert r2.json()["cached"] is True
    assert r2.json()["forecast"]["metrics"]["selected_model"] == r1.json()["forecast"]["metrics"]["selected_model"]
    assert r2.json()["forecast"]["metrics"]["candidate_metrics"] == r1.json()["forecast"]["metrics"]["candidate_metrics"]


def test_analyze_cache_varies_by_target_and_periods() -> None:
    """A cached analysis must not reuse a different target or forecast horizon."""
    _clear_all()
    client = TestClient(app)
    headers = {"x-tenant-id": TENANT_A}

    revenue = client.post(
        "/analyze",
        json={"rows": ROWS_SMALL, "target_column": "revenue", "periods": 2},
        headers=headers,
    )
    cost = client.post(
        "/analyze",
        json={"rows": ROWS_SMALL, "target_column": "cost", "periods": 4},
        headers=headers,
    )

    assert revenue.status_code == 200
    assert cost.status_code == 200
    assert revenue.json()["cached"] is False
    assert cost.json()["cached"] is False
    assert cost.json()["target_column"] == "cost"
    assert len(cost.json()["forecast"]["data"]) == 4


def test_analyze_different_tenants_isolated() -> None:
    """Analyze: tenant A cache does not bleed into tenant B."""
    _clear_all()
    client = TestClient(app)
    payload = {"rows": ROWS_SMALL, "target_column": "revenue", "periods": 2}

    r_a = client.post("/analyze", json=payload, headers={"x-tenant-id": TENANT_A})
    r_b = client.post("/analyze", json=payload, headers={"x-tenant-id": TENANT_B})

    # Both are cold misses despite identical data
    assert r_a.json()["cached"] is False
    assert r_b.json()["cached"] is False


def test_cache_clear_endpoint() -> None:
    """DELETE /ml/cache/{tenant} removes only that tenant's entries."""
    _clear_all()
    client = TestClient(app)
    payload = {"rows": ROWS_SMALL, "target_column": "revenue", "periods": 2}

    # Populate both tenants
    client.post("/analyze", json=payload, headers={"x-tenant-id": TENANT_A})
    client.post("/analyze", json=payload, headers={"x-tenant-id": TENANT_B})

    before_stats = client.get("/ml/cache").json()
    assert before_stats["tenant_count"] >= 2

    # Clear only A
    del_response = client.delete(f"/ml/cache/{TENANT_A}")
    assert del_response.status_code == 200
    assert del_response.json()["cleared_entries"] >= 1

    # A is cold after clear while B still uses its cached model.
    a_after = client.post("/analyze", json=payload, headers={"x-tenant-id": TENANT_A})
    b_after = client.post("/analyze", json=payload, headers={"x-tenant-id": TENANT_B})
    assert a_after.json()["cached"] is False
    assert b_after.json()["cached"] is True


def test_anonymous_tenant_fallback() -> None:
    """Requests without X-Tenant-Id header default to 'anonymous' tenant."""
    _clear_all()
    client = TestClient(app)
    payload = {"history": HISTORY, "periods": 1}

    r1 = client.post("/predict", json=payload)  # no header
    r2 = client.post("/predict", json=payload)  # same, should hit cache

    assert r1.json()["cached"] is False
    assert r2.json()["cached"] is True

    stats = client.get("/ml/cache").json()
    assert stats["tenant_count"] == 1
    assert "tenants" not in stats


def test_cache_is_bounded_and_does_not_expose_tenant_ids() -> None:
    cache = TenantModelCache(max_entries=2)
    cache.put("customer-one@example.test", "a", "predict", object(), {})
    cache.put("customer-two@example.test", "b", "predict", object(), {})
    cache.put("customer-three@example.test", "c", "predict", object(), {})

    stats = cache.stats()
    assert stats == {"total_entries": 2, "tenant_count": 2, "max_entries": 2, "evictions": 1}
    assert "customer-one@example.test" not in str(stats)


def test_cache_clear_requires_configured_internal_key(monkeypatch) -> None:
    monkeypatch.setenv("ML_INTERNAL_API_KEY", "test-internal-key")
    client = TestClient(app)

    denied = client.delete(f"/ml/cache/{TENANT_A}")
    allowed = client.delete(
        f"/ml/cache/{TENANT_A}",
        headers={"x-internal-api-key": "test-internal-key"},
    )

    assert denied.status_code == 401
    assert allowed.status_code == 200


def test_analyze_rejects_excessive_column_count() -> None:
    client = TestClient(app)
    oversized_row = {f"column-{index}": index for index in range(101)}
    response = client.post("/analyze", json={"rows": [oversized_row] * 3})
    assert response.status_code == 422


def test_analyze_request_accepts_combined_dataset_over_ten_thousand_rows() -> None:
    request = AnalyzeRequest(rows=[{"value": index} for index in range(14_796)])

    assert len(request.rows) == 14_796
