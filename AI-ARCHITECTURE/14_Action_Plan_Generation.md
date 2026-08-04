# 14 - Aksiyon Planı Üretimi (Action Plan Generation)

## 🎯 Veriden Aksiyona Dönüşüm Mimarisi

Platformun temel amacı yalnızca durum tespiti yapmak değil, her tespit için somut bir aksiyon planı üretmektir.

---

## ⚡ Aksiyon Planı Türetim Mantığı

```
BI Engine Risk Sinyali  --->  Öncelik Derecelendirme (CRITICAL / WARNING)  --->  Veriye Dayalı Kanıt  --->  Somut Aksiyon Önerisi
```

- **Örnek Risk**: Stok Tükenme Uyarısı (SKU-8492)
- **Veriye Dayalı Kanıt**: "Günlük 6 adet satış hızına göre stok 5 gün içinde tükenecektir."
- **Önerilen Aksiyon**: "Tedarikçiye acil en az 180 adetlik sipariş oluşturun ve teslimat süresini teyit edin."
