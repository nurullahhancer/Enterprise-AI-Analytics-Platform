# 21 - Test Stratejisi ve Güvence (Testing)

## 🧪 Test Süreçleri ve Kapsamı

Platform, yüksek kod kalitesi ve sıfır regresyon sağlamak adına kapsamlı test paketleri ile korunmaktadır.

---

## 📊 Test Paketleri
1. **TypeScript & Express Testleri (Vitest)**: BI engine (`engine.test.ts`), KPI motoru (`engine.test.ts`), NLP motoru (`pipeline.test.ts`), API rotaları ve yetkilendirme testleri.
2. **Python FastAPI Testleri (Pytest)**: ML servis algoritmaları, SARIMAX ve anomali tespiti testleri.
3. **PostgreSQL RLS Testleri**: Çok kiracılı veritabanı izolasyon testleri (`rls.postgres.test.ts`).
