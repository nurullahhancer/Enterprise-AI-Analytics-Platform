# 06 - NLP Mimarisi (NLP & Sentiment Engine)

## 💬 Müşteri Yorumları ve Geri Bildirim Analiz Motoru

Platform, e-ticaret müşteri yorumlarını, destek biletlerini ve geri bildirim metinlerini analiz etmek için özel bir NLP motoru içerir (`extractNlpComplaints`).

---

## 🔍 NLP Çalışma Algoritması (`src/server/ml/pipeline.ts`)

```
Veri Seti Yükleme  --->  Yorum/Metin Kolonu Tespiti  --->  Metin Temizleme & Regex Matching  --->  Konu Kümeleme  --->  % Oran Hesaplama
```

### 1. Kolon Algılama
Kolon başlığı `yorum, comment, feedback, şikayet, review, destek, metin, mesaj, açıklama` kalıplarıyla eşleşen veya ortalama uzunluğu 15 karakterden büyük olan kolon otomatik seçilir.

### 2. Şikayet ve Konu Kümeleme Kategorileri

| Şikayet Konusu | Eşleşen Anahtar Kelimeler (Regex) |
|---|---|
| **Kargo ve Teslimat Gecikmesi** | `kargo, gecikme, teslimat, kurye, varış, geç geldi, ulaşmadı` |
| **Beden / Ebat Uyuşmazlığı** | `beden, ebat, ölçü, küçük, büyük, dar, bol, kesim, numara` |
| **Ambalaj / Paket Kutusunda Hasar** | `ambalaj, paket, kutu, hasar, yırtık, ezik, kırık, patlak` |
| **Ürün Kalitesi ve Kusur** | `kalite, kumaş, ip, renk, soluk, kusur, bozuk, kötü, kalitesiz` |
| **Fiyat / İade ve Fatura İşlemleri**| `fiyat, iade, ücret, pahalı, fatura, ödeme, para, tutar` |
| **Müşteri Hizmetleri ve Destek** | `müşteri, destek, iletişim, cevap, telefon, temsilci, ilgisiz` |

---

## 📊 Çıktı Yapısı (`NlpAnalysisResult`)

```ts
export interface NlpAnalysisResult {
  hasComments: boolean;
  totalComments: number;
  topComplaint: { topic: string; count: number; percentage: number } | null;
  clusters: Array<{ topic: string; count: number; percentage: number }>;
  columnHeader: string | null;
}
```

Eğer aktif veri setinde yorum kolonu yoksa `hasComments: false` döner ve arayüzde yanıltıcı veri gösterilmesi engellenir.
