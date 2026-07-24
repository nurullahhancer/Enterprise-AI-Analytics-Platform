# Enterprise AI Analytics Platform

Enterprise AI Analytics Platform; kurumların CSV, JSON ve izinli REST kaynaklarından gelen verilerini güvenli biçimde tek analiz kapsamında topladığı, dashboard ve doğrulanabilir rapor ürettiği, gerçek ML analizi çalıştırdığı ve sonuçları isteğe bağlı yapay zekâ ile yorumlayabildiği çok kiracılı bir SaaS uygulamasıdır.

Production için kanonik uygulama proje kökündeki React/Vite arayüzü ile Express/PostgreSQL API'sidir. SQLite mevcut kurulumlar için yalnız geçiş kaynağı ve geliştirme alternatifi olarak desteklenir. `frontend/` altındaki Next.js arayüzü ve `backend/` altındaki .NET çözümü önceki mimari çalışmasının referans/test bileşenleridir; ana `docker-compose.yml` bunları production trafiğine çıkarmaz.

## Production mimarisi

```text
Tarayıcı -- HTTPS :443 --> Nginx
                              |
                              | yalnızca 127.0.0.1:3000
                              v
                    React SPA + Express API  ---->  PostgreSQL + zorunlu RLS
                              |
                              | yalnızca internal Docker ağı
                              v
                          FastAPI ML servisi
```

- Web/API: Node.js 22, Express, React 19, Vite, TypeScript
- Kalıcı veri: PostgreSQL 17 ve Docker named volume (`postgres-data`)
- ML: FastAPI, pandas, NumPy ve scikit-learn; dışarıya port yayınlanmaz
- Kimlik doğrulama: web için HttpOnly/Secure/SameSite oturum çerezi, mobil/API için 8 saatlik HS256 JWT, scrypt parola özeti ve token sürümleme
- Yetkilendirme: organizasyon üyeliğine bağlı `admin`, `analyst`, `viewer` rolleri; açık tenant filtresi ve PostgreSQL forced RLS
- İsteğe bağlı AI: Google Gemini; müşteri verisi ancak açık izin değişkeni de etkinse gönderilir
- İsteğe bağlı veri kaynağı: yalnızca allowlist ile sınırlandırılmış HTTPS/JSON REST konnektörü
- Mobil kabuk: Capacitor/Android; yalnız güvenilen HTTPS API ile ayrı build gerekir

## Temel özellikler

- Çalışma alanı oluşturan kayıt, giriş, davetle üyelik, e-posta doğrulama, tek kullanımlık parola yenileme ve hesap silme
- Organizasyon seçici, üye/davet/rol yönetimi ve organizasyon bazında veri izolasyonu
- Başlangıç/Profesyonel/Kurumsal plan limitleri, kalıcı aylık AI/ML sayaçları ve iyzico hosted subscription checkout
- CSV ve JSON yükleme, izinli REST kaynaklarından güncel anlık görüntü alma ve her veri setini analiz kapsamına ayrı ayrı dahil etme/çıkarma
- Analiz odağıyla uyumlu şemaları büyük/küçük harf duyarsız kolon eşleştirmesi ve `kaynak_dosya` lineage alanıyla birleştirme; farklı şemaları silmeden ayrı analiz gruplarında saklama
- Median doldurma, tip normalizasyonu ve IQR aykırı değer adımlarını içeren gerçek CSV ETL akışı
- ETL çıktısını analiz kapsamına alırken kaynak veri setlerini otomatik çıkararak orijinal+türetilmiş veri çift sayımını önleme
- Analiz Stüdyosu'nda hedef kolon ve 1–12 dönem ufuk seçimi; kronolojik holdout ile MAE/RMSE/R²/SMAPE, gelecek tahminleri, alt/üst aralıklar, anomaliler, segmentler ve veri kalitesi uyarıları
- Başarılı analizleri organizasyon bazında kalıcı saklama; doğrulanmış yapısal sonuçlardan AI yorumu ve aynı koşu için yeniden üretilebilir CSV raporu
- Veri destekli sohbette ham satır yerine sunucu tarafından hesaplanan profil, metrik ve son doğrulanmış analizleri kullanma
- CSV rapor dışa aktarma ve formül enjeksiyonu koruması
- PDF/TXT doküman ayrıştırma, pozitif eşleşmeli yerel parça araması ve kaynak/parça atıfları
- Şifreli REST konnektör yapılandırması ve SSRF korumalı veri alma
- REST ingest sırasında aynı bağlantının eski kopyalarını çoğaltmak yerine güncel anlık görüntüsünü yenileme
- Kullanıcıya ait audit kayıtları ve bildirimler
- Sağlık kontrolü, yapılandırılmış loglar ve Docker restart/log rotation ayarları

## Dizinler

| Yol | Amaç | Production durumu |
|---|---|---|
| `src/`, `server.ts` | Kanonik React/Express uygulaması | Etkin |
| `ml-service/` | İç ağdaki FastAPI analiz servisi | Etkin |
| `docker-compose.yml` | Kanonik production ve test profilleri | Etkin |
| `android/` | Capacitor Android kabuğu | İsteğe bağlı |
| `frontend/` | Statik Next.js referans arayüzü | Production dışı |
| `backend/` | .NET 8 referans API/temiz mimari çözümü | Production dışı |
| `infra/` | Eski/geniş referans servis topolojisi | Production dışı |
| `docs/` | Mimari karar kayıtları | Referans |

## Hızlı kurulum

Gereksinimler: Linux VDS, güncel Docker Engine ve Docker Compose v2.

```bash
cd /root/Enterprise-AI-Analytics-Platform
cp .env.example .env
chmod 600 .env
```

`.env` içinde en az aşağıdaki değerleri güvenli ve benzersiz değerlerle doldurun:

- `JWT_SECRET`: en az 32 karakterlik tahmin edilemez anahtar
- `DATA_ENCRYPTION_KEY`: 32 bayt base64 veya 64 karakter hex AES anahtarı
- `BOOTSTRAP_ADMIN_EMAIL`: ilk yönetici olacak e-posta
- `BOOTSTRAP_ADMIN_TOKEN`: ilk yönetici kaydını ayrıca yetkilendiren en az 32 karakterlik tek kullanımlık secret
- `APP_URL`: kullanıcının tarayıcıda açacağı tam adres
- `POSTGRES_PASSWORD`, `POSTGRES_APP_PASSWORD`, `DATABASE_URL`: ayrı yönetim ve `NOBYPASSRLS` uygulama rolleri

Gerçek anahtarları Git'e eklemeyin ve terminal/rapor çıktısına yazdırmayın.

İlk yönetici hesabı arayüzden oluşturulmaz; bootstrap e-postası için API ayrıca `X-Bootstrap-Token` ister. `ALLOW_PUBLIC_REGISTRATION=true` ile servisi başlatın ve isteği yalnız container içinden, localhost'tan veya geçerli HTTPS üzerinden gönderin. Aşağıdaki yöntem token'ı komut satırına ya da çıktıya koymaz; parola gizli olarak okunup container stdin'ine aktarılır:

```bash
docker compose up -d --build
read -rsp 'İlk admin parolası: ' INITIAL_ADMIN_PASSWORD
printf '\n'
printf '%s' "$INITIAL_ADMIN_PASSWORD" | docker compose exec -T app node -e '
let password = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => { password += chunk; });
process.stdin.on("end", async () => {
  const response = await fetch("http://127.0.0.1:3010/api/register", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Bootstrap-Token": process.env.BOOTSTRAP_ADMIN_TOKEN },
    body: JSON.stringify({ email: process.env.BOOTSTRAP_ADMIN_EMAIL, name: "İlk Yönetici", password })
  });
  const result = await response.json();
  console.log(response.status, result.message || result.error?.code);
  process.exit(response.ok ? 0 : 1);
});'
unset INITIAL_ADMIN_PASSWORD
# Başarılı kayıttan sonra .env içinde ALLOW_PUBLIC_REGISTRATION=false yapın
# ve BOOTSTRAP_ADMIN_TOKEN değerini kaldırın; ardından environment'ı yenileyin.
docker compose up -d
```

Bu VDS'deki erişim adresi `https://45.133.36.77`, sağlık kontrolü ise `https://45.133.36.77/api/health` adresidir. `http://45.133.36.77` kalıcı olarak HTTPS'e yönlenir; host portu `3000` yalnızca `127.0.0.1` üzerinde Nginx tarafından erişilebilir. Başka sunucuya kurulumda `APP_URL`, IP sertifikası ve `deploy/nginx/` altındaki yapılandırmalar o sunucunun IP/domain değerine uyarlanmalıdır.

> `JWT_SECRET` eksik veya geçersizse uygulama veritabanını ve sağlık endpoint'ini çalıştırır fakat giriş güvenli biçimde devre dışı kalır; `/api/health` HTTP 503 ve `degraded` döner, app container'ı hazır/healthy sayılmaz.

Kurulum, Nginx, yedekleme, rollback ve operasyon komutlarının tamamı için [DEPLOYMENT.md](DEPLOYMENT.md) dosyasına bakın.

## Roller

| İşlem | Admin | Analyst | Viewer |
|---|:---:|:---:|:---:|
| Dashboard/veri/rapor görüntüleme | Evet | Evet | Evet |
| CSV ve doküman yükleme | Evet | Evet | Hayır |
| ETL dönüşümü çalıştırma | Evet | Evet | Hayır |
| Mevcut veri üzerinde ML analizi | Evet | Evet | Evet |
| REST konnektörü oluşturma/silme | Evet | Hayır | Hayır |
| REST konnektöründen ingest | Evet | Evet | Hayır |
| Doküman silme ve rol yönetimi | Evet | Hayır | Hayır |

Kullanıcı rolü JWT içinden kabul edilmez; her istekte seçili organizasyonun güncel üyeliği kontrol edilir. Her organizasyonun son yöneticisi düşürülemez veya çıkarılamaz.

## Environment özeti

Eksiksiz ve secretsiz şablon `.env.example` dosyasındadır.

| Değişken | Açıklama |
|---|---|
| `APP_BIND_IP`, `APP_PORT`, `APP_URL` | Dış dinleme ve tarayıcı adresi |
| `ALLOWED_ORIGINS` | Virgülle ayrılmış ek CORS origin'leri |
| `TRUST_PROXY_HOPS` | Güvenilen reverse proxy atlama sayısı |
| `JWT_SECRET`, `JWT_ISSUER`, `JWT_AUDIENCE` | JWT güvenlik ayarları |
| `DATABASE_URL`, `POSTGRES_*` | PostgreSQL uygulama/yönetim rolleri ve bağlantı ayarları |
| `RESEND_API_KEY`, `EMAIL_FROM`, `REQUIRE_EMAIL_VERIFICATION` | İşlem e-postaları ve doğrulama zorunluluğu |
| `IYZICO_*` | Hosted abonelik, plan referansları ve V3 webhook doğrulaması |
| `ALLOW_PUBLIC_REGISTRATION` | Herkese açık kayıt anahtarı |
| `BOOTSTRAP_ADMIN_EMAIL`, `BOOTSTRAP_ADMIN_TOKEN` | İlk yönetici e-posta eşleşmesi ve ayrı kayıt yetkisi |
| `DATA_ENCRYPTION_KEY` | Konnektör ayarları için AES-256-GCM anahtarı |
| `REST_CONNECTOR_ALLOWED_HOSTS` | İzinli tam REST hostname listesi |
| `SQL_CONNECTOR_ALLOWED_HOSTS` | Salt-okunur PostgreSQL konektörleri için izinli tam hostname listesi |
| `GEMINI_API_KEY`, `ALLOW_EXTERNAL_AI_DATA` | İsteğe bağlı dış AI ve açık veri aktarım izni |
| `DATASET_SCHEMA_MIN_OVERLAP` | Aynı analiz grubuna alınacak kaynaklar için gereken asgari normalize kolon örtüşmesi |
| `ANALYSIS_RUN_MAX_PER_ORG`, `ANALYSIS_RUN_MAX_RESULT_CHARS` | Kalıcı analiz geçmişi adet ve sonuç boyutu sınırları |
| `MAX_*`, `JSON_BODY_LIMIT` | Veri/doküman/request üst sınırları |

## Doğrulama

Kanonik uygulama:

```bash
npm ci
npm run lint
npm test
npm run build
npm audit
```

Tüm container tabanlı test hedefleri:

```bash
docker compose --profile test build app-test ml-test backend-test reference-frontend-test
docker compose --profile test run --rm app-test
docker compose --profile test run --rm ml-test
docker compose --profile test run --rm backend-test
docker compose --profile test run --rm reference-frontend-test
```

Production sağlık ve log kontrolü:

```bash
docker compose ps
curl -fsS http://127.0.0.1:3000/api/health
docker compose logs --tail=200 app ml-service
```

Denetim sırasında çalıştırılan testlerin ve kalan sınırların ayrıntısı [SYSTEM_AUDIT.md](SYSTEM_AUDIT.md) dosyasındadır.

## Bilinen kapsam sınırları

- Bu dağıtım tek VDS üzerinde PostgreSQL kullanır; çok düğümlü yatay ölçekleme için ortak job/rate-limit katmanı ve yönetilen veritabanı gerekir.
- Analiz kapsamı uyumlu şemaların satır bazında birleşimini destekler; farklı tablolar arasında anahtar bazlı join veya kullanıcı tanımlı SQL henüz yoktur.
- PostgreSQL konnektörü exact-host allowlist, ayrı salt-okunur kullanıcı, SELECT/WITH doğrulaması, read-only transaction, timeout ve satır/kolon limitleriyle desteklenir.
- RAG, sözcüksel yerel metin parçası seçimi kullanır; embedding/vector tabanlı semantik arama production akışında yoktur.
- İşlem e-postası ve gerçek ödeme ancak ilgili Resend/iyzico hesap anahtarları sağlandığında etkinleşir; sandbox anahtarları repoda tutulmaz.
- Domain/DNS ve TLS sertifikası sunucu dışından sağlanmalıdır.
- İş kuyruğu ve saatlik AI hız sınırı process içidir; birden çok uygulama replikası veya restart dayanımı için Redis benzeri ortak katman gerekir.
- ML güven skoru kronolojik holdout hata ve veri derinliğinden türetilen bir doğrulama göstergesidir; kalibre olasılık ya da karar garantisi değildir. Kritik kullanımda kuruma özgü backtest ve model risk doğrulaması gerekir.
- Android cleartext trafiği kapalıdır. Mobil production build için `VITE_API_BASE_URL=https://...`, CORS'ta `https://localhost`, `npm run cap:sync`, cihaz E2E ve release signing gerekir; cihaz/store teslimi bu denetimin dışındadır.
