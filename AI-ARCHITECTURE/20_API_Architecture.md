# 20 - API Mimarisi (API Architecture)

## 🌐 Express REST API Rotaları Haritası (`src/server/routes/`)

| Rota Yolu | HTTP Metodu | Açıklama |
|---|---|---|
| `/api/auth` | POST | Kullanıcı girişi, kayıt ve JWT token yenileme. |
| `/api/dataset/list` | GET | Kullanıcı veri setlerini listeler. |
| `/api/upload` | POST | Yeni CSV/JSON/XLSX dosyası yükler. |
| `/api/dashboard/dynamic` | GET | Dinamik dashboard, NLP yorum ve BI verilerini getirir. |
| `/api/ml/forecast` | GET/POST | Zaman serisi tahmini yürütür. |
| `/api/kpi` | GET/POST | Dinamik KPI'ları yönetir ve hesaplar. |
| `/api/enterprise/connections`| GET/POST | Harici veritabanı bağlantılarını yönetir. |
| `/api/chat` | POST | AI Chat asistanı ile etkileşim kurar. |
