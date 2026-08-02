# ML Model Card

## Purpose

The internal FastAPI service produces decision-support forecasts, anomaly flags, clusters and binary classifications from organization-scoped tabular data. Outputs are not guarantees and must not be used as the sole basis for credit, employment, medical, legal or safety-critical decisions.

## Algorithms

- Forecasting: chronological candidate evaluation including simple baselines and regression/ensemble candidates, selected only on validation data.
- Anomalies: Isolation Forest with deterministic seed and bounded contamination.
- Segmentation: standardized K-Means with deterministic seed and bounded cluster search.
- Classification: deterministic train/test evaluation with logistic/tree candidates where label quality permits.

The implementation version and feature schema version are returned with model results. Tenant-scoped cache keys include data hashes and model type.

## Data requirements

Forecasting needs a numeric business target and ordered observations. Date columns are detected and sorted; missing/irregular periods produce warnings. Small, constant, sparse or low-variance series use explicit fallback behavior. Input size, cells, column names and cell text are bounded.

## Validation and metrics

Time series use chronological holdout/rolling-origin validation where data size permits. Candidate selection does not use the final test observations. Reported metrics include MAE, RMSE, SMAPE, MASE and R² where mathematically defined, alongside a naive baseline comparison. Zero targets do not use plain MAPE.

Forecast intervals are derived from out-of-sample residual behavior. Negative forecasts are clipped only for targets whose inferred business semantics cannot be negative. Baseline underperformance, negative R², insufficient history and drift lower the quality grade and produce warnings.

`confidence` is a bounded quality indicator derived from validation evidence, sample size, drift, interval width and baseline comparison. It is not a probability that the forecast will be correct.

## Reproducibility

Randomized estimators use fixed seeds. Input hash, engine/model version, feature schema, selected candidate, metrics, warnings and persisted analysis result provide an audit trail. Dependency versions are pinned in `requirements.txt`.

## Drift

Distribution and recent-window changes contribute warnings/quality penalties. Operators should monitor forecast error on realized outcomes and retrain/re-run when source schema, cadence, pricing, promotions or operating conditions change.

## Known limitations

- Observational data does not prove causality.
- Exogenous events absent from input cannot be anticipated.
- Irregular cadence and short history widen uncertainty.
- Aggregate forecasts may hide subgroup behavior.
- The current service trains per request; it is not a managed continuous-training platform.

## LLM boundary

The LLM explains persisted, validated ML evidence. It does not replace numeric model output. Prompts label customer content as untrusted data, bound context size and forbid invented numbers. Token/cost usage is audited separately.
