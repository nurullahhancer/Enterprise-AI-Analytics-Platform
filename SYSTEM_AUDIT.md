# Sistem Denetimi ve İyileştirme Raporu

**Proje:** Enterprise AI Analytics Platform

**Proje dizini:** `/root/Enterprise-AI-Analytics-Platform`

**Denetim tarihi:** 13 Temmuz 2026 (UTC)

**Production adayı:** Proje kökündeki React/Vite + Express + SQLite uygulaması

**Dağıtım modeli:** Tek VDS, Docker Compose, internal FastAPI ML servisi

## 1. Yönetici özeti

Depoda aynı ürün fikrini temsil eden fakat birbirine bağlı olmayan iki uygulama/topoloji bulunuyordu:

1. Proje kökündeki React/Vite + Express + SQLite uygulaması; gerçek kayıt/giriş, veri yükleme, dashboard, analiz, rapor, ETL ve enterprise ekranlarını içeriyordu.
2. `frontend/`, `backend/` ve `infra/` altındaki Next.js + .NET + çok servisli referans mimari; önemli bölümleri demo/in-memory davranışa sahipti ve kullanıcıya gösterilen ana iş akışını uçtan uca gerçekleştirmiyordu.

Koddan çıkarılan gerçek kullanıcı akışlarını en kapsamlı biçimde uygulayan birinci seçenek kanonik production uygulaması olarak seçildi. İkinci topoloji silinmedi; test ve mimari referans olarak korundu, fakat ana `docker-compose.yml` üzerinden internete açılmıyor.

Denetimde kritik kimlik doğrulama/yetkilendirme kusurları, düz metin konnektör ayarları, SSRF riski, sahte veri üreten akışlar, dışarıya açık altyapı portları, kalıcı olmayan/in-memory servis davranışları, zayıf parola özeti, güvensiz JWT varsayılanı ve üretim operasyon eksikleri tespit edildi. Kanonik uygulamada kritik bulgular giderildi; production image/Compose sertleştirildi ve otomatik testler genişletildi.

Sistem kod, container ve IP tabanlı HTTPS yapılandırması açısından production adayıdır. `https://45.133.36.77` geçerli Let's Encrypt IP sertifikasıyla yayındadır; HTTP yalnız HTTPS yönlendirmesi ve ACME doğrulaması için açıktır. Müşteri girişine açılmadan önce sunucu sahibinin benzersiz secret'ları sağlaması ve ilk yönetici hesabını oluşturması zorunludur.

## 2. Sistemin amacı

Sistem aşağıdaki kullanıcı senaryolarına hizmet eder:

- Bir kullanıcı hesabı oluşturmak ve rolüne göre oturum açmak
- CSV veri setlerini yüklemek, listelemek ve silmek; eski “aktif” işaretini liste/primary-delete uyumluluğu için korumak
- Kullanıcının bütün kayıtlı CSV'lerini dashboard, özet, ETL, ML, rapor ve veri destekli AI bağlamında birleştirmek
- Veri özeti, metrikler, grafikler ve otomatik içgörüler üretmek
- CSV üzerinde veri temizleme/dönüştürme adımları çalıştırmak
- Tahmin, anomali, kümeleme ve profil analizi yapmak
- PDF/TXT dokümanı okuyup yerel metin parçası aramasıyla AI bağlamı oluşturmak
- İsteğe bağlı Gemini entegrasyonu ile veri/doküman destekli sohbet yapmak
- Allowlist ile sınırlandırılmış bir HTTPS REST/JSON kaynağından veri almak
- CSV raporu dışa aktarmak
- Audit kayıtları ve bildirimleri görüntülemek
- Yönetici olarak konnektör ve kullanıcı rollerini yönetmek

Mevcut production kapsamı gerçek organizasyon üyeliğine sahip çok kiracılı SaaS değildir. Veri izolasyonu hesap/e-posta sahibine göre uygulanır.

## 3. Mimari yapı

### 3.1 Kanonik production akışı

```text
Kullanıcı tarayıcısı
        |
        | HTTPS :443 (geçerli IP sertifikası)
        v
Nginx reverse proxy
        |
        | 127.0.0.1:3000
        v
Node.js container :3010
  - React SPA statik build
  - Express REST API
  - JWT/RBAC
  - ETL ve rapor mantığı
        |
        +------> SQLite /app/data/reai.db (app-data volume)
        |
        +------> FastAPI ML :8000 (yalnızca internal Docker ağı)
        |
        +------> Gemini (opsiyonel, anahtar + açık veri izni gerekir)
        |
        +------> Allowlist HTTPS REST hostları (opsiyonel)
```

React SPA ve API aynı origin'den sunulur. Bu, production CORS alanını daraltır ve ayrı frontend/backend portu gerektirmez. ML servisi dış hosta port yayınlamaz.

### 3.2 Referans bileşenler

- `backend/`: .NET 8 Clean Architecture örneği ve testleri. Production kimlik sağlayıcısı/veritabanı entegrasyonu tamamlanmadığı için ana trafik yolu değildir.
- `frontend/`: Next.js statik referans dashboard. Kanonik React arayüzünden bağımsızdır.
- `infra/`: PostgreSQL, Redis, RabbitMQ, Qdrant, MLflow, Prometheus, Grafana ve Keycloak içeren eski/geniş topoloji. Tüm yayınlanan portlar localhost'a bağlanacak şekilde daraltılmıştır; ana production kurulumu değildir.
- `docs/ADR-*`: Önceki hedef mimariyi anlatır; çalışan kanonik uygulamanın birebir mevcut durumu olarak yorumlanmamalıdır.

## 4. Kullanılan teknolojiler

| Katman | Teknoloji |
|---|---|
| Web arayüzü | React 19, TypeScript, Vite 6, Tailwind CSS, Recharts |
| API | Node.js 22, Express 4, TypeScript |
| Kimlik | JWT HS256, Node `crypto` scrypt, Bearer token |
| Veritabanı | SQLite 3, WAL, named Docker volume |
| Dosya işleme | Multer, CSV parser, `pdf-parse` |
| ML servisi | Python 3.12, FastAPI, pandas, NumPy, scikit-learn |
| Opsiyonel AI | Google Gemini SDK |
| Mobil | Capacitor 8 / Android |
| Container | Docker, Docker Compose v2 |
| Test | Vitest, Supertest, pytest, Ruff, xUnit (.NET referans) |
| Loglama | Winston ve Docker `json-file` rotation |

## 5. Servisler ve portlar

### Production Compose

| Servis | Container portu | Host portu | Ağ | Kalıcılık |
|---|---:|---:|---|---|
| Nginx | 80/443 | 80/443 | Public; 80 yalnız redirect/ACME | Sertifika `/etc/letsencrypt` |
| `app` | 3010 | `127.0.0.1:3000` | `edge`, `backend` | `app-data:/app/data` |
| `ml-service` | 8000 | Yayınlanmaz | yalnızca internal `backend` | Model cache'i geçici |

Canlı `.env`, uygulama portunu `127.0.0.1:3000` ile sınırlar. Nginx `80` isteklerini sabit `https://45.133.36.77` adresine yönlendirir ve yalnız `443` üzerinden uygulamaya proxy olur. ML servisi host portu yayınlamaz.

`app-test`, `ml-test`, `backend-test` ve `reference-frontend-test` yalnızca `test` profiliyle çalışır ve production host portu yayınlamaz.

### Referans infra portları

`infra/docker-compose.yml` içindeki PostgreSQL 5432, Redis 6379, RabbitMQ 5672/15672, Qdrant 6333, MLflow 5001, Prometheus 9090, Grafana 3002, Keycloak 8081, .NET 5000, ML 8000 ve Next.js 3001 portlarının tamamı `127.0.0.1` ile sınırlandırılmıştır. Bu topoloji production için başlatılmamalıdır.

## 6. Veritabanı yapısı

Kanonik uygulama SQLite kullanır. Varsayılan dosya container içinde `/app/data/reai.db`, host tarafında Docker `app-data` named volume'üdür.

| Tablo | Amaç |
|---|---|
| `users` | E-posta, ad, scrypt parola özeti, rol, token sürümü |
| `user_datasets_v2` | CSV içerikleri, legacy/primary aktif işareti, satır/sütun metadatası |
| `user_connections` | AES-256-GCM ile şifrelenmiş REST konnektör ayarları |
| `user_documents` | PDF/TXT'den ayrıştırılan yerel metin ve parça sayısı |
| `audit_logs` | Kullanıcıya ait önemli işlem kayıtları |
| `organizations` | Gelecekteki organizasyon modeline ait sınırlı kayıtlar |
| `user_notifications` | Kullanıcı bildirimleri ve okundu durumu |

Başlangıçta tablolar ve indeksler idempotent olarak oluşturulur. Eski `datasets`/`user_datasets` içerikleri varsa `user_datasets_v2` tablosuna kopyalanır; kaynak tablolar silinmez. Her kullanıcı için tek legacy/primary aktif işareti normalize edilir; bu işaret analiz kapsamını filtrelemez. `foreign_keys`, 5 saniyelik busy timeout ve dosya veritabanında WAL etkinleştirilir.

Formal, sürüm numaralı bir migration framework'ü henüz yoktur. Bu nedenle schema değişikliği öncesi volume yedeği zorunludur.

## 7. Önemli iş akışları

### 7.1 İlk yönetici ve kullanıcı kaydı

1. Operatör `JWT_SECRET`, `DATA_ENCRYPTION_KEY`, `BOOTSTRAP_ADMIN_EMAIL` ve en az 32 karakterlik `BOOTSTRAP_ADMIN_TOKEN` değerlerini sağlar.
2. Kayıt geçici olarak `ALLOW_PUBLIC_REGISTRATION=true` ile açılır.
3. Bootstrap e-posta kaydı yalnız container/localhost/geçerli HTTPS üzerinden ve doğru `X-Bootstrap-Token` header'ıyla yapılır; UI bu secret'ı göndermez. Eşleşen kullanıcı `admin`, diğer yeni kullanıcılar `analyst` olur.
4. İlk hesap oluşturulduktan sonra açık kayıt kapatılır ve bootstrap token environment'dan kaldırılır.
5. Son yönetici rolünün düşürülmesi sunucu tarafından engellenir.

### 7.2 Oturum

- Parolalar en az 12 karakter, en az bir harf ve bir rakam içermelidir.
- Parola scrypt (`N=32768`, `r=8`, `p=1`) ile özetlenir.
- Eski PBKDF2 özeti yalnızca başarılı ilk girişte kabul edilir ve scrypt'e yükseltilir.
- Token; issuer, audience, subject, JTI ve token sürümü içerir, 8 saatte sona erer.
- Her korumalı istekte kullanıcı ve güncel rol veritabanından tekrar okunur.
- Parola değişikliği token sürümünü artırır ve yeni token döndürür.
- Çıkış endpoint'i token sürümünü artırır; kullanılan JWT sonraki istekte 401 olur, UI yerel token'ı her durumda temizler.
- Beş başarısız girişten sonra aynı IP/e-posta çifti; varsayılan 30 rezervasyondan sonra IP geneli 15 dakika sınırlandırılır. Sayaçlar process-içidir.

### 7.3 Veri ve analiz

1. `admin` veya `analyst`, en fazla 10 MB ve yapılandırılmış karakter sınırı içinde bir CSV yükler.
2. Sunucu dosyanın boş/ikili olmadığını ve en az bir başlık/veri satırı içerdiğini doğrular.
3. Yüklenen veri kullanıcıya bağlanır; yeni dosya legacy/primary aktif işaretini alır.
4. Dashboard, özet, ETL, ML, rapor ve veri destekli AI yalnız oturum sahibinin bütün CSV'lerini `kaynak_dosya` kolonu ile birleştirir; aktif işareti analiz filtresi değildir.
5. ETL dönüşümü orijinali değiştirmez; temizlenmiş sonucu yeni bir CSV veri seti olarak kaydeder. Bu sonuç da birleşik havuza girdiğinden olası orijinal+türetilmiş çift sayım operatörce yönetilmelidir.
6. FastAPI `/analyze` çağrısı internal Docker ağı üzerinden yapılır.

### 7.4 REST konnektörü

- Yalnızca `admin` konnektör oluşturabilir/silebilir; `admin` ve `analyst` ingest çalıştırabilir.
- Yalnızca HTTPS JSON GET kaynağı desteklenir.
- Host tam olarak `REST_CONNECTOR_ALLOWED_HOSTS` içinde olmalıdır.
- URL kullanıcı bilgisi, redirect, özel/loopback/link-local IP, DNS ile özel adrese çözülme, JSON dışı içerik, 10 saniyeyi aşan istek ve 2 MB'tan büyük cevap reddedilir.
- Ayarlar SQLite içinde AES-256-GCM ile şifrelenir; API cevabı hassas alanları döndürmez.
- Veri alınamazsa sahte başarı veya örnek veri üretilmez.

### 7.5 Doküman ve AI

- PDF magic header kontrol edilir; yalnızca PDF/TXT ve en fazla 10 MB yükleme kabul edilir.
- Metin `MAX_DOCUMENT_CHARS` ile sınırlandırılır ve liste uçları dokümanın tamamını istemciye döndürmez.
- Yerel parça seçimi, veri ve doküman bağlam sınırlarına uyar.
- Production'da Gemini çağrısı için hem `GEMINI_API_KEY` hem `ALLOW_EXTERNAL_AI_DATA=true` gerekir.
- API anahtarı yoksa tüm uygulama çökmez; yalnızca AI özelliği devre dışıdır.

## 8. Başlangıçta tespit edilen kritik sorunlar

| Öncelik | Bulgu | Temel neden / etki |
|---|---|---|
| Kritik | Çelişkili iki production adayı | README ve `infra` demo topolojiyi production gibi gösterirken gerçek kullanıcı akışı kök uygulamadaydı; yanlış servis dağıtımı riski vardı. |
| Kritik | Güvensiz varsayılan kimlik bilgileri | Seed edilmiş zayıf hesap ve kod içi JWT fallback'i hesap ele geçirmeye izin verebilirdi. |
| Kritik | Zayıf parola özeti | Eski PBKDF2 yalnızca 1.000 iterasyon kullanıyordu. |
| Kritik | Yetkinin istemciden kabul edilmesi | Roller fiilen admin'e sabitlenebiliyor/self-elevation yapılabiliyor, sunucu yazma uçlarında tutarlı RBAC uygulamıyordu. |
| Kritik | .NET demo girişi | Referans API parola doğrulamadan tenant/rol kabul ediyor ve in-memory veri kullanıyordu. |
| Yüksek | Konnektör secret'ları düz metin | Veritabanı sızıntısında konnektör bilgileri doğrudan açığa çıkabilirdi. |
| Yüksek | SSRF | Serbest REST URL'si local/private servisleri hedefleyebilirdi. |
| Yüksek | Sahte veri/sahte başarı | REST/SQL ve ETL hatalarında örnek/fixed veri üretilmesi gerçek kullanıcı sonucunu yanlış gösteriyordu. |
| Yüksek | Rapor API sözleşmesi bozuktu | İstemci var olmayan `/reports/export/download` yolunu çağırıyor; tahmin/kalite türleri gerçek veri yerine yanıltıcı placeholder CSV döndürüyordu. |
| Yüksek | Kimlik token'ının URL query'sinde taşınması | Rapor indirmede token; proxy, tarayıcı geçmişi ve loglara sızabilirdi. |
| Yüksek | Geniş CORS ve güvenlik header eksikleri | İstenmeyen origin erişimi ve tarayıcı tabanlı saldırı yüzeyi vardı. |
| Yüksek | Eski `xlsx` bağımlılığı | Bilinen ve düzeltilmemiş yüksek seviye güvenlik bildirimleri bulunuyordu. |
| Yüksek | Eksik hesap silme | Kullanıcı silindiğinde bağlı veri/konnektör/doküman/audit/bildirim kayıtları kalabiliyordu. |
| Yüksek | Açık altyapı portları | Veritabanı, cache, broker, gözlem ve yönetim servisleri `0.0.0.0` üzerinden erişilebiliyordu. |
| Orta | Gemini anahtarı zorunlu başlangıç koşuluydu | Opsiyonel entegrasyon yoksa tüm uygulama başlayamıyordu. |
| Orta | Dosya ve body sınırları tutarsızdı | Büyük/beklenmeyen veri bellek ve disk tüketimini artırabilirdi. |
| Orta | ML cache/loglama | Cache sınırsız büyüyebiliyor ve ham müşteri satırları loglanabiliyordu. |
| Orta | UI oturum geri yükleme ve hata yönetimi | Yenilemede oturum/rol durumu güvenilir biçimde doğrulanmıyor, bazı hatalar başarı gibi gösterilebiliyordu. |
| Orta | Restart, salt-okunur FS ve log rotation yoktu | Uzun süreli VDS işletiminde servis ve disk kararlılığı zayıftı. |

## 9. Yapılan düzeltmeler

### 9.1 Mimari ve production

- Kök React/Express/SQLite uygulaması kanonik production yolu olarak belirlendi.
- Node 22 Trixie tabanlı, çok aşamalı, non-root production Docker image eklendi.
- React build ve API tek image'da aynı origin üzerinden sunulur hale getirildi.
- FastAPI yalnızca internal Docker ağına alındı.
- `restart: unless-stopped`, read-only root filesystem, `cap_drop: ALL`, `no-new-privileges`, PID/CPU/RAM sınırları ve `tmpfs` eklendi.
- JSON log rotation (`10m`, 5 dosya) ve named SQLite volume eklendi.
- Nginx kuruldu; uygulama loopback'e alındı, HTTP→HTTPS yönlendirmesi ve TLS 1.2/1.3 reverse proxy etkinleştirildi.
- `45.133.36.77` için Let's Encrypt `shortlived` IP sertifikası alındı; Certbot timer ve yenileme sonrası güvenli Nginx reload hook'u kuruldu.
- Referans infra portları localhost'a kapatıldı; kalıcı volume'lar ve zorunlu parola değişkenleri tanımlandı.
- Daha önce çalışan geniş referans infra stack'i veri, container veya volume silinmeden durduruldu.
- ML image'ında runtime ve development bağımlılıkları ayrıldı, non-root kullanıcı kullanıldı.

### 9.2 Kimlik ve yetki

- Seed edilmiş varsayılan kullanıcı ve production JWT fallback'i kaldırıldı.
- Eksik JWT secret durumunda auth güvenli şekilde kapalı/degraded çalışır hale getirildi.
- scrypt parola özeti, timing-safe karşılaştırma ve eski hash yükseltmesi eklendi.
- JWT issuer/audience/algorithm/JTI/sona erme/token sürümü kontrolleri eklendi.
- Her istekte güncel kullanıcı/rol ve token sürümü doğrulandı.
- Rol tabanlı sunucu middleware'i tüm kritik yazma uçlarına uygulandı.
- Açık kayıt feature flag'e bağlandı; tam bootstrap e-posta eşleşmesine ek olarak constant-time doğrulanan ayrı token header'ı zorunlu kılındı.
- Login brute-force sınırı, güçlü parola ve normalize edilmiş e-posta/ad doğrulaması eklendi.
- Parola değişikliği mevcut parola doğrulamasına ve token rotasyonuna bağlandı.
- `/api/logout` token sürümünü artırarak mevcut JWT'yi sunucuda iptal eder hale getirildi.
- Hesap silme mevcut parola doğrulamasına ve ilişkili kullanıcı verilerinin temizlenmesine bağlandı.
- Son admin koruması ve self-role-switch kaldırılması eklendi.

### 9.3 Veri, ETL ve rapor

- Yalnızca CSV kabulü, 10 MB upload sınırı, karakter limiti, içerik ve minimum satır/sütun doğrulaması eklendi.
- Kullanıcı başına varsayılan 50 CSV/20 milyon karakter ve 50 doküman/2 milyon karakter kotası, transaction içindeki eşzamanlılık güvenli kontrollerle eklendi.
- Güvenlik bildirimi bulunan `xlsx` bağımlılığı kaldırıldı.
- Sahte sabit ETL çıktısı gerçek CSV dönüşümüne çevrildi; sonuç orijinali ezmeden yeni veri seti oluşturur.
- Çoklu veri seti ve kullanıcı izolasyonu testleri eklendi.
- CSV dışa aktarmada formül enjeksiyonu nötralize edildi.
- Rapor istemcisi gerçek `/reports/download` yoluyla eşleştirildi; dashboard, tahmin, içgörü ve kalite raporları kullanıcının birleşik CSV havuzundan üretilir, veri yoksa `404` döner.
- Rapor indirme token'ı query string'den kaldırıldı; yalnızca Bearer header kullanılır.
- Rapor türü ve satır sayısı sınırları eklendi.

### 9.4 Konnektör, SSRF ve AI

- Konnektör ayarları AES-256-GCM ile şifrelenir hale getirildi.
- Dış API yalnızca hassas olmayan konfigürasyon metadatasını döndürür.
- Tam hostname allowlist, HTTPS, DNS/IP sınıfı kontrolü, redirect yasağı, timeout, content-type ve cevap boyutu kontrolü eklendi.
- SQL konnektörü ve sahte fallback verileri müşteri akışından kaldırıldı.
- Doküman türü/magic header/boyut/içerik doğrulamaları ve metin bağlam limitleri eklendi.
- Qdrant/embedding varmış gibi görünen ifadeler kaldırıldı; gerçek davranış yerel parça araması olarak adlandırıldı.
- Dış AI veri aktarımı anahtarın yanı sıra açık production onayına bağlandı.

### 9.5 ML ve loglama

- ML request satır/sütun/hücre/metin sınırları eklendi.
- Cache LRU ve azami giriş sayısıyla sınırlandı.
- Büyük analizler için toplam 50 bekleyen, kullanıcı başına 3 çalışan ve 200 kayıtlık process-içi kuyruk; TTL ve çağrı timeout'u eklendi.
- Dış AI çağrısı kullanıcı başına varsayılan 20 istek/saat ile sınırlandı.
- Audit/bildirimler otomatik silinmeden kullanıcı başına 2.000/500 kayıt kotasıyla sınırlandı; kota dolunca ana işlem korunur ve warning yazılır.
- Tenant tanımları log/cache çıktısında hash'lenerek kullanıldı; ham satır logları kaldırıldı.
- Cache temizleme endpoint'i isteğe bağlı internal anahtarla korunabilir hale getirildi.
- MLflow yalnızca açık tracking URI ve kullanılabilir import olduğunda etkinleşir.
- HTTP logları method + path ile sınırlandı; secret, query ve ham müşteri verisi loglanmaz.
- Hata cevapları normalize edildi; ayrıntı sunucu logunda kontrollü tutuldu.
- Tahmin ekranı ve raporundaki yanıltıcı “doğruluk” ifadesi “heuristik uyum” olarak değiştirildi; yapay taban skor kaldırıldı.

### 9.6 Web ve mobil güvenlik

- Origin allowlist, CSP, frame, MIME, referrer, permissions, COOP/CORP ve HTTPS'te HSTS header'ları eklendi.
- `x-powered-by` kapatıldı; proxy güveni sayısal ve kapalı varsayılan yapıldı.
- UI oturumu `/api/me` üzerinden sunucuda tekrar doğrulanır hale getirildi.
- UI'daki rol değiştirme, tamamlanmamış plugin/tenant ve SQL konnektör seçenekleri kaldırıldı.
- Android backup ve cleartext trafik kapatıldı; paylaşılabilir file path cache raporlarıyla sınırlandı.

## 10. Güvenlik değerlendirmesi

| Kontrol | Son durum |
|---|---|
| Kaynak koda gömülü production secret | Kaldırıldı; `.env.example` yalnızca boş placeholder içerir |
| Parola saklama | scrypt + random salt; eski PBKDF2 girişte yükseltilir |
| JWT | Secret zorunlu, HS256 allowlist, issuer/audience/JTI/8 saat/token version |
| Authentication brute force | 5 deneme / 15 dakika / IP+e-posta (process içi) |
| Authorization / IDOR | Rol kontrolleri ve sorgularda oturum sahibinin e-postası |
| SQL injection | Değerler parametreli SQLite sorguları ile bağlanır |
| Command injection | Kullanıcı girdisi shell komutuna aktarılmaz |
| XSS | React escaping + CSP; kullanıcı içeriği doğrudan HTML olarak işlenmez |
| CSRF | Cookie tabanlı auth yok; Authorization Bearer kullanılır; CORS allowlist uygulanır |
| SSRF | HTTPS + exact host allowlist + DNS/private IP + redirect + boyut/timeout kontrolleri |
| Path traversal | Upload'lar memory storage ile işlenir, kullanıcı adıyla host yolu oluşturulmaz |
| Dosya yükleme | Tür, boyut, magic header, NUL ve içerik sınırları |
| Konnektör secret'ları | AES-256-GCM; public cevapta redaksiyon |
| Hassas loglar | Query/token/raw dataset/e-posta yerine sınırlı metadata veya hash |
| Debug/dev modu | Production image `NODE_ENV=production`; Vite middleware kapalı |
| Dışa açık port | Yalnız SSH 22, HTTP redirect/ACME 80 ve HTTPS 443; app 3000 loopback, ML internal |
| Container yetkileri | Non-root, read-only, capability yok, no-new-privileges |
| Dependency taraması | Kök/Next npm, Python pip-audit ve .NET NuGet taramaları 0 bulgu; `xlsx` kaldırıldı; CI audit/test işleri eklendi |
| Readiness | DB, internal ML veya auth eksikse `/api/health` HTTP 503 ve app container `unhealthy` |

### Güvenlik sınırları

- Login rate-limit bellektedir; container yeniden başladığında sayaç sıfırlanır ve birden çok replica arasında paylaşılmaz.
- Bearer token tarayıcı saklama alanında tutulur; başarılı bir XSS token etkisi yaratabilir. CSP riski azaltır fakat güvenli frontend geliştirme disiplini sürmelidir.
- Audit kayıtları kullanıcıya göre ayrıdır fakat kriptografik olarak değiştirilemez/harici SIEM'e aktarılmış değildir.
- Audit/bildirim otomatik retention silmesi yoktur; kota dolunca yeni ikincil kayıtlar durur. Onaylı arşiv/retention ve alarm prosedürü gerekir.
- Şifreleme anahtarı kaybedilirse mevcut konnektör ayarları çözülemez; key backup/rotation prosedürü operatör sorumluluğundadır.
- IP sertifikası yaklaşık altı günlük kısa ömre sahiptir; Certbot timer/deploy hook çalışmazsa hızlı sertifika süresi dolma riski vardır ve dış alarm gerekir.
- Host Ubuntu kurulumu eski paket seviyesindedir: simülasyonda 306 yükseltilebilir ve 14 bekletilen paket görülmüştür; OpenSSL, OpenSSH, glibc ve systemd gibi kritik paketler bakım penceresi, VDS snapshot'ı ve reboot/SSH geri dönüş planıyla güncellenmelidir.
- UFW etkin değildir ve sağlayıcı firewall'u hosttan doğrulanamamıştır. Gözlenen public dinleyiciler yalnız 22/80/443'tür; SSH portu ve konsol erişimi teyit edilmeden firewall etkinleştirilmemelidir.

## 11. Test sonuçları

| Bileşen / kontrol | Sonuç | Kapsam |
|---|---|---|
| Kök TypeScript lint/type-check | Başarılı | `tsc --noEmit` |
| Kök production build | Başarılı | Vite SPA + esbuild Express bundle |
| Kök Vitest/Supertest | **20/20 başarılı** | Health, kayıt/giriş/çıkış token iptali, geçerli-geçersiz bootstrap token, `/me`, viewer RBAC, multipart CSV CRUD/sıralama/aktif güncelleme, atomik son-admin/eşzamanlı SQLite yazımı, gerçek ETL ve dört rapor, CSV formül koruması, kullanıcı izolasyonu, birleşik çoklu dataset, forecast/profile |
| Kök npm audit | Başarılı | Yüksek/kritik bulgu yok; tüm npm audit sonucu 0 bulgu |
| FastAPI Ruff | Başarılı | `app` ve `tests` statik kontrolü |
| FastAPI pytest | **16/16 başarılı** | Health, predict, anomaly, cluster, analyze, aşırı sütun limiti ve tenant/parametre/period duyarlı cache anahtarı |
| Python pip-audit | Başarılı | FastAPI 0.139.0 / Starlette 1.3.1 ortamında 0 bilinen bulgu |
| .NET referans testleri | **15/15 başarılı** | Test environment kimlik/yetki ve referans işlevler |
| .NET NuGet audit | Başarılı | Runtime ve test bağımlılıklarında 0 bilinen bulgu |
| Next.js referans lint/build | Başarılı | Type-check ve optimize production build |
| Next.js referans npm audit | Başarılı | Production ve development bağımlılıklarının tamamında 0 bulgu |
| Ana Compose parse | Başarılı | `docker compose config --quiet` |
| Production runtime smoke | Kısmi/öngörülen fail-closed | HTTPS ana sayfa 200, HTTP 308, TLS zinciri/TLS 1.3 doğrulandı, dış IP:3000 reddedildi; DB+ML ok; gerçek JWT secret olmadığı için health HTTP 503/degraded ve app unhealthy |
| IP sertifikası yenileme | Başarılı | Certbot staging issuance ve `renew --dry-run --run-deploy-hooks` başarılı; timer enabled/active |
| Restart/kalıcılık | Başarılı | Kontrollü SIGTERM/checkpoint sonrası aynı SQLite volume/inode ve güvenli dosya izinleri korundu |

İlk root image denemesinde native SQLite/GLIBC uyumsuzluğu test sırasında yakalandı. Runtime tabanı Debian Trixie'ye alınarak image build ve test geçer hale getirildi; hata gizlenmedi.

Vite build çıktısında yaklaşık 795 KB JavaScript bundle için performans uyarısı vardır; build'i veya işlevi bozmaz, gelecekte route/component bazlı code splitting önerilir.

## 12. Doğrulanan kullanıcı senaryoları

- Uygulama ve `/api/health` endpoint'inin açılması
- Bootstrap secret yokken 503, yanlış token'da 403 ve doğru header ile admin rol ataması
- Geçerli kullanıcı girişi ve `/api/me` ile oturum doğrulama
- Çıkıştan sonra aynı JWT'nin yeniden kullanılamaması
- Hatalı giriş ve zayıf/geçersiz veri reddi
- Token olmadan korumalı endpoint'e erişimin reddi
- Viewer rolünün yazma işlemlerinden engellenmesi
- Kullanıcının kendi rolünü yükseltememesi
- CSV yükleme/listeleme ve bütün dosyaların birleşik analiz davranışı
- Yetkili CSV oluşturma, en yeni/aktif sıralama, aktif işareti güncelleme, silme ve geçersiz uzantıyı reddetme
- Bir kullanıcının diğer kullanıcının verisine erişememesi
- Gerçek ETL dönüşümü ve yeni veri seti oluşturulması
- Tahmin, gürültülü veri analizi ve profil üretimi
- CSV raporunda formül enjeksiyonu koruması
- ML health, analiz, limit ve cache senaryoları
- Production frontend ve server build'i
- Non-root/read-only container, yalnız app portunun yayını ve restart sonrası SQLite kalıcılığı

Gerçek e-posta, SMS, ödeme veya ücretli AI çağrısı yapılmadı. Harici Gemini ve müşteri REST servisi, gerçek anahtar/izin sağlanmadığı için güvenli devre dışı durum ve yerel doğrulamalar üzerinden değerlendirildi.

## 13. Kalan riskler ve eksik kapsam

### Müşteri açılışından önce zorunlu

1. Benzersiz `JWT_SECRET` sağlanmalı; aksi halde auth kapalı, health HTTP 503/degraded ve app container `unhealthy` durumundadır.
2. Benzersiz `DATA_ENCRYPTION_KEY` sağlanmalı; aksi halde konnektör oluşturma kapalıdır.
3. `BOOTSTRAP_ADMIN_EMAIL` ve `BOOTSTRAP_ADMIN_TOKEN` sağlanıp ilk admin güvenli header akışıyla oluşturulmalı; ardından public registration kapatılıp token kaldırılmalıdır.
4. Kısa ömürlü IP sertifikasının yenileme timer'ı ve sona erme tarihi dış izlemeyle alarm altına alınmalıdır.
5. Gerçek SQLite volume yedekleme takvimi ve off-site saklama uygulanmalıdır.
6. VDS snapshot/console erişimi bulunan planlı bakımda bekleyen Ubuntu güvenlik güncellemeleri uygulanmalı, reboot sonrası SSH/Nginx/Docker/HTTPS doğrulanmalıdır.
7. Sağlayıcı firewall veya onaylı UFW politikasıyla yalnız gerekli 22/80/443 portları izinli tutulmalıdır; SSH erişimini riske atan uzaktan firewall değişikliği yapılmamalıdır.

### Ürün/ölçek sınırları

- SQLite tek sunucu/tek writer içindir; yatay ölçek, HA ve yoğun eşzamanlı yazma için PostgreSQL'e kontrollü geçiş gerekir.
- In-memory login limiter ve ML iş kuyruğu replica/yeniden başlatma dayanımlı değildir; Redis benzeri ortak katman gerekir.
- Varsayılan 20 milyon karakterlik CSV havuzu dashboard/rapor/forecast isteklerinde yeniden parse edilir; global ağır endpoint concurrency limiti/load testi yoktur. Eşzamanlı büyük isteklerde CPU/RAM baskısı riski kalır.
- “Aktif” işareti birleşik analiz filtresi değildir; ETL çıktısı da havuza eklendiğinden seçim/lineage özelliği gelene kadar çift sayım operasyonel olarak yönetilmelidir.
- Audit/bildirim kotası dolunca yeni ikincil kayıtlar silinmez fakat yazılamaz; alarm, arşiv ve kullanıcı onaylı retention prosedürü henüz dış operasyon işidir.
- Formal migration sürüm tablosu/rollback script'i yoktur.
- Organizasyon üyeliği, tenant yöneticisi ve tenantlar arası veri paylaşımı tamamlanmamıştır; tenant oluşturma endpoint'i bilinçli olarak `501` döndürür.
- Parola sıfırlama, e-posta doğrulama ve MFA yoktur; e-posta sağlayıcısı olmadan güvenli biçimde tamamlanamaz.
- SQL konnektörü devre dışıdır.
- Qdrant/embedding tabanlı semantik RAG yoktur; yerel metin parçası seçimi kullanılır.
- ML regresyon metrikleri giriş/eğitim verisi üzerinde in-sample hesaplanır (`testRows=0`); “heuristik uyum” holdout doğruluğu veya kalibre olasılık değildir. Domain doğrulaması, backtest ve model risk yönetimi olmadan karar garantisi vermez.
- Dashboard veri listelerinde büyük veri için kapsamlı pagination/streaming yoktur.
- Merkezi metrik, alarm ve harici log/SIEM entegrasyonu production Compose'a eklenmemiştir.
- JS bundle code splitting ve uzun süreli performans testi yapılmalıdır.
- Android cleartext kabul etmez; trusted HTTPS API, `https://localhost` CORS, cihaz E2E, release signing ve store dağıtımı bu denetimin dışındadır.

### Referans topoloji

- .NET API ve Next.js arayüz kanonik production uygulaması değildir.
- Referans Keycloak `start-dev` kullanır ve production'a uygun değildir.
- Referans PostgreSQL/RabbitMQ/Qdrant/MLflow/Grafana/Prometheus yığını gereksiz kaynak tüketir; yalnızca ayrı geliştirme ortamında çalıştırılmalıdır.
- Referans bileşenler için dependency güncellemeleri CI üzerinden düzenli izlenmelidir.

## 14. Varsayımlar

- Domain bildirilmediği için erişim modeli `https://45.133.36.77` olarak kuruldu; Let's Encrypt IP sertifikası, HTTP yönlendirmesi ve otomatik yenileme kullanıldı.
- Tek VDS üzerinde tek uygulama replica'sı hedeflendi.
- Kök uygulamadaki gerçek ekranlar ve endpoint'ler ürün amacının kaynağı kabul edildi.
- Mevcut kullanıcı verilerinin silinmesine izin olmadığı için uyumluluk migration'ları kaynak tabloları koruyacak şekilde tasarlandı.
- Harici API anahtarları, DNS ve SMTP hesabı sağlanmadı.
- Organizasyon bazlı tam multi-tenancy yerine mevcut hesap bazlı izolasyon doğru mevcut kapsam kabul edildi.
- Referans topolojinin silinmesi istenmediği için dosyalar korundu ve yalnızca production dışı olarak işaretlendi.

## 15. Değişiklik kapsamı

Başlıca değişiklik alanları:

- Kök production: `Dockerfile`, `docker-compose.yml`, `.dockerignore`, `.env.example`, `deploy/nginx/*`, `deploy/certbot-reload-nginx`
- API/güvenlik: `server.ts`, `src/lib/auth.ts`, `src/lib/db.ts`, `src/lib/secrets.ts`, `src/lib/safeFetch.ts`
- İş akışları: `src/server/routes/*`, `src/server/etl/*`, `src/server/ml/*`
- Web UI: `src/App.tsx`, `src/views/*`, `src/lib/api.ts`, `src/types.ts`
- ML: `ml-service/Dockerfile`, requirements, `app/main.py`, testler
- Referans test/izolasyon: `backend/*`, `frontend/*`, `infra/docker-compose.yml`
- Mobil: Android manifest/file paths ve Capacitor production güvenlik ayarları
- CI/test: `.github/workflows/ci.yml`, `server.test.ts`
- Dokümantasyon: `README.md`, `DEPLOYMENT.md`, `SYSTEM_AUDIT.md`

## 16. Sonuç

Kritik sahte davranışlar ve auth/RBAC/SSRF/secret/port açıklıkları giderilmiş, kanonik uygulama belirlenmiş, production container sertleştirilmiş ve ana iş akışları otomatik testlerle doğrulanmıştır. Kanonik Compose yığını VDS'de `https://45.133.36.77/` adresinde geçerli IP sertifikasıyla çalışmaktadır; `3000` yalnız loopback'te, ML yalnız internal ağdadır. Gerçek auth secret'ı olmadığı için app bilinçli olarak HTTP 503/degraded ve `unhealthy`; login kapalıdır.

Sistem şu şartlar tamamlanmadan “müşteriye açık ve tam teslim” sayılmamalıdır: gerçek secret'ların sağlanması, token'lı ilk admin kaydı, yedekleme takvimi, sertifika sona erme alarmı ve kimlikli dış erişim smoke testi. Domain artık teknik engel değildir. Ayrıntılı operasyon adımları `DEPLOYMENT.md` içindedir.
