# 13 - Dashboard ve Şablon Kuralları (Dashboard Rules)

## 🎨 Dinamik Dashboard Motoru (`src/server/ml/pipeline.ts`)

Kullanıcının yüklediği veri setinin yapısına göre sistem otomatik olarak en uygun dashboard şablonunu ve widget'ları seçer.

---

## 📐 Şablon Algılama (`detectDashboardTemplate`)

- **`retail` (Perakende & E-Ticaret)**: Kolon isimlerinde `urun, siparis, stok, iade, sepet` bulunursa.
- **`finance` (Finans & Muhasebe)**: Kolon isimlerinde `nakit, fatura, tahsilat, bakiye, maliyet` bulunursa.
- **`hr` (İnsan Kaynakları)**: Kolon isimlerinde `personel, calisan, departman` bulunursa.
- **`operations` (Operasyon)**: Kolon isimlerinde `ekipman, makine, uretim, tedarik` bulunursa.
- **`general` (Genel Analitik)**: Standart tablo yapısı.

---

## 🧩 Widget Öneri Algoritması (`recommendWidgets`)
1. **KPI Kartları**: Toplam Ciro, Risk Oranı.
2. **Trend Grafikleri**: Kategori/Zaman bazlı dağılım.
3. **Top-N Kartları**: En yüksek satış yapan ilk 5 grup.
4. **Veri Profili Kartı**: Kolon kalitesi ve eksik veri oranları.
