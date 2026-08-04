# 17 - Güven Skoru Sistemi (Confidence System)

## 🎯 İstatistiksel Güven Skoru Mimarisi (`linearConfidence`)

Platformda sunulan tüm tahminlerin ve ML modellerinin yanında bir **Güven Skoru (Confidence Score %)** yer alır.

---

## 🧮 Hesaplama Formülü (`src/server/ml/pipeline.ts`)

```ts
function linearConfidence(values: number[]): number {
  // Lineer regresyon eğimi ve hata kareler ortalamasının kökü (RMSE) hesaplanır
  // Ortalama değere göre hata oranı ne kadar düşükse güven skoru o kadar yüksek (%35 ile %95 arası) olur.
}
```

- **Yüksek Güven (%80 - %95)**: Düşük varyans ve düzenli eğilim gösteren veriler.
- **Orta Güven (%60 - %79)**: Sezonluk veya hafif gürültülü veriler.
- **Düşük Güven (%35 - %59)**: Yüksek gürültülü veya yetersiz satır içeren veriler.
