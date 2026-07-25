# Enterprise AI Analytics Platform — ML v7.1 Yaması

Bu paket, `Enterprise-AI-Analytics-Platform` projesinin ML katmanını daha güvenli, açıklanabilir ve üretime daha uygun hâle getirir. Mevcut FastAPI ve Node.js yanıt yapısını mümkün olduğunca korur; tahmin, anomali, segmentasyon, sınıflandırma ve LLM yorumlama akışlarını güçlendirir.

> Hiçbir yazılım için “hiç bug yok” garantisi verilemez. Bu sürüm; kaynak kod incelemesi, 53 otomatik test, stres testleri, performans ölçümleri ve gerçek zaman serisi backtestleriyle doğrulanmıştır. Canlıya almadan önce kendi VDS ortamındaki Docker test kapısının geçmesi zorunludur.

## Paketin içeriği

- `apply_ml_v7.py`: Yamayı fail-closed biçimde uygular.
- `ml-service/app/forecasting_v7.py`: Yeni tahmin motoru.
- `ml-service/app/analytics_v7.py`: Anomali, segmentasyon ve sınıflandırma motoru.
- `ml-service/tests/`: Yeni regresyon ve istatistik testleri.
- `tests/test_apply_ml_v7.py`: Kurulum, idempotence ve geri alma testleri.
- `validate_real_data.py`: Resmî gerçek veri serileriyle backtest.
- `validate_stress.py`: Kenar durum ve dayanıklılık testleri.
- `validate_performance.py`: Büyük veri performans ölçümü.
- `AUDIT_REPORT_TR.md`: Ayrıntılı teknik inceleme.
- `*_validation*.json`: Çalıştırılmış doğrulama sonuçları.

## En güvenli VDS kurulumu

ZIP dosyasını VDS'de örneğin `/root/ml_v7_patch` altına çıkarttıktan sonra:

```bash
cd /root/ml_v7_patch
python3 apply_ml_v7.py \
  --repo /root/Enterprise-AI-Analytics-Platform \
  --dry-run
```

Dry-run başarılıysa yamayı uygula ve projenin gerçek Docker test kapısını çalıştır:

```bash
python3 apply_ml_v7.py \
  --repo /root/Enterprise-AI-Analytics-Platform \
  --docker-tests
```

Bu komut şu işlemleri tek akışta yapar:

1. Değişecek bütün dosyaların byte seviyesinde anlık görüntüsünü alır.
2. Dosyaları geçici dosya + atomik değiştirme yöntemiyle yazar.
3. `ml-test` Docker imajını oluşturur.
4. Docker içindeki `ruff check app tests && pytest -q tests` kapısını çalıştırır.
5. Derleme veya test başarısız olursa bütün dosyaları otomatik olarak kurulum öncesi hâline döndürür.

Test başarılı olduktan sonra servisleri yeniden oluştur:

```bash
cd /root/Enterprise-AI-Analytics-Platform
docker compose build ml-service app
docker compose up -d ml-service app
docker compose ps
docker compose logs --tail=200 ml-service app
```

## Host üzerinde test alternatifi

VDS'de Python geliştirme bağımlılıkları kuruluysa:

```bash
python3 apply_ml_v7.py \
  --repo /root/Enterprise-AI-Analytics-Platform \
  --run-tests
```

Bu seçenek Python derlemesi ve pytest çalıştırır; `ruff` hostta kuruluysa onu da çalıştırır. Hostta `ruff` yoksa uyarı verir. Canlıya geçmeden önce yine Docker test kapısını çalıştırmak daha güvenlidir.

## Manuel geri alma

`--docker-tests` veya `--run-tests` sırasında hata oluşursa geri alma otomatiktir. Başarılı kurulumdan daha sonra manuel geri dönmek gerekirse mevcut dosyaların `.ml-v7.bak` yedeklerini geri kopyala ve v7 tarafından eklenen yeni modülleri kaldır:

```bash
cd /root/Enterprise-AI-Analytics-Platform

cp ml-service/app/main.py.ml-v7.bak ml-service/app/main.py
cp src/server/routes/ml.ts.ml-v7.bak src/server/routes/ml.ts

rm -f ml-service/app/forecasting_v7.py
rm -f ml-service/app/analytics_v7.py
rm -f ml-service/tests/test_forecasting_v7.py
rm -f ml-service/tests/test_analytics_v7.py
rm -f ml-service/tests/conftest.py

docker compose build ml-service app
docker compose up -d ml-service app
```

`test_main.py.ml-v7.bak` oluşmuşsa onu da geri yükle:

```bash
cp ml-service/tests/test_main.py.ml-v7.bak ml-service/tests/test_main.py
```

## Yeni tahmin mantığı

- Tek bir holdout yerine geliştirme verisinde çok ufuklu rolling-origin model seçimi.
- Model seçiminde kullanılmayan ayrı walk-forward final test.
- MAE, RMSE, R², SMAPE, WAPE, MASE ve naïve baz modele göre hata oranı.
- Kalibre edilmeye çalışılan rolling-origin conformal tahmin aralıkları.
- Kalite puanı, “doğru çıkma olasılığı” olarak sunulmaz.
- Günlük, iş günü, haftalık, aylık ve çeyreklik frekans ayrımı.
- Düzensiz veya alt-günlük seride sessizce tahmin yapmak yerine açık hata.
- Eksik dönemleri yalnız işlem tablosu olduğu güçlü biçimde anlaşıldığında ve boşluk oranı düşükse sıfırla tamamlama.
- Gelir, ciro, adet ve stok gibi açıkça negatif olamayacak hedeflerde alt sınır sıfır.
- Kâr, zarar, bakiye, büyüme ve nakit akışı gibi işaret değiştirebilen hedeflerde negatif değerleri koruma.
- Kısa serilerde eğitim hatasını test hatası gibi göstermeme.
- Hedef sütun belirtilmemiş ve birden fazla benzer güçlü aday varsa fail-closed davranma; kullanıcıdan `target_column` seçmesini isteme.

## Analitik modellerdeki değişiklikler

### Anomali

- RobustScaler ile ölçekleme.
- Üç farklı seed ile IsolationForest konsensüsü.
- Stabilite ve skor ayrışmasına dayalı kalite göstergesi.
- Sonuçlar “kesin anomali” değil, incelenmesi gereken adaylar olarak etiketlenir.

### Segmentasyon

- Robust ölçekleme.
- Küme sayısının silhouette ve denge ile seçilmesi.
- Birden fazla seed arasında ARI stabilite ölçümü.
- Çok küçük veya anlamsız kümelerde sonuç üretmeme.
- Segment numaralarını merkezlere göre deterministik eşleme.

### Sınıflandırma

- Sayısal alanlarda imputasyon + standardizasyon.
- Kategorik alanlarda imputasyon + one-hot encoding.
- Tek train/test bölümü yerine out-of-fold çapraz doğrulama.
- Tekrarlanan müşteri/varlık kimliği varsa group-aware fold.
- Group fold kurulamazsa açık uyarı ve kalite tavanı.
- Tarih alanı bulunduğu hâlde gerçek zaman kesiti tanımlı değilse “gelecek performansı kanıtlanmadı” uyarısı.
- Risk skorlarının kalibre edilmiş olasılık olmadığı açıkça belirtilir.

## LLM yorumlama koruması

Node.js yorumlama rotasına şu koruma eklenir:

- Stok sütunu yoksa stok önerisi yapılmaz.
- Çalışan/iş yükü verisi yoksa ekip veya kapasite önerisi yapılmaz.
- Fiyat/kampanya verisi yoksa fiyat veya kampanya önerisi yapılmaz.
- Tahmin kalitesi düşükse operasyonel değişiklik yerine veri iyileştirme, izleme ve yeniden doğrulama önerilir.
- Kalite puanı doğru çıkma ihtimali olarak yorumlanmaz.

## Doğrulama özeti

- Otomatik test: **53 geçti**.
- Ölçülen toplam kod kapsamı: **%85**.
- Stres testi: **26 tahmin + 8 analitik senaryo, 0 hata**.
- 10.000 satırlık günlük tahmin / 30 dönem: yaklaşık **0,65 saniye**.
- 50.000 satır anomali: yaklaşık **5,13 saniye**.
- 50.000 satır segmentasyon: yaklaşık **4,35 saniye**.
- 12.000 satır sınıflandırma: yaklaşık **0,43 saniye**.

Bu süreler test ortamına aittir; VDS CPU/RAM kapasitesi ve eşzamanlı yükle değişir.

## Senin sentetik satış verindeki sonuç

`Brüt_Ciro_TL` hedefi açıkça seçilerek yapılan yeni testte:

- Seçilen model: `moving_average_3`
- 1–3 Ocak 2026 toplam merkez tahmini: **₺59.772,67**
- MAE: **₺25.565,99**
- RMSE: **₺30.625,13**
- R²: **-0,3287**
- SMAPE: **%64,97**
- Kalite: **çok düşük / yalnız keşif amaçlı**

Bu değişiklik bilinçlidir: yeni sistem önceki doğrusal trend sonucunu korumak yerine, ayrılmış doğrulamada daha iyi çıkan modeli seçer. Ancak metrikler kötü olduğu için sonucu operasyonel karar olarak sunmaz.

## Bilinen sınırlar

- Yalnız geçmiş değerlerden çalışan hiçbir model pandemi, mevzuat değişimi, ürün lansmanı veya ani fiyat şoku gibi dışsal kırılmaları önceden bilemez.
- Tahmin aralıkları garanti değildir; geçmiş hata dağılımına dayanır.
- Anomali etiketi inceleme adayıdır, hata veya dolandırıcılık kanıtı değildir.
- Segmentler iş açısından anlamlı isimlere otomatik dönüşmez; alan uzmanı yorumu gerekir.
- Sınıflandırma gerçek zaman bazlı performans iddiasında bulunabilmek için açık bir tahmin tarihi ve zaman ayrımlı validasyon gerektirir.
- Gerçek üretim doğruluğu şirketin kendi geçmiş verisinde düzenli walk-forward backtest ile izlenmelidir.
