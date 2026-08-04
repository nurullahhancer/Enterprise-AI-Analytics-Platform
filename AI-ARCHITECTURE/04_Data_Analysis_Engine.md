# 04 - Veri Analiz Motoru (Data Analysis Engine)

## ⚙️ Veri İşleme ve Ayrıştırma Mimarisi

Veri Analiz Motoru, kullanıcı tarafından yüklenen CSV, JSON ve XLSX dosyalarını güvenli ve yüksek performanslı şekilde işlemekten sorumludur.

---

## 🔍 Kolon Tipi Tespiti ve Profilleme (`buildDataProfile`)

`src/server/ml/pipeline.ts` ve `parser.ts` modülleri yüklenen dosyadaki kolonları 5 ana tipe ayırır:

```ts
export type ColumnKind = 'numeric' | 'currency' | 'datetime' | 'categorical' | 'text';
```

### Kolon Tipi Tespit Kuralları:
1. **`datetime`**: Kolon verilerinin %65+'i `parseFlexibleDate` ile geçerli bir tarihe dönüşüyorsa veya kolon adı `tarih, date, time, gun, ay` içeriyorsa.
2. **`currency` / `numeric`**: Sayısal dönüştürme (`toNumber`) başarı oranı %70+ ise ve kolon adında `ciro, gelir, tutar, fiyat, amount, sales, cost, maliyet` geçiyorsa `currency`, aksi halde `numeric`.
3. **`categorical`**: Tekil değer sayısı az ve tekrarlayan metinlerden oluşuyorsa.
4. **`text`**: Ortalama karakter uzunluğu 15'ten büyük metinlerden oluşuyorsa (yorumlar, açıklamalar).

---

## 📊 Özet Metrik Hesaplama (`buildDatasetSummary`)

Bir veri seti yüklendiğinde otomatik olarak şu metrikler hesaplanır:
- **Toplam Ciro (Total Revenue)**: Hedef sayısal/finansal kolonun toplamı.
- **Toplam Maliyet (Total Cost)**: Maliyet kolonunun toplamı.
- **Brüt Kâr Marjı (Gross Margin %)**: `((Ciro - Maliyet) / Ciro) * 100`
- **Müşteri/İade Kayıp Oranı (Churn/Return Rate %)**: İade veya kayıp işaretli satırların toplam satıra oranı.
- **Kategori/Bölge Dağılımı**: Grafik verileri için ilk 12 kategorik özet.
