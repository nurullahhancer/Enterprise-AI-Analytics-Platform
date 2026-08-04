# 23 - Kodlama Standartları (Coding Standards)

## 🧹 Kod Kalitesi ve Tasarım İlkeleri

1. **Tip Güvenliği (Strict TypeScript)**: Tüm frontend ve backend kodları açık tiplerle (`interfaces`, `types`) yazılır, `any` kullanımından kaçınılır.
2. **Modüler Yapı**: Ağır hesaplamalar controller/route dosyalarına konulmaz; pure fonksiyon olarak `pipeline.ts` veya `engine.ts` içerisine yazılır.
3. **Hata Yönetimi (Error Handling)**: Özel hata sınıfları (`StorageQuotaError`, `MlServiceError`) kullanılır ve standart JSON hatası döndürülür.
