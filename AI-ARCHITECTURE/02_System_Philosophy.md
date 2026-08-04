# 02 - Sistem Felsefesi (System Philosophy)

## 💡 Temel İlkeler

Enterprise AI Analytics Platform'un mimarisi üç temel felsefi sütun üzerine inşa edilmiştir:

```
+-----------------------------------------------------------------------+
|                          SİSTEM FELSEFESİ                              |
|                                                                       |
|  1. Deterministik Mantık (BI Engine)  --->  Sayısal Gerçeklik        |
|  2. İstatistiki ML Motoru           --->  Tahmin ve Anomali           |
|  3. Üretken AI (LLM)                --->  Yorumlama ve Anlatım        |
+-----------------------------------------------------------------------+
```

---

### 1. Deterministik BI Motoru (Sayısal Gerçeklik)
- İş kuralları, finansal eşikler ve risk analizleri **kod seviyesinde (TypeScript/Python)** tanımlanır.
- Örneğin; kâr marjı %5'in altındaysa bu durum bir LLM tahmini değil, deterministik bir *KRİTİK RİSK* kural ihlalidir.
- LLM hiçbir zaman finansal hesaplama veya risk kategorizasyonu yapmaz.

### 2. İstatistiki ML Motoru (Tahmin ve Anomali)
- Zaman serisi tahminleri (SARIMAX, Linear Trend), anomali tespiti (Z-score) ve müşteri segmentasyonu (K-Means) istatistiksel algoritmalarla çalışır.
- Güven skorları istatistiksel formüllerle (`linearConfidence`, MAE, RMSE, R²) hesaplanır.

### 3. Üretken AI / LLM (Yorumlama ve Anlatım)
- LLM (GPT-4, Claude, Gemini), yalnızca BI Engine ve ML Pipeline tarafından doğrulanmış veriyi doğal Türkçe veya İngilizce ile insan anlatımına dönüştürmek için kullanılır.
- LLM'e verilen veri `<dogrulanmis_analiz>` etiketi içerisinde sunulur ve dışına çıkması yasaklanır.

---

## 🛡️ Anti-Hallucination Disiplini
- Sayısal kararlar **asla** LLM tarafından üretilemez.
- Eksik veya hatalı veride LLM tahmin yürütmek yerine *"Veri kalitesi yetersiz"* uyarısı döner.
