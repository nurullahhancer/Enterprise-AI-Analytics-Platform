# Production Kurulum ve Operasyon Rehberi

Bu belge proje kökündeki kanonik React/Vite + Express + SQLite uygulamasının tek bir Linux VDS üzerinde Docker Compose ile kurulmasını ve işletilmesini anlatır. `infra/docker-compose.yml` içindeki geniş referans topoloji production kurulumu değildir.

## 1. Gereksinimler

- 64-bit Linux VDS
- En az 2 vCPU, 4 GB RAM ve uygulama verisi için yeterli disk
- Docker Engine ve Docker Compose v2
- Git
- Kullanıcı erişimi için açık 80/443 portları ve çalışan Nginx reverse proxy
- IP ile HTTPS kullanılacaksa IP sertifikasını destekleyen Certbot 5.4 veya üzeri; domain kullanılacaksa doğru A/AAAA DNS kaydı
- Güvenli bir secret/parola yöneticisi

Sürüm kontrolü:

```bash
docker --version
docker compose version
git --version
systemctl is-enabled docker
systemctl is-active docker
```

Docker servisinin sunucu açılışında etkin olması gerekir. Etkin değilse, yetkili operatör normal bakım prosedürüyle `systemctl enable --now docker` çalıştırabilir. SSH veya firewall ayarlarını bu uygulama kurulumu uğruna kapatmayın/değiştirmeyin.

## 2. Dizin ve dosya izinleri

Bu sunucudaki proje yolu:

```bash
cd /root/Enterprise-AI-Analytics-Platform
```

Environment dosyasını oluşturun:

```bash
cp .env.example .env
chmod 600 .env
```

`.env` hiçbir zaman Git'e commit edilmemeli, ekran görüntüsüne veya destek kaydına eklenmemelidir. Secret değerlerini terminalde `echo`, `docker compose config` veya process argümanı ile yazdırmayın. Compose doğrulamasında yalnızca `docker compose config --quiet` kullanın.

## 3. Environment değişkenleri

### 3.1 Zorunlu production değerleri

| Değişken | Beklenen değer | Not |
|---|---|---|
| `APP_URL` | Tam HTTPS kullanıcı adresi | Bu VDS'de `https://45.133.36.77`; domain'de `https://DOMAIN` |
| `JWT_SECRET` | En az 32 tahmin edilemez karakter | Benzersiz olmalı; değiştirilmesi tüm token'ları geçersiz kılar |
| `DATA_ENCRYPTION_KEY` | 32 bayt base64 veya 64 hex karakter | AES-256-GCM konnektör şifreleme anahtarı; kaybı mevcut ayarları okunamaz yapar |
| `BOOTSTRAP_ADMIN_EMAIL` | İlk admin'in normalize e-postası | Yalnızca tam eşleşen yeni kayıt admin olur |
| `BOOTSTRAP_ADMIN_TOKEN` | En az 32 tahmin edilemez karakter | İlk admin kaydında `X-Bootstrap-Token` ile sunulur; işlemden sonra kaldırılır |

Anahtarları güvenli parola yöneticisinde/secret vault'ta kriptografik rastgele ürettirin. Bu depoda gerçek anahtar veya varsayılan production parolası yoktur.

### 3.2 Ağ ve proxy

| Değişken | Varsayılan | Kullanım |
|---|---|---|
| `APP_BIND_IP` | `127.0.0.1` | Production reverse proxy arkasında loopback'te bırakın |
| `APP_PORT` | `3000` | Host tarafındaki uygulama portu |
| `ALLOWED_ORIGINS` | boş | `APP_URL` dışındaki tam origin'ler, virgülle ayrılır |
| `TRUST_PROXY_HOPS` | `1` | Aynı hosttaki tek Nginx için; proxy yoksa `0` yapın |
| `JWT_ISSUER` | `reai-platform` | Token issuer; yayın sonrası sebepsiz değiştirmeyin |
| `JWT_AUDIENCE` | `reai-web` | Token audience; yayın sonrası sebepsiz değiştirmeyin |

Origin; şema, hostname ve port birlikte tam eşleşmelidir. Wildcard kullanmayın.

### 3.3 Kayıt ve ilk yönetici

| Değişken | Güvenli değer | Açıklama |
|---|---|---|
| `ALLOW_PUBLIC_REGISTRATION` | `false` | Yalnızca ilk kullanıcı veya kontrollü kayıt penceresinde geçici olarak `true` |
| `BOOTSTRAP_ADMIN_EMAIL` | Operatörün seçtiği e-posta | Bu e-postayla ilk kez kaydolan hesap admin olur |
| `BOOTSTRAP_ADMIN_TOKEN` | En az 32 karakterlik tek kullanımlık secret | UI göndermez; yalnız bootstrap API isteği için kullanılır |

İlk kurulum akışı:

1. Secret yöneticisinde `BOOTSTRAP_ADMIN_EMAIL` ve `BOOTSTRAP_ADMIN_TOKEN` belirleyin.
2. `ALLOW_PUBLIC_REGISTRATION=true` yapıp uygulamayı başlatın.
3. Bootstrap isteğini yalnız container içinden, localhost/SSH tünelinden veya geçerli HTTPS üzerinden gönderin. UI token header'ını bilerek göndermez.
4. Aşağıdaki komut parolayı gizli okur, container stdin'ine verir ve bootstrap token'ını terminale/process argümanına çıkarmaz:

```bash
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
```

5. Normal giriş yapıp rolün `admin` olduğunu doğrulayın.
6. `.env` içinde `ALLOW_PUBLIC_REGISTRATION=false` yapın ve `BOOTSTRAP_ADMIN_TOKEN` değerini kaldırın.
7. `docker compose up -d app` ile environment'ı yenileyip yeni kayıtların kapalı olduğunu doğrulayın.

Admin hesabı oluşmadan public registration'ı açık bırakmayın.

### 3.4 Opsiyonel AI sağlayıcısı

| Değişken | Varsayılan | Açıklama |
|---|---|---|
| `AI_PROVIDER` | `auto` | `nvidia`, `gemini` veya anahtara göre otomatik seçim |
| `NVIDIA_API_KEY` | boş | NVIDIA NIM/OpenAI uyumlu sohbet servisi anahtarı |
| `NVIDIA_AI_MODEL` | `meta/llama-3.1-8b-instruct` | NVIDIA model adı |
| `GEMINI_API_KEY` | boş | Geriye dönük Gemini servis anahtarı |
| `GEMINI_AI_MODEL` | `gemini-2.5-flash` | Gemini model adı |
| `ALLOW_EXTERNAL_AI_DATA` | `false` | Müşteri verisinin dış AI servisine gönderimine açık yönetici izni |
| `AI_REQUEST_TIMEOUT_MS` | `30000` | Harici AI istek zaman aşımı |
| `AI_MAX_OUTPUT_TOKENS` | `1024` | Yanıt token limiti |

Servis anahtarı ve `ALLOW_EXTERNAL_AI_DATA=true` birlikte etkin değilse AI çağrısı yapılmaz. Müşteri sözleşmesi, veri sınıflandırması ve sağlayıcı koşulları incelenmeden harici AI sağlayıcısına gerçek müşteri verisi göndermeyin.

### 3.5 REST konnektörü

`REST_CONNECTOR_ALLOWED_HOSTS`, şema veya yol içermeyen tam hostname'lerden oluşan virgülle ayrılmış listedir. Örneğin yalnızca kuruma ait API hostları eklenmelidir. Wildcard, IP, localhost, `.local` ve `.internal` hostları kullanmayın.

`SQL_CONNECTOR_ALLOWED_HOSTS` salt-okunur PostgreSQL konektörlerinin erişebileceği tam hostname listesidir. Her kaynakta yalnızca SELECT yetkisi verilmiş ayrı bir veritabanı kullanıcısı oluşturun; uygulama ayrıca sorguyu salt-okunur transaction, 20 saniye ve 10.000 satır sınırıyla çalıştırır. Platformun kendi `postgres` servisini bu listeye eklemeyin.

Production konnektörü yalnızca HTTPS GET/JSON kullanır; redirect, private/link-local hedef, 10 saniyeyi aşan istek ve 2 MB'tan büyük cevap reddedilir.

### 3.6 Limitler ve internal ML

| Değişken | Varsayılan | Açıklama |
|---|---:|---|
| `MAX_DATASET_COUNT` | 50 | Kullanıcı başına veri kaynağı sayısı |
| `MAX_DATASET_CONTEXT_CHARS` | 100.000 | AI prompt'una alınan veri bağlamı |
| `DATASET_UPLOAD_TMP_DIR` | `/app/data/dataset-uploads` | Büyük veri yüklemelerinin işlendiği geçici disk dizini |
| `MAX_RAG_CONTEXT_CHARS` | 40.000 | Doküman destekli AI bağlamı |
| `MAX_DOCUMENT_CHARS` | 500.000 | Ayrıştırılmış doküman metni sınırı; üst kod sınırı 1.000.000 |
| `MAX_DOCUMENT_TOTAL_CHARS` / `MAX_DOCUMENT_COUNT` | 2.000.000 / 50 | Kullanıcı başına toplam doküman metni ve dosya sayısı |
| `ML_ANALYZE_ASYNC_THRESHOLD_CHARS` | 1.000.000 | Bu boyuttan büyük birleşik CSV analizini sınırlı process-içi kuyruğa alır |
| `ML_JOB_MAX_QUEUE` / `ML_JOB_MAX_PER_USER` | 50 / 3 | Bekleyen toplam iş ve kullanıcı başına eşzamanlı iş sınırı |
| `ML_JOB_MAX_RECORDS` / `ML_JOB_TTL_MS` | 200 / 1.800.000 | Tutulan iş kaydı ve tamamlanmış iş ömrü |
| `ML_JOB_TIMEOUT_MS` | 60.000 | Bir internal ML çağrısının azami süresi |
| `LOGIN_IP_MAX_ATTEMPTS` | 30 | IP başına 15 dakikalık giriş rezervasyon sınırı; IP+e-posta sınırı ayrıca 5'tir |
| `AI_REQUESTS_PER_HOUR` | 20 | Kullanıcı başına dış AI çağrısı/saat |
| `AUDIT_MAX_ENTRIES_PER_USER` | 2.000 | Kullanıcı başına audit kayıt kotası; liste son 200 kaydı döndürür |
| `NOTIFICATION_MAX_ENTRIES_PER_USER` | 500 | Kullanıcı başına bildirim kotası; liste son 100 kaydı döndürür |
| `JSON_BODY_LIMIT` | `1mb` | Express JSON body sınırı |
| `ML_CACHE_MAX_ENTRIES` | 256 | FastAPI LRU cache üst sınırı |
| `ML_INTERNAL_API_KEY` | boş | Internal ML cache yönetim endpoint'i için isteğe bağlı anahtar |
| `LOG_LEVEL` | `info` | Uygulama log seviyesi |

`PORT=3010`, `DB_PATH=data/reai.db` ve `ML_SERVICE_URL=http://ml-service:8000` Compose içinde production topolojisine sabitlenmiştir. Normal VDS kurulumunda değiştirmeyin.

Login/AI sayaçları ve ML kuyruğu process-içidir; restart ile sıfırlanır ve birden çok replica arasında paylaşılmaz. Kuyruk doluluğu `429 ML_QUEUE_FULL` üretir. Kurum yöneticisi 30-3650 günlük veri saklama politikasını etkinleştirebilir; günlük zamanlayıcı yalnız analiz/KPI/senkronizasyon/bildirim/audit geçmişini temizler, ham veri ve dokümanları otomatik silmez. Kota ve retention alarmları operasyon ekibi tarafından izlenmelidir.

Dashboard, özet, ETL, ML, rapor ve veri destekli AI kullanıcının kayıtlı bütün CSV'lerini `kaynak_dosya` bilgisiyle birleştirir. “Aktif” işareti analiz filtresi değildir. ETL çıktıları aynı havuza eklendiği için orijinal ve türetilmiş satırların çift sayılmasını ürün/operasyon katmanı yönetmelidir.

`VITE_API_BASE_URL` yalnızca ayrı origin/mobil build için build-time değerdir. Aynı-origin web production kurulumunda boş bırakılır. Android cleartext trafik kabul etmez; mobil build'de güvenilen `VITE_API_BASE_URL=https://...`, `ALLOWED_ORIGINS=https://localhost` ve `npm run cap:sync` gerekir. Cihaz E2E, release signing ve store yayını ayrı teslimat işleridir.

## 4. Yapılandırma doğrulama

Secret değerlerini göstermeden syntax kontrolü:

```bash
docker compose config --quiet
```

Git ve dosya durumu:

```bash
git status --short
git rev-parse --short HEAD
test -f .env
test "$(stat -c %a .env)" = "600"
```

`docker compose config` komutunu `--quiet` olmadan destek kaydına yapıştırmayın; çözülmüş secret'ları içerebilir.

## 5. Build ve test

### 5.1 Container tabanlı doğrulama

Production image'ları oluşturun:

```bash
docker compose build app ml-service
```

Test profili:

```bash
docker compose --profile test build app-test ml-test backend-test reference-frontend-test
docker compose --profile test run --rm app-test
docker compose --profile test run --rm ml-test
docker compose --profile test run --rm backend-test
docker compose --profile test run --rm reference-frontend-test
```

Referans `.NET` ve Next.js test hedefleri production'da başlatılmaz; yalnızca regresyon kontrolüdür.

### 5.2 Host üzerinde geliştirme doğrulaması

Node.js 22 kurulu geliştirme ortamında:

```bash
npm ci
npm run lint
npm test
npm run build
npm audit --audit-level=high
```

Production VDS'de hosta Node/Python bağımlılıkları kurmak zorunlu değildir; Docker testleri tercih edilir.

## 6. Veritabanı ve migration

Ayrı bir migration komutu yoktur. Uygulama başlangıçta schema'yı idempotent olarak hazırlar ve eski dataset tablolarından yeni `user_datasets_v2` tablosuna veri kopyalar. Eski tabloları silmez.

Mevcut veri bulunan her güncellemeden önce bölüm 12'deki tutarlı SQLite yedeğini alın. Uygulama başlangıcını sonra gerçekleştirin:

```bash
docker compose up -d app ml-service
docker compose logs --tail=100 app
```

Logda veritabanı bağlantı/DDL hatası varsa deployment'ı başarılı saymayın. Production veritabanında elle `DROP`, `DELETE`, `VACUUM INTO` veya geri dönüşü olmayan schema komutu çalıştırmayın.

## 7. Başlatma

İlk veya güncellenmiş kurulum:

```bash
docker compose up -d --build
docker compose ps
```

Container'ların sağlıklı olmasını bekleyin, ardından:

```bash
curl -fsS http://127.0.0.1:3000/api/health
docker compose exec -T app node -e "fetch('http://127.0.0.1:3010/api/health').then(async r=>{const b=await r.json();console.log(r.status,b.status,b.checks);process.exit(r.ok&&b.status==='ok'&&b.checks.database==='ok'&&b.checks.mlService==='ok'&&b.checks.authentication==='ok'?0:1)}).catch(()=>process.exit(1))"
```

Sağlık cevabı:

- `status: ok`: SQLite, internal ML ve authentication hazırdır.
- HTTP 503 + `status: degraded`, `authentication: configuration-required`: `JWT_SECRET` yok/geçersizdir; giriş bilinçli olarak kapalıdır.
- `ai: optional-key-missing`: hata değildir; opsiyonel AI anahtarı verilmemiştir.
- HTTP 503 / `database: error` veya `mlService: error`: uygulama hazır değildir.

Container healthcheck readiness HTTP durumunu kontrol eder. Veritabanı, internal ML veya authentication yapılandırmasından biri eksikse app `unhealthy` olur; bu bilinçli fail-closed davranıştır. Teslimatta JSON içindeki tüm kritik kontroller de yukarıdaki komutla doğrulanmalıdır.

## 8. Durdurma ve yeniden başlatma

Tüm kanonik servisler:

```bash
docker compose stop
docker compose start
docker compose restart
```

Tek servis:

```bash
docker compose restart app
docker compose restart ml-service
```

Environment veya image değiştiğinde yalnızca restart yetmez; container'ı güvenli biçimde yeniden oluşturun:

```bash
docker compose up -d --build app ml-service
```

`docker compose down -v` çalıştırmayın. `-v`, kalıcı `app-data` volume'ünü ve müşteri verisini silebilir.

Compose servislerinde `restart: unless-stopped` vardır. Docker daemon sunucu açılışında çalışıyorsa beklenmeyen çökme ve VDS reboot sonrasında container'lar yeniden başlar. Bir container elle `stop` edilmişse `unless-stopped` nedeniyle reboot sonrası kapalı kalabilir; bakım sonunda `docker compose start` çalıştırın.

## 9. Servis ve kalıcılık doğrulaması

```bash
docker compose ps
docker compose exec -T app id
docker compose exec -T app node -e "const fs=require('fs');const s=fs.statSync('/app/data/reai.db');console.log({databaseBytes:s.size,mode:(s.mode&511).toString(8)})"
docker compose restart app ml-service
docker compose ps
curl -fsS http://127.0.0.1:3000/api/health
```

Yeniden başlatma öncesi ve sonrası yalnızca dosya boyutu/metadatasını karşılaştırın; kullanıcı verisini terminale yazdırmayın. Uygulama içinden daha önce oluşturulmuş test kaydının/veri setinin halen göründüğünü doğrulamak kalıcılık kanıtıdır.

Hostta yalnızca beklenen portların dinlediğini kontrol edin:

```bash
ss -lntp
docker ps --format 'table {{.Names}}\t{{.Ports}}\t{{.Status}}'
```

Firewall'ı kapatmayın. Reverse proxy yoksa yalnızca seçilen app portunu; proxy varsa 80/443'ü erişime açın ve app portunu loopback'e bind edin. SSH kuralını değiştirmeyin.

## 10. Loglar

Canlı log:

```bash
docker compose logs -f --tail=200 app ml-service
```

Servis bazında son kayıtlar:

```bash
docker compose logs --since=30m --tail=500 app
docker compose logs --since=30m --tail=500 ml-service
```

Container durum/health bilgisi:

```bash
docker inspect --format '{{json .State.Health}}' enterprise-ai-app-1
docker inspect --format '{{json .State.Health}}' enterprise-ai-ml-service-1
```

Container adları Compose sürümüne/proje adına göre değişebilir; kesin adı `docker compose ps` ile bulun.

Docker `json-file` logları her servis için 10 MB ve en fazla 5 dosyayla sınırlandırılmıştır. Logları paylaşmadan önce token, e-posta, URL query veya müşteri verisi bulunmadığını kontrol edin.

## 11. Nginx, IP HTTPS ve sertifika yenileme

Bu VDS, domain olmadan tarayıcıların güvendiği Let's Encrypt IP sertifikasıyla çalışır:

```dotenv
APP_BIND_IP=127.0.0.1
APP_PORT=3000
APP_URL=https://45.133.36.77
ALLOWED_ORIGINS=
TRUST_PROXY_HOPS=1
```

Canlı Nginx kaynağı [deploy/nginx/enterprise-ai-ip-https.conf](deploy/nginx/enterprise-ai-ip-https.conf), ilk sertifika alma yapılandırması ise [deploy/nginx/enterprise-ai-ip-bootstrap.conf](deploy/nginx/enterprise-ai-ip-bootstrap.conf) dosyasındadır. Kurulu yollar:

```text
/etc/nginx/sites-available/enterprise-ai
/etc/nginx/sites-enabled/enterprise-ai
/var/www/letsencrypt/.well-known/acme-challenge/
/etc/letsencrypt/live/45.133.36.77/fullchain.pem
/etc/letsencrypt/live/45.133.36.77/privkey.pem
```

HTTP portu yalnız ACME doğrulaması ve `308` HTTPS yönlendirmesi için açıktır. Uygulama portu dış IP'de dinlemez. Beklenen dinleyiciler `22` (SSH), `80` (redirect/ACME), `443` (HTTPS) ve yalnız loopback'te `127.0.0.1:3000` şeklindedir.

Let's Encrypt IP sertifikaları `shortlived` profilindedir ve 160 saat geçerlidir. Bu nedenle Ubuntu 22.04'ün eski apt Certbot paketi yerine IP/webroot desteği bulunan Certbot 5.4+ gerekir. Bu VDS'de snap Certbot 5.6.0 ve günde iki kez çalışan `snap.certbot.renew.timer` kuruludur. Güncel davranış için [Let's Encrypt duyurusu](https://letsencrypt.org/2026/03/11/shorter-certs-certbot) ve [sertifika profilleri](https://letsencrypt.org/docs/profiles/) esas alınmalıdır.

Yeni bir IP için ilk staging doğrulaması:

```bash
/snap/bin/certbot certonly --staging --non-interactive --agree-tos \
  --register-unsafely-without-email --preferred-profile shortlived \
  --webroot --webroot-path /var/www/letsencrypt \
  --ip-address SUNUCU_IP \
  --config-dir /tmp/certbot-staging-config \
  --work-dir /tmp/certbot-staging-work \
  --logs-dir /tmp/certbot-staging-logs
```

Staging başarılı olduktan sonra production sertifikası:

```bash
/snap/bin/certbot certonly --non-interactive --agree-tos \
  --register-unsafely-without-email --preferred-profile shortlived \
  --webroot --webroot-path /var/www/letsencrypt \
  --ip-address SUNUCU_IP --cert-name SUNUCU_IP
```

Yenileme sonrası [deploy/certbot-reload-nginx](deploy/certbot-reload-nginx) hook'u önce Nginx yapılandırmasını doğrular, sonra servisi reload eder. Operasyon kontrolleri:

```bash
nginx -t
systemctl is-active nginx
systemctl is-enabled nginx
systemctl is-active snap.certbot.renew.timer
systemctl list-timers --all snap.certbot.renew.timer
/snap/bin/certbot renew --dry-run --run-deploy-hooks --no-random-sleep-on-renew
curl -fsS https://45.133.36.77/
curl -sS -o /dev/null -D - http://45.133.36.77/
ss -lntp
```

HTTP-01 doğrulaması ve yenileme için port 80'i tamamen kapatmayın; normal kullanıcı istekleri HTTPS'e yönlenir. `nginx -t` başarısızsa reload yapmayın. Sertifika süresi kısa olduğundan timer başarısızlığı ve yaklaşan sona erme için dış izleme/alarm kurulmalıdır. IP veya Nginx yolu değişirse önce yeni sertifikayı ve yapılandırmayı doğrulayın; çalışan sertifikayı silmeyin.

## 12. PostgreSQL yedekleme ve geri yükleme testi

Production Compose, yönetim rolüyle her gün custom-format `pg_dump` alan `postgres-backup` servisini içerir. Dump önce `pg_restore --list` ile doğrulanır, SHA-256 dosyası yazılır ve varsayılan olarak 14 gün saklanır. Uygulamanın durdurulması gerekmez:

```bash
cd /root/Enterprise-AI-Analytics-Platform
docker compose up -d postgres-backup
docker compose logs --tail=20 postgres-backup
docker compose --profile maintenance run --rm postgres-restore-check
```

Restore-check en güncel checksum'u doğrular, production'dan farklı geçici `reai_restore_check` veritabanı oluşturur, dump'ı yükler, çekirdek tabloları sorgular ve geçici veritabanını kaldırır. Production veritabanına yazmaz. `postgres-backups` volume'ü aynı VDS üzerindedir; felaket kurtarma için dump'ları ayrıca farklı fiziksel sistemde şifreli saklayın. `.env`/secret'lar veritabanı yedeğine gömülü değildir; ayrı secret vault ve erişim politikasıyla korunmalıdır.

Önerilen asgari politika:

- Günlük yedek, en az 7 günlük saklama
- Haftalık off-site şifreli kopya
- Her release öncesi ek yedek
- Aylık izole restore testi
- Yedek checksum ve tarih envanteri

### Gerçek production restore

Restore mevcut production veritabanını değiştiren riskli bir işlemdir. Açık bakım onayı, doğrulanmış backup checksum'u ve ayrıca mevcut verinin safety backup'ı olmadan uygulanmamalıdır.

Onaylı bakımda yüksek seviye sıra:

1. App'i durdurun.
2. Mevcut veritabanının yeni bir safety dump'ını alın ve checksum'unu doğrulayın.
3. Hedef dump'ı yeni/boş bir PostgreSQL veritabanına `pg_restore --no-owner --no-acl` ile yükleyin.
4. Uygulama bağlantısını yalnız doğrulanan hedef veritabanına yönlendirin; uygulama idempotent şemayı tamamlasın.
5. App'i başlatıp health, giriş, tenant izolasyonu ve veri bütünlüğü smoke testlerini çalıştırın.
6. Safety kopyayı doğrulama süresi bitmeden kaldırmayın.

Production veritabanını drop/overwrite eden komutlar bu otomatik scriptlerde yoktur. Gerçek restore için hedef adları bakım anında doğrulanmalı ve açık onay alınmalıdır.

## 13. Güncelleme

1. Kullanıcı trafiğini/maintenance penceresini planlayın.
2. Git çalışma ağacındaki yerel kullanıcı değişikliklerini inceleyin; silmeyin veya ezmeyin.
3. Mevcut commit'i ve image durumunu kaydedin.
4. PostgreSQL safety dump'ı alın ve restore-check çalıştırın.
5. Yeni commit/tag'i fast-forward veya ayrı release checkout ile alın.
6. Test profile'ını çalıştırın.
7. Image'ları build edip servisleri yeniden oluşturun.
8. Health, giriş, rol, CSV yükleme/okuma ve restart kalıcılık smoke testlerini yapın.

Örnek kontrollü akış:

```bash
git status --short
git rev-parse HEAD
git fetch --tags --prune
git switch --detach RELEASE_TAG_OR_COMMIT
docker compose config --quiet
docker compose --profile test build app-test ml-test
docker compose --profile test run --rm app-test
docker compose --profile test run --rm ml-test
docker compose up -d --build
docker compose ps
curl -fsS http://127.0.0.1:3000/api/health
```

Dirty worktree varsa `git switch` ile devam etmeyin; kullanıcı değişikliklerini koruyacak ayrı branch/commit/yedek planı oluşturun.

## 14. Rollback

Uygulama rollback'i:

1. Aktif commit ve veri yedeğini kaydedin.
2. Bilinen iyi commit/tag'e geçin.
3. Eski image'ı yeniden build edin veya önceden etiketlenmiş image'ı kullanın.
4. `docker compose up -d` ile servisi yeniden oluşturun.
5. Health ve kritik iş akışlarını doğrulayın.

```bash
git switch --detach KNOWN_GOOD_COMMIT
docker compose up -d --build
docker compose ps
curl -fsS http://127.0.0.1:3000/api/health
```

Schema uyumsuzluğu varsa yalnızca kod rollback'i yeterli olmayabilir. Veritabanı restore'u bölüm 12'deki riskli işlem prosedürüne ve açık onaya tabidir. `git reset --hard`, `docker compose down -v` veya volume silme rollback yöntemi değildir.

## 15. IP/domain dış erişim testi

IP üzerinden:

```bash
curl -sS -o /dev/null -D - http://SUNUCU_IP/
curl -I https://SUNUCU_IP/
curl -fsS https://SUNUCU_IP/api/health
# Aşağıdaki doğrudan app portu testi bağlantıyı reddetmelidir:
curl --max-time 3 http://SUNUCU_IP:3000/
```

Domain üzerinden:

```bash
curl -I https://DOMAIN/
curl -fsS https://DOMAIN/api/health
```

Tarayıcı smoke testi:

1. Ana sayfa/login ekranı açılıyor.
2. Public registration beklenen ayarda.
3. Admin giriş yapabiliyor, hatalı parola reddediliyor.
4. Viewer yazma işlemi yapamıyor.
5. CSV yükleme, dashboard, analiz ve rapor çalışıyor.
6. Çıkış sonrası korumalı sayfa açılamıyor ve eski JWT `/api/me` üzerinde 401 alıyor.
7. `docker compose restart` sonrası kullanıcı ve veri korunuyor.

Gerçek ödeme/e-posta/SMS testi yapmayın. NVIDIA/Gemini gibi harici AI servislerini yalnız sağlayıcının test/kota politikasına uygun, müşteri onaylı ve hassas olmayan veriyle kontrollü test edin.

## 16. Sorun giderme

### Health `degraded`

- `checks.database=ok`, `authentication=configuration-required`: `JWT_SECRET` en az 32 karakter değil veya container environment'ına alınmamış.
- Bu durumda HTTP 503 ve app container'ında `unhealthy` beklenir; secret sağlanmadan bunu healthcheck gevşeterek gizlemeyin.
- `.env` değiştiyse `docker compose restart` yerine `docker compose up -d app` çalıştırın.
- Secret değerini loga/terminale yazdırmadan dosyayı yetkili editörle kontrol edin.

### CORS / `ORIGIN_NOT_ALLOWED`

- `APP_URL`, tarayıcı adresiyle şema + host + port dahil birebir aynı olmalı.
- Ek origin gerekiyorsa `ALLOWED_ORIGINS` içine tam adres ekleyin.
- Reverse proxy'de `X-Forwarded-Proto` ve `TRUST_PROXY_HOPS=1` doğrulayın.
- Wildcard kullanmayın.

### Giriş çalışmıyor

- Health içindeki authentication kontrolünü inceleyin.
- Public registration kapalıysa mevcut kullanıcıyla giriş yapın; kayıt için kontrollü pencere açın.
- Aynı IP+e-posta için beş, IP genelinde varsayılan 30 hatalı/rezerve denemeden sonra 15 dakikalık limiter devreye girer.
- Sistem saatini kontrol edin; JWT doğrulaması doğru saate bağlıdır.

### Konnektör oluşturulamıyor

- `DATA_ENCRYPTION_KEY` geçerli 32 bayt base64/64 hex olmalı.
- Mevcut konnektörler varken anahtarı gelişigüzel değiştirmeyin.
- REST hostname tam allowlist içinde olmalı; şema/yol eklemeyin.
- Hedef HTTPS ve public IP'ye çözülmeli, redirect kullanmamalı, JSON dönmeli.

### ML analizi 502 / 429

```bash
docker compose ps ml-service
docker compose logs --tail=200 ml-service app
docker compose exec -T app node -e "fetch('http://ml-service:8000/health').then(async r=>{console.log(r.status,await r.text());process.exit(r.ok?0:1)}).catch(()=>process.exit(1))"
```

İstek satır/sütun/hücre limitlerini veya container RAM limitini aşıyor olabilir. `429 ML_QUEUE_FULL`, process-içi kuyruğun toplam veya kullanıcı kotasına ulaştığını gösterir; job durumlarını/logları inceleyin, servisi yalnız sayacı sıfırlamak amacıyla restart etmeyin.

### SQLite hatası / read-only

```bash
docker compose exec -T app sh -c 'id; ls -ld /app/data; test -w /app/data'
docker compose logs --tail=200 app
docker inspect --format '{{json .Mounts}}' enterprise-ai-app-1
```

Volume'ü silmeyin. İzin düzeltmeden önce güncel yedek alın ve doğru container UID'sini doğrulayın.

### Port kullanılıyor

```bash
ss -lntp
docker ps --format 'table {{.Names}}\t{{.Ports}}'
```

Çakışan servisi veri/erişim etkisini anlamadan durdurmayın. Gerekirse `APP_PORT` değerini boş bir porta taşıyıp `APP_URL` ve proxy'yi birlikte güncelleyin.

### Build başarısız

```bash
docker compose build --no-cache app
docker compose --profile test build app-test
docker compose --profile test run --rm app-test
```

SQLite native modülü için production Dockerfile Debian Trixie tabanlıdır. Base image'i Alpine/eski glibc sürümüne rastgele değiştirmeyin.

## 17. Teslim öncesi kontrol listesi

- [ ] `.env` izni `0600`, Git dışında ve gerçek benzersiz secret'larla dolu
- [ ] `/api/health` HTTP 200; JSON `status`, database, mlService ve authentication değerleri `ok`
- [ ] Yalnızca beklenen host portları açık
- [ ] İlk admin token header'ıyla oluşturuldu; public registration kapatıldı ve bootstrap token kaldırıldı
- [ ] Viewer/analyst/admin RBAC smoke testleri başarılı
- [ ] CSV yükleme, dashboard, ETL/ML ve rapor başarılı
- [ ] Harici AI kapalı veya açık müşteri onayıyla NVIDIA/Gemini üzerinde yapılandırılmış
- [ ] REST allowlist yalnızca gerekli hostları içeriyor
- [ ] Container'lar non-root/healthy ve restart policy etkin
- [ ] Restart sonrasında PostgreSQL verisi korunuyor
- [ ] Güncel PostgreSQL yedeği, restore-check ve off-site şifreli kopya doğrulandı
- [ ] Kurum retention politikası, Prometheus kuralları ve operasyon alarm yönlendirmesi doğrulandı
- [ ] Domain varsa DNS, TLS, HTTPS redirect ve HSTS doğrulandı
- [ ] Mobil teslim varsa trusted HTTPS, `https://localhost` CORS, cihaz E2E ve signing doğrulandı
- [ ] Loglarda kritik hata veya hassas veri yok
- [ ] Test suite ve dependency audit başarılı
