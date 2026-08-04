# 05 - ML Mimarisi (Machine Learning Architecture)

## 🤖 Makine Öğrenimi Modülü Yapısı

Platformda makine öğrenimi işlevleri hem **TypeScript içi hafif ML motoru** (`src/server/ml/pipeline.ts`) hem de **Python FastAPI Microservice** (`ml-service/app/`) üzerinden yürütülür.

```
+-----------------------------------------------------------------------+
|                          ML PİPELİNE MİMARİSİ                          |
|                                                                       |
|  1. Zaman Serisi Tahmini (Forecasting)  ---> SARIMAX / Linear Trend   |
|  2. Anomali Tespiti (Anomaly Detection) ---> Z-Score / Isolation Forest|
|  3. Segmentasyon (Customer Segmentation)---> K-Means / RFM            |
|  4. İş Kuyruğu (Job Queue)              ---> Bounded Async Queue      |
+-----------------------------------------------------------------------+
```

---

## 📈 1. Zaman Serisi Tahmini (Forecasting)
- **Modeller**: SARIMAX, Holt-Winters, Doğrusal Trend Tahmini.
- **Gürültü Filtreleme (Noise Filtering)**: Günlük veride yüksek gürültü tespit edildiğinde (güven skoru <%65), sistem otomatik olarak 7, 14 veya 30 günlük toplulaştırılmış periyotlara geçer.
- **Çıktı**: Geçmiş seri (`series`) ve gelecek periyot tahminleri (`forecast`).

---

## 🚨 2. Anomali Tespiti (Anomaly Detection)
- Standart sapma ve Z-Score analizi kullanılır.
- `z >= 2.2` olan veri noktaları potansiyel anomali olarak işaretlenir.
- Anomali noktaları grafik üzerinde özel uyarı işaretleriyle gösterilir.

---

## 🧩 3. Müşteri Segmentasyonu (Segmentation)
- Kullanıcı verilerinde K-Means kümeleme yöntemiyle Müşteri Değeri / Harcama grupları oluşturulur.
- Segment bazlı ortalama harcama ve müşteri sayıları hesaplanır.

---

## ⚡ 4. Asenkron İş Kuyruğu (`jobQueue.ts`)
- Ağır ML analizleri sunucu performansını düşürmemek adına `jobQueue.ts` ile kuyruğa alınır.
- İş durumları (`PENDING`, `PROCESSING`, `COMPLETED`, `FAILED`) üzerinden takip edilir.
