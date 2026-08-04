# 01 - Ürün Vizyonu (Product Vision)

## 🎯 Ürün Amacı
**Enterprise AI Analytics Platform**, e-ticaret ve muhasebe odaklı işletmelerin ham veri tabloları arasında kaybolmasını engellemek amacıyla tasarlanmış **Dijital AI İş Analisti ve Karar Destek Sistemidir (DSS)**.

Klasik iş zekası (BI) araçları kullanıcılara yalnızca karmaşık grafikler ve devasa veritabanı tabloları sunarken; Enterprise AI Analytics Platform, veriyi arka planda analiz eder, finansal ve operasyonel riskleri deterministik kurallarla tespit eder ve yöneticiye doğrudan uygulanabilir stratejik kararlar sunar.

---

## 👥 Hedef Kullanıcı Profilleri (User Personas)

### 1. CFO & Finans Yöneticisi
- **İhtiyaç**: Nakit akışı açıklarını önceden görmek, kâr marjı erimesini engellemek ve verimsiz harcamaları kısıtlamak.
- **Çözüm**: 30 günlük nakit akışı tahmini, brüt kâr marjı takibi ve ROAS verimlilik kontrolleri.

### 2. E-Ticaret & Operasyon Müdürü
- **İhtiyaç**: Stok tükenmesi nedeniyle satış kaybetmemek, iade oranlarını düşürmek ve kargo/teslimat şikayetlerini çözmek.
- **Çözüm**: SKU bazlı stok tükenme günü tahmini, iade oranı uyarıları ve NLP müşteri yorumu kümeleme.

### 3. İş Analisti ve Genel Müdür (CEO)
- **İhtiyaç**: Şirket genel sağlık durumunu tek bakışta anlamak, veri kalitesi sorunlarını fark etmek ve AI ile stratejik kararlar almak.
- **Çözüm**: Karar Merkezi (Decision Center), Otomatik İçgörü Kartları (Auto Insights) ve AI Chat Asistanı.

---

## 🚀 Temel Değer Önerileri
1. **Sıfır Ham Veri Yığını**: Kullanıcıya binlerce satırlık ham veri tablosu göstermek yerine, veriden süzülen özet kararları sunar.
2. **Kurala Dayalı Doğruluk**: Karar önerileri LLM'in uydurmasına (hallucination) bırakılmaz; deterministik BI Engine çıktısına dayanır.
3. **Çok Kiracılı ve Güvenli (Multi-Tenant & Secure)**: PostgreSQL RLS ve JWT ile her organizasyonun verisi tamamen izoledir.
