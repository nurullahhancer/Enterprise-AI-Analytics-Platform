from fastapi.testclient import TestClient

from app.main import TenantModelCache, app, _cache


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
    assert body["anomalies"]["type"] == "anomaly"
    assert body["segments"]["type"] == "segment"


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
