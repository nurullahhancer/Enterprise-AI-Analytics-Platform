# DESIGN SYSTEM: Enterprise AI Analytics Platform

## 1. Tasarım Vizyonu
Güvenilir, sakin, veri odaklı, insani ve profesyonel bir kurumsal SaaS arayüzü. Yapay zekâ pırıltıları ve bağıran gradient'ler yerine net tipografi hiyerarşisi, sade renk paleti ve yüksek okunabilirlik esas alınmıştır.

---

## 2. Renk Sistemi (Color Tokens)

### Ana Marka ve Vurgu Renkleri
* **Ana Marka Rengi (Primary Brand):** `#3B82F6` (Deep Royal Blue) - Güven veren kurumsal mavi.
* **Yardımcı Vurgu Rengi (Secondary Accent):** `#6366F1` (Subtle Indigo) - Etkileşimli öğeler ve aktif durumlar için.

### Nötr Renkler (Dark & Light)
* **Light Background Primary:** `#F8FAFC` (Slate 50)
* **Light Background Surface:** `#FFFFFF` (White)
* **Light Border:** `#E2E8F0` (Slate 200)
* **Light Text Primary:** `#0F172A` (Slate 900)
* **Light Text Secondary:** `#475569` (Slate 600)
* **Light Text Muted:** `#94A3B8` (Slate 400)

* **Dark Background Primary:** `#0B0F17` (Deep Obsidian Slate)
* **Dark Background Surface:** `#141C2B` (Dark Slate Surface)
* **Dark Border:** `rgba(255, 255, 255, 0.08)` (Subtle Border)
* **Dark Text Primary:** `#F1F5F9` (Slate 100)
* **Dark Text Secondary:** `#94A3B8` (Slate 400)
* **Dark Text Muted:** `#64748B` (Slate 500)

### Durum Renkleri (Feedback Colors - Yalnızca Durum İletişimi İçin)
* **Başarı (Success):** `#10B981` (Emerald 500) - Pozitif durumlar, yüksek veri kalitesi.
* **Uyarı (Warning):** `#F59E0B` (Amber 500) - İnceleme gerektiren durumlar, eksik veriler.
* **Hata (Danger):** `#EF4444` (Rose 500) - Anomali, kural ihlali ve kritik hatalar.

---

## 3. Tipografi Sistemi

* **Font Ailesi:** Sans-Serif (`Inter, system-ui, sans-serif`) - Temiz, modern ve okunabilir.
* **Cümle Düzeni:** Tümü Büyük Harf (ALL-CAPS) kullanımı kaldırılmış; Sentence Case (Doğal Türkçe Yazım) benimsenmiştir.

| Seviye | Boyut | Ağırlık | Kullanım Alanı |
| :--- | :--- | :--- | :--- |
| **H1 (Sayfa Başlığı)** | 24px (1.5rem) / 28px | Bold (700) | Ana sayfa başlıkları |
| **H2 (Bölüm Başlığı)** | 18px (1.125rem) / 22px | SemiBold (600) | Kart ve bölüm başlıkları |
| **H3 (Alt Başlık)** | 15px (0.9375rem) / 20px | Medium (500) | Widget ve panel alt başlıkları |
| **Gövde (Body)** | 14px (0.875rem) / 20px | Regular (400) / Medium (500) | Metinler ve açıklamalar |
| **Küçük Açıklama** | 12px (0.75rem) / 16px | Regular (400) | Yardımcı metinler, zaman damgaları |
| **Sayısal Veri (KPI)** | 28px - 32px | Bold (700) / SemiBold | Metrik ve sayısal büyüklükler |
| **Tablo & Form Etiketi** | 13px (0.8125rem) | Medium (500) | Tablo hücreleri ve input label'ları |

---

## 4. Yüzeyler, Köşeler ve Gölgeler

* **Yüzey Yapısı:** Her öğeyi karta koymak yerine, mantıksal gruplarda geniş alan boşlukları (`gap-6`, `p-6`) ve ince ayırıcı çizgiler (`border-slate-200/80`) kullanılır.
* **Köşe Yarıçapları (Border Radius Scale):**
  * Butonlar & Inputlar: `rounded-lg` (8px) - Keskin, derli toplu SaaS görünümü.
  * Kartlar & Paneller: `rounded-xl` (12px) - Dengeli yüzey ayrımı.
  * Modal & Büyük Konteynerler: `rounded-2xl` (16px) - Yumuşak katman.
* **Gölgeler (Shadows):**
  * `shadow-sm` (Subtle 1px elevation) yalnızca kart ayrımında.
  * Ağır bulanık ve renkli gölgeler kaldırılmıştır.

---

## 5. İmza Tasarım Unsuru: "Confidence & Health Telemetry Indicator"

Ürünün özgün görsel imzası; veri akışının güvenilirliğini, analiz kapsama durumunu ve tahmin kalitesini temsil eden **"Sakin Telemetri Çubuğu"**dur. 
* İki tonlu mikro doluluk çubuğu ve minimalist yeşil/mavi durum noktası ile gösterilir.
* Yanıp sönen, parlayan neon efektler barındırmaz.

---

## 6. Dil ve İletişim Tonu (Product Copy Guidelines)

* Pazarlama abartılarından arındırılmış, doğrudan eylemi belirten Türkçe ürün dili:
  * ❌ *“AI destekli güçlü içgörüler ile devrim yaratın”*
  * ✅ *“Verileri yükle ve analizi başlat”*
  * ❌ *“Geleceği tahmin eden yapay zekâ motoru”*
  * ✅ *“Gelecek dönem satış tahmini oluştur”*
