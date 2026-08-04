# 07 - BI Engine (Business Intelligence Engine)

## 🧠 Deterministik BI Motoru (`src/server/bi/engine.ts`)

`BIEngine`, işletmenin finansal ve operasyonel verilerini 7 temel deterministik kural üzerinden değerlendirir ve risk/fırsat sinyalleri üretir.

---

## 📋 7 Temel İş Kuralı Kataloğu

### Rule 1: Stok Tükenme Riski (Inventory Runrate)
- **Eşik**: `stok_günü < 7` (KRİTİK) veya `stok_günü < 15` (UYARI).
- **Kanıt**: "Günlük X adet satış hızına göre stok Y gün içinde tükenecektir."
- **Aksiyon**: Tedarikçiye acil sipariş oluşturulması.

### Rule 2: Kârlılık Marjı (Profit Margin)
- **Eşik**: `kar_marjı < %5` (KRİTİK) veya `kar_marjı < %15` (UYARI).
- **Kanıt**: "Ortalama net kâr marjı %X seviyesindedir."

### Rule 3: Reklam Verimliliği (ROAS)
- **Eşik**: `ROAS < 2.0` (KRİTİK) veya `ROAS >= 4.0` (FIRSAT).
- **Aksiyon**: Düşük ROAS'lı kampanyaları durdurma veya bütçeyi artırma.

### Rule 4: İade Oranı (Return Rate)
- **Eşik**: `iade_oranı > %8.0` (KRİTİK).
- **Kanıt**: İade oranının kritik eşiği aştığını gösterir.

### Rule 5: Nakit Akışı Riski (Cash Flow)
- **Eşik**: `nakit_akışı_30gün < 0 TL` (KRİTİK).
- **Aksiyon**: Alacak tahsilatını hızlandırma.

### Rule 6: Müşteri Terk Riski (Churn Rate)
- **Eşik**: `churn_rate > %10.0` (UYARI).
- **Aksiyon**: Re-engagement e-posta kampanyası başlatma.

### Rule 7: NLP Müşteri Şikayet Trendi
- **Eşik**: `şikayet_oranı > %20` (UYARI/KRİTİK).
- **Aksiyon**: Operasyon ve lojistik ekibiyle aksiyon planı oluşturma.
