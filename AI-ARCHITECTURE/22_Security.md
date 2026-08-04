# 22 - Güvenlik ve Yetkilendirme (Security)

## 🔒 Güvenlik Mimarisi

Enterprise AI Analytics Platform kurumsal seviyede güvenlik standartlarını uygular:

1. **JWT ve Token Rotasyonu**: Kısa ömürlü access token'lar ve güvenli refresh token rotasyonu.
2. **PostgreSQL Row-Level Security (RLS)**: Veritabanı seviyesinde `organization_id` izolasyonu ile kiracılar arası veri sızıntısı engellenir.
3. **Rol Tabanlı Erişim (RBAC)**: `admin`, `analyst` ve `viewer` rolleri ile yetkilendirme kontrolü.
4. **AES-256 Şifreleme**: Hassas veriler ve veritabanı bağlantı parolaları şifrelenerek saklanır.
5. **Audit Logging**: Kritik tüm işlemler audit log tablosuna kaydedilir.
