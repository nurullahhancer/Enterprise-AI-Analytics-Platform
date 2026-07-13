# Enterprise AI Analytics Platform

Enterprise AI Analytics Platform; kullanıcıların CSV verilerini güvenli biçimde yükleyip inceleyebildiği, dashboard ve rapor üretebildiği, temel ETL/ML analizleri çalıştırabildiği ve isteğe bağlı olarak doküman destekli yapay zekâ sohbeti kullanabildiği tek sunuculu bir analitik uygulamasıdır.

Production için kanonik uygulama proje kökündeki React/Vite arayüzü ile Express/SQLite API'sidir. `frontend/` altındaki Next.js arayüzü ve `backend/` altındaki .NET çözümü önceki mimari çalışmasının referans/test bileşenleridir; ana `docker-compose.yml` bunları production trafiğine çıkarmaz.

## Production mimarisi

```text
Tarayıcı / Reverse proxy
          |
          | HTTP(S), varsayılan host portu 3000
          v
  React SPA + Express API  ---->  SQLite (/app/data/reai.db)
          |
          | yalnızca internal Docker ağı
          v
      FastAPI ML servisi
```

- Web/API: Node.js 22, Express, React 19, Vite, TypeScript
- Kalıcı veri: SQLite ve Docker named volume (`app-data`)
- ML: FastAPI, pandas, NumPy ve scikit-learn; dışarıya port yayınlanmaz
- Kimlik doğrulama: 8 saatlik HS256 JWT, scrypt parola özeti, token sürümleme
- Yetkilendirme: `admin`, `analyst`, `viewer` rolleri ve sunucu tarafı kontroller
- İsteğe bağlı AI: Google Gemini; müşteri verisi ancak açık izin değişkeni de etkinse gönderilir
- İsteğe bağlı veri kaynağı: yalnızca allowlist ile sınırlandırılmış HTTPS/JSON REST konnektörü
- Mobil kabuk: Capacitor/Android; yalnız güvenilen HTTPS API ile ayrı build gerekir

## Temel özellikler

- Kayıt, giriş, oturum geri yükleme, profil/parola güncelleme ve hesap silme
- Kullanıcı bazında veri izolasyonu
- Birden fazla CSV yükleme; dashboard, ML, rapor, ETL ve veri destekli AI için kullanıcının tüm CSV'lerini kaynak dosya bilgisiyle birleştirme
- Median doldurma, tip normalizasyonu ve IQR aykırı değer adımlarını içeren gerçek CSV ETL akışı
- Tahmin, anomali, kümeleme ve veri profilleme analizleri; tahmin uyum skoru holdout doğruluğu değil in-sample/heuristik göstergedir
- CSV rapor dışa aktarma ve formül enjeksiyonu koruması
- PDF/TXT doküman ayrıştırma ve yerel metin parçası araması
- Şifreli REST konnektör yapılandırması ve SSRF korumalı veri alma
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

Varsayılan erişim adresi `http://SUNUCU_IP:3000`, sağlık kontrolü ise `http://SUNUCU_IP:3000/api/health` olur. Domain/HTTPS kullanılıyorsa yalnızca reverse proxy'nin dinlemesi için `APP_BIND_IP=127.0.0.1` önerilir.

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

Kullanıcı rolü JWT içinden körü körüne kabul edilmez; her istekte veritabanındaki güncel kullanıcı ve rol kontrol edilir. Son yönetici rolü düşürülemez.

## Environment özeti

Eksiksiz ve secretsiz şablon `.env.example` dosyasındadır.

| Değişken | Açıklama |
|---|---|
| `APP_BIND_IP`, `APP_PORT`, `APP_URL` | Dış dinleme ve tarayıcı adresi |
| `ALLOWED_ORIGINS` | Virgülle ayrılmış ek CORS origin'leri |
| `TRUST_PROXY_HOPS` | Güvenilen reverse proxy atlama sayısı |
| `JWT_SECRET`, `JWT_ISSUER`, `JWT_AUDIENCE` | JWT güvenlik ayarları |
| `ALLOW_PUBLIC_REGISTRATION` | Herkese açık kayıt anahtarı |
| `BOOTSTRAP_ADMIN_EMAIL`, `BOOTSTRAP_ADMIN_TOKEN` | İlk yönetici e-posta eşleşmesi ve ayrı kayıt yetkisi |
| `DATA_ENCRYPTION_KEY` | Konnektör ayarları için AES-256-GCM anahtarı |
| `REST_CONNECTOR_ALLOWED_HOSTS` | İzinli tam REST hostname listesi |
| `GEMINI_API_KEY`, `ALLOW_EXTERNAL_AI_DATA` | İsteğe bağlı dış AI ve açık veri aktarım izni |
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

- Bu dağıtım tek VDS/tek SQLite writer mimarisidir; yatay ölçekleme için harici veritabanı ve ortak session/job katmanı gerekir.
- Organizasyonlar arası paylaşımlı üyelik/gerçek multi-tenant yönetimi etkin değildir; mevcut izolasyon kullanıcı hesabı bazındadır.
- SQL konnektörü güvenlik ve sözleşme tamamlanana kadar devre dışıdır.
- RAG, yerel metin parçası seçimi kullanır; Qdrant tabanlı gerçek embedding/vector araması production akışında yoktur.
- Parola sıfırlama e-postası, ödeme ve ücretli servis çağrıları yapılandırılmamıştır.
- Domain/DNS ve TLS sertifikası sunucu dışından sağlanmalıdır.
- “Aktif” veri seti işareti analiz kapsamını daraltmaz; bütün kayıtlı CSV'ler birlikte değerlendirilir. ETL çıktısı da aynı havuza eklendiğinden operatör orijinal+türetilmiş veri çift sayımını yönetmelidir.
- ML uyum/“confidence” değerleri kalibre olasılık veya holdout doğruluğu değildir; kritik kararlar için domain doğrulaması ve ayrı backtest gerekir.
- Android cleartext trafiği kapalıdır. Mobil production build için `VITE_API_BASE_URL=https://...`, CORS'ta `https://localhost`, `npm run cap:sync`, cihaz E2E ve release signing gerekir; cihaz/store teslimi bu denetimin dışındadır.
