# 16 - KPI Motoru (KPI Engine)

## 📐 Dinamik KPI Tanımlama ve Değerlendirme Motoru (`src/server/kpis/engine.ts`)

KPI Motoru, kullanıcıların verileri üzerinde özel KPI'lar tanımlamasına ve bu KPI'ları dinamik olarak hesaplamasına olanak tanır.

---

## ⚙️ Desteklenen Toplulaştırma Türleri (Aggregations)
- **`sum`**: Toplam değer.
- **`average`**: Ortalama değer.
- **`min` / `max`**: En küçük ve en büyük değer.
- **`count`**: Satır sayısı.

---

## 🚨 İhlal ve Eşik Kontrolü
KPI değerleri belirlenen hedef veya kritik eşikleri aştığında sistem otomatik olarak uyarı üretir ve kullanıcıya bildirim gönderir.
