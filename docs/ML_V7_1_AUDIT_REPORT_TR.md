# ML Katmanı Ayrıntılı Teknik Denetim Raporu

**Proje:** Enterprise AI Analytics Platform  
**Yama:** ML v7.1  
**Denetim tarihi:** 25 Temmuz 2026  
**Kapsam:** FastAPI ML servisi, tahmin çekirdeği, anomali, segmentasyon, sınıflandırma, cache anahtarları, testler, kurulum güvenliği ve LLM yorumlama kanıt sınırları.

## 1. Sonuç

Yeni sürüm önceki basit ML akışına göre önemli ölçüde daha güvenli ve istatistiksel olarak daha dürüsttür. Sayısal sonuçları üretmeye devam eder; ancak kötü doğrulama sonucunu “yüksek güven” gibi göstermeyi engeller. Yanlış hedef, düzensiz zaman ekseni, kısa seri, negatif alan sınırı, veri sızıntısı ve sabit güven puanı gibi temel riskler kapatılmıştır.

Bununla birlikte bu rapor “sıfır bug” veya “her veri setinde doğru tahmin” garantisi vermez. Bu garanti teknik olarak mümkün değildir. En doğru ifade şudur:

> Kod, incelenen mevcut depo yapısına göre sistematik biçimde iyileştirilmiş; otomatik, stres, performans ve gerçek veri testlerinden geçirilmiş; bilinen yüksek riskli tutarsızlıklar kapatılmıştır.

## 2. Orijinal yapıda tespit edilen ana sorunlar

### 2.1 `/predict` eğitim performansını dış performans gibi kullanıyordu

Doğrusal regresyon tüm geçmişe fit ediliyor; MAE ve RMSE aynı fit edilen veri üzerinde hesaplanıyordu. Bu, geleceğe yönelik hata tahmini değildir. Tarihler veri frekansından bağımsız şekilde aylık ilerletilebiliyordu.

**Düzeltme:** `/predict`, düzenli zaman serisi kontrolünden sonra rolling-origin seçimi ve ayrılmış walk-forward test kullanıyor. Gelecek tarihleri gerçek frekanstan üretir.

### 2.2 Model seçimi ve raporlama aynı holdout üzerinde yapılıyordu

Aynı son %20 bölüm hem en iyi modeli seçmek hem de seçilen modelin başarısını raporlamak için kullanılıyordu. Bu seçim yanlılığı oluşturabilir.

**Düzeltme:** Geliştirme bölümünde rolling-origin CV ile model seçimi; ayrı final bölümünde walk-forward test.

### 2.3 “Tahmin güveni” olasılık gibi görünüyordu

MAE/RMSE/SMAPE ve veri miktarından türetilmiş özel puan, kullanıcıya tahminin doğru çıkma olasılığı gibi görünebiliyordu. Yapısal kırılmalarda yüksek puan kalabiliyordu.

**Düzeltme:** `confidence_semantics=historical_validation_quality_not_probability`, `confidence_is_probability=false`, kalite sınıfı ve karar desteği seviyesi eklendi. Negatif R², yüksek SMAPE, baz modeli yenememe, rejim değişimi ve kapsama problemi kaliteyi sınırlar.

### 2.4 Eksik tarihler ile sıfır satış karıştırılabiliyordu

Her eksik günün sıfır kabul edilmesi ölçüm eksikliğini gerçek sıfır talep gibi gösterebilir.

**Düzeltme:** Yalnız aynı tarihte çoklu işlem satırı bulunan transaction-like tabloda, hedef toplamsal olduğunda ve boşluk oranı düşükken sıfır tamamlama yapılır. Diğer durumlarda eksik dönem korunur veya tahmin reddedilir.

### 2.5 Negatiflik kuralı alan anlamından bağımsızdı

Sadece geçmiş değerlerin pozitif olması, değişkenin gelecekte negatif olamayacağını kanıtlamaz. Kâr veya bakiye serisi geçmişte pozitif olsa bile ileride negatif olabilir.

**Düzeltme:** Alt sınır yalnız hedef adı açıkça ciro, gelir, adet, stok, fiyat, trafik veya talep gibi negatif olamayan alanı ifade ediyorsa uygulanır. Kâr, zarar, marj, büyüme, fark, bakiye ve nakit akışı imzalı bırakılır.

### 2.6 Yüzde metinleri yanlış ölçeklenebiliyordu

`%12,5` değeri 12,5 olarak ele alınırsa oran 100 kat büyük olur.

**Düzeltme:** Türkçe/İngilizce para ve sayı biçimleriyle birlikte yüzde işareti algılanıp 100'e bölünür. Sonsuz değerler eksik kabul edilir.

### 2.7 Otomatik hedef seçimi belirsiz alanlarda sessiz karar veriyordu

Brüt ciro ve net ciro gibi iki güçlü aday olduğunda alfabetik veya küçük skor farkıyla yanlış hedef seçilebilirdi.

**Düzeltme:** Açık `target_column` her zaman önceliklidir. Benzer güçlü adaylar varsa otomatik seçim yapılmaz; tahmin fail-closed biçimde atlanır ve hedefin açıkça seçilmesi istenir.

### 2.8 Anomali ve segment güvenleri sabitti

Anomali için yaklaşık 0,82/0,55 ve segment için 0,78 gibi sabit puanlar veri üzerinden ölçülen doğruluk değeri değildi.

**Düzeltme:** Anomali puanı seed stabilitesi, skor ayrışması ve veri bütünlüğünden; segment puanı silhouette, çoklu-seed ARI ve küme dengesinden hesaplanır. İkisi de olasılık değildir.

### 2.9 KMeans ölçeklenmemiş veride çalışıyordu

Ciro gibi büyük ölçekli alanlar, memnuniyet gibi küçük ölçekli alanları tamamen bastırabilirdi.

**Düzeltme:** Medyan imputasyon, RobustScaler, kimlik/tarih dışlama, çok yüksek korelasyonlu kopya özellikleri eleme ve ölçekten bağımsız özellik önceliği.

### 2.10 Sınıflandırmada veri sızıntısı ve yanlış hedef riski vardı

İlk regex eşleşen alan hedef seçilebiliyor; örneğin `iptal_tarihi`, gerçek `churn` alanından önce seçilebiliyordu. Tek rastgele train/test ayrımı tekrarlanan müşteri satırlarını iki tarafa dağıtabilirdi. Son model tüm veride fit edilip aynı satırlara risk verilmesi aşırı iyimser yorumlanabilirdi.

**Düzeltme:** En güçlü gerçekten ikili hedef seçimi, StandardScaler/OneHot pipeline, out-of-fold tahminler ve tekrarlanan varlık kimliğinde StratifiedGroupKFold. Group fold kurulamazsa açık fallback uyarısı ve kalite tavanı.

### 2.11 LLM önerileri veride olmayan alanlara taşabiliyordu

Yalnız ciro tahmini varken stok veya ekip kapasitesi önerisi üretilebiliyordu.

**Düzeltme:** Prompt kanıt nesnesine mevcut sütunlar ve tahmin kalite bilgisi eklenir. Stok, çalışan, kapasite, fiyat veya kampanya önerileri ilgili veri yoksa yasaklanır.

### 2.12 Eski tahmin kodu yeni modül yanında bırakılıyordu

Kullanılmayan eski yardımcı fonksiyonlar `main.py` içinde kalırsa bakım sırasında yanlış kodun değiştirilmesi ve lint karmaşası oluşabilir.

**Düzeltme:** Kurucu, eski `_smape`–`build_regression_forecast` arasındaki tahmin çekirdeğini tamamen kaldırır ve artık kullanılmayan sklearn/numpy importlarını temizler.

## 3. Yeni tahmin modelleri

Aday havuzu veri uzunluğu ve frekansa göre oluşturulur:

- Naïve son değer
- 3 dönem hareketli ortalama
- Damped robust drift
- Huber trend
- Doğrusal trend
- Yakın dönem Huber/doğrusal trend
- Seasonal naïve
- Seasonal mean
- Seasonal growth
- Croston intermittent-demand baseline

`seasonal_growth`, yalnız ağırlıklı olarak pozitif ve negatif olmayan seviye serilerinde açılır. Kâr/zarar gibi sıfırı geçen serilerde oran tabanlı büyüme modeli kullanılmaz.

## 4. Metrik anlamları

- **MAE:** Ortalama mutlak para/birim hatası.
- **RMSE:** Büyük hataları daha fazla cezalandırır.
- **R²:** Değişkenliği açıklama gücü; negatif değer baz ortalamadan kötü olabileceğini gösterir.
- **SMAPE:** Simetrik yüzde hata; sıfıra yakın değerlerde yine dikkatle yorumlanmalıdır.
- **WAPE:** Toplam mutlak hatanın toplam mutlak gerçekleşene oranı.
- **MASE:** Eğitim bölümündeki naïve hata ölçeğine göre hata.
- **MAE vs naïve:** Seçilen modelin ayrı testte açık baz modele göre hata oranı.
- **Interval coverage:** Ayrılmış testte gerçek değerlerin tahmin aralığı içinde kalma oranı.

Kalite puanı bu metriklerin kontrollü birleşimidir; başarı olasılığı değildir.

## 5. Test sonuçları

### 5.1 Otomatik testler

- **53 test geçti**
- **0 test başarısız**
- Toplam ölçülen kod kapsamı: **%85**
- `forecasting_v7.py`: **%88**
- `analytics_v7.py`: **%88**
- Kurulum betiği: **%68**

Kurulum betiği için daha düşük oran ağırlıklı olarak gerçek dosya sistemi, CLI ve subprocess başarı yollarının tamamının aynı testte çalıştırılmamasından kaynaklanır. Atomik yazım, idempotence, geçersiz Python'da yazmama, snapshot geri alma ve Docker test fail-closed davranışı doğrudan test edilmiştir.

### 5.2 Stres testleri

- 26 farklı tahmin senaryosu
- 8 analitik senaryo
- Günlük, iş günü, haftalık, aylık ve çeyreklik frekans
- Sabit, trend, mevsimsel ve işaret değiştiren seriler
- Eksik işlem günleri
- Aynı gün içi çoklu zaman damgası
- Düzensiz seri
- Kısa seri
- Sabit/anlamsız küme
- Tümü: **0 hata**

### 5.3 Performans

Test ortamında:

| İşlem | Boyut | Süre |
|---|---:|---:|
| Tahmin | 10.000 dönem, 30 gelecek dönem | 0,65 sn |
| Anomali | 50.000 satır | 5,13 sn |
| Segmentasyon | 50.000 satır | 4,35 sn |
| Sınıflandırma | 12.000 satır | 0,43 sn |

Tepe süreç belleği yaklaşık 432 MB ölçülmüştür; bu değer Python/sklearn importları ve bütün test veri çerçevelerini aynı süreçte tutan benchmarkı içerir.

## 6. Gerçek veri backtestleri

### Perakende satış

| Dış test | Model | Dış SMAPE | Dış R² | Aralık kapsaması |
|---|---|---:|---:|---:|
| 2025 | Seasonal growth | %1,31 | 0,948 | %100 |
| 2026 ilk 6 ay | Seasonal growth | %1,74 | 0,886 | %100 |

### Havayolu yolcu serisi

| Dış test | Model | Dış SMAPE | Dış R² | Aralık kapsaması |
|---|---|---:|---:|---:|
| 2025 | Damped drift | %1,34 | -2,862 | %100 |
| 2020 pandemi şoku | Damped drift | %110,88 | -4,359 | %16,67 |

2020 testi kasıtlı bir başarısızlık örneğidir. Model geçmişte bulunmayan pandemi şokunu öngöremez. Bu sonuç sistemin her koşulda iyi görünmesi için ayarlanmadığını ve dışsal kırılma sınırının açıkça korunması gerektiğini gösterir.

Havayolu 2025 testinde SMAPE düşükken R² negatiftir; seri aylık varyasyonu çok düşük olduğunda seviye hatası küçük olsa bile dalgalanma açıklaması zayıf olabilir. Bu nedenle tek metriğe göre başarı kararı verilmez.

## 7. Kullanıcının sentetik satış verisi

Açık hedef: `Brüt_Ciro_TL`  
Zaman alanı: `Sipariş_Tarihi`  
Ufuk: 3 gün

| Metrik | Sonuç |
|---|---:|
| Seçilen model | moving_average_3 |
| Tahmin toplamı | ₺59.772,67 |
| MAE | ₺25.565,99 |
| RMSE | ₺30.625,13 |
| R² | -0,3287 |
| SMAPE | %64,97 |
| WAPE | %60,68 |
| MASE | 1,2724 |
| Kalite | Çok düşük |

Bu veri seti yalnız bir yıllık sentetik günlük satış içerdiği ve günlük oynaklık yüksek olduğu için güvenilir kısa vadeli tahmin üretmiyor. Sistem tahmini saklamaz; fakat operasyonel karar için uygun olmadığını açıkça bildirir.

## 8. Kurulum güvenliği

- Kaynak dosya işaretleri bulunamazsa hiçbir kısmi yama yazılmaz.
- Bütün Python kaynakları yazılmadan önce derlenir.
- Dosyalar geçici dosyaya yazılır, `fsync` yapılır ve atomik `os.replace` ile değiştirilir.
- Mevcut dosyalar `.ml-v7.bak` olarak saklanır.
- `--run-tests` veya `--docker-tests` başarısızsa tam kurulum snapshotı otomatik geri yüklenir.
- Cache anahtarında tahmin dönemi ve motor sürümü bulunur; eski sonuçla çakışma engellenir.
- Kurucu tekrar çalıştırıldığında aynı çıktıyı üretir ve eski v7 kurulumunda kalmış legacy tahmin kodunu da temizler.

## 9. Kalan riskler

1. **Dışsal değişken yokluğu:** Tatil, kampanya, fiyat, stok, ekonomi ve hava gibi nedenler verilmezse model yalnız hedef geçmişini kullanır.
2. **Gerçek zamanlı sınıflandırma:** Veri setinde açık “tahmin anı” tanımlanmadan temporal CV yapılamaz.
3. **Otomatik semantik:** Alan adı hatalı veya anlamsızsa hedef ve sınır mantığı sınırlı kalır; kritik kullanımda açık hedef seçilmelidir.
4. **Concept drift:** Şirket davranışı değiştikçe geçmiş backtest güncelliğini kaybeder.
5. **Tahmin aralıkları:** Geçmiş hata dağılımı gelecekte değişebilir.
6. **Küçük veri:** Az gözlemde güvenilir model seçimi mümkün değildir; sistem bu durumda kaliteyi sıfırlar ama tahmin yine yalnız kaba gösterge olabilir.
7. **Kaynak depo değişikliği:** GitHub deposunun ana dosya yapısı değişirse kurucu güvenli biçimde durur; yeni sürüme göre yama güncellenmelidir.

## 10. Canlıya alma kararı

Yama, mevcut sürüme göre VDS'ye test amaçlı yüklenmeye hazırdır; ancak yalnız şu koşulla:

```bash
python3 apply_ml_v7.py --repo /root/Enterprise-AI-Analytics-Platform --docker-tests
```

komutu başarıyla tamamlanmalı ve sonrasında servis loglarında import, validation veya yeniden başlama hatası bulunmamalıdır. Şirket verisinde ilk birkaç hafta tahmin ile gerçekleşen değerler saklanmalı; rolling MAE, WAPE, SMAPE ve kapsama oranı düzenli izlenmelidir.
