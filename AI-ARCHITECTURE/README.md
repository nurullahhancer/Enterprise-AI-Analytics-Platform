# Enterprise AI Analytics Platform - AI Mimari Dokümantasyonu (AI-ARCHITECTURE)

Bu dizin, **Enterprise AI Analytics Platform** projesinin yapay zeka, makine öğrenimi (ML), Business Intelligence (BI) kural motoru, RAG (Retrieval-Augmented Generation), KPI ve güvenlik mimarisini en ince ayrıntısına kadar açıklayan 25 temel mimari dokümanı içerir.

---

## 📌 Doküman Haritası (Table of Contents)

| No | Doküman Adı | Açıklama |
|---|---|---|
| **01** | [`01_Product_Vision.md`](./01_Product_Vision.md) | Ürün vizyonu, hedef kitle (CFO, E-ticaret Yöneticisi), iş değerleri. |
| **02** | [`02_System_Philosophy.md`](./02_System_Philosophy.md) | Deterministik BI Engine ve LLM ayrımı, halüsinasyonsuz karar desteği. |
| **03** | [`03_Master_System_Prompt.md`](./03_Master_System_Prompt.md) | Ana sistem promptu, tonlama, kanıt dayanaklı yanıt kuralları. |
| **04** | [`04_Data_Analysis_Engine.md`](./04_Data_Analysis_Engine.md) | CSV/JSON/XLSX ayrıştırma, otomatik veri profili ve kolon tipi tespiti. |
| **05** | [`05_ML_Architecture.md`](./05_ML_Architecture.md) | Zaman serisi tahmini (SARIMAX/Linear), anomali tespiti, K-Means segmentasyon. |
| **06** | [`06_NLP_Architecture.md`](./06_NLP_Architecture.md) | Müşteri yorumları NLP motoru, TF-IDF ve şikayet kümeleme algoritması. |
| **07** | [`07_Business_Intelligence_Engine.md`](./07_Business_Intelligence_Engine.md) | Deterministik BI kural motoru, 7 temel iş kuralı ve risk tetikleyicileri. |
| **08** | [`08_LLM_Architecture.md`](./08_LLM_Architecture.md) | Çoklu LLM sağlayıcı mimarisi (OpenAI, Anthropic, Gemini), kota ve rate-limit. |
| **09** | [`09_RAG_Architecture.md`](./09_RAG_Architecture.md) | Kurumsal doküman vektörleştirme, anlamsal arama ve bağlam enjeksiyonu. |
| **10** | [`10_Response_Generation.md`](./10_Response_Generation.md) | `<dogrulanmis_analiz>` etiketleri ile kanıta dayalı rapor ve aksiyon üretimi. |
| **11** | [`11_Ecommerce_Analytics.md`](./11_Ecommerce_Analytics.md) | E-ticaret metrikleri: SKU satış hızı, stok tükenme günü, iade oranı. |
| **12** | [`12_Accounting_Analytics.md`](./12_Accounting_Analytics.md) | Muhasebe ve finans metrikleri: 30 günlük nakit akışı tahmini, brüt kâr marjı. |
| **13** | [`13_Dashboard_Rules.md`](./13_Dashboard_Rules.md) | Dinamik dashboard şablonu tespiti, widget önerme algoritması. |
| **14** | [`14_Action_Plan_Generation.md`](./14_Action_Plan_Generation.md) | Risk sinyallerinden önceliklendirilebilir aksiyon planları türetme. |
| **15** | [`15_Risk_Analysis.md`](./15_Risk_Analysis.md) | Kritik ve uyarı seviyesinde iş riski taksonomisi ve eşik değerleri. |
| **16** | [`16_KPI_Engine.md`](./16_KPI_Engine.md) | Dinamik KPI tanımlama, toplulaştırma ve ihlal bildirimi motoru. |
| **17** | [`17_Confidence_System.md`](./17_Confidence_System.md) | Heuristik ve istatistiksel güven skoru (linearConfidence, MAE, RMSE, R²). |
| **18** | [`18_Hallucination_Prevention.md`](./18_Hallucination_Prevention.md) | Yapay zeka uydurmasını (hallucination) engelleyen deterministik veri bariyerleri. |
| **19** | [`19_JSON_Output_Standards.md`](./19_JSON_Output_Standards.md) | API şemaları, standart hata nesnesi biçimi ve CSV dışa aktarım formatı. |
| **20** | [`20_API_Architecture.md`](./20_API_Architecture.md) | Express REST API rotaları haritası (`/api/dashboard`, `/api/ml`, `/api/kpi` vb.). |
| **21** | [`21_Testing.md`](./21_Testing.md) | Vitest birim/entegrasyon testleri, pytest ML testleri ve CI/CD süreçleri. |
| **22** | [`22_Security.md`](./22_Security.md) | JWT kimlik doğrulama, PostgreSQL RLS, RBAC yetkilendirme ve audit log. |
| **23** | [`23_Coding_Standards.md`](./23_Coding_Standards.md) | TypeScript ve Python kod standartları, modüler mimari ilkeleri. |
| **24** | [`24_Prompt_Library.md`](./24_Prompt_Library.md) | Sistem genelindeki tüm prompt kataloğu ve parametre şablonları. |
| **25** | [`25_Future_Roadmap.md`](./25_Future_Roadmap.md) | Platformun gelecek vizyonu, canlı veri akışı, multi-modal ve otonom ajanlar. |

---

## 🛠️ Mimari Bileşenler Diyagramı

```
+-----------------------------------------------------------------------+
|                             KULLANICI ARAYÜZÜ (React + TypeScript + Vite)                          |
|  [Dashboard]  [Decision Center]  [Analysis Studio]  [Data Import]  [AI Chat]  [SaaS Management]  |
+------------------------------------+----------------------------------+
                                     | REST API (JWT & Dynamic Organization Scope)
+------------------------------------+----------------------------------+
|                            EXPRESS.JS BACKEND SUNUCUSU                        |
|                                                                       |
|  +-----------------------------------------------------------------+  |
|  |                    DETERMINISTIC BI ENGINE                      |  |
|  | - 7 Temel İş Kuralı (Stok, Marj, ROAS, İade, Nakit, Churn, NLP) |  |
|  +--------------------------------+--------------------------------+  |
|                                   |                                   |
|  +--------------------------------+--------------------------------+  |
|  |                    VERİ VE ML PİPELİNE MOTORU                    |  |
|  | - CSV/JSON/XLSX Parser         - Dinamik Veri Profili          |  |
|  | - Zaman Serisi Tahmini          - Z-Score Anomali Tespiti       |  |
|  | - Dinamik NLP Yorum Analizi     - Şablon & Widget Öneri Engine  |  |
|  +--------------------------------+--------------------------------+  |
|                                   |                                   |
|  +--------------------------------+--------------------------------+  |
|  |                      LLM PROVIDER SERVİSİ                       |  |
|  | - OpenAI / Anthropic / Gemini   - Anti-Hallucination Guardrails |  |
|  | - AI Kredileri & Rate Limiting  - RAG Vektör Arama Katmanı     |  |
|  +--------------------------------+--------------------------------+  |
+------------------------------------+----------------------------------+
                                     |
+------------------------------------+----------------------------------+
|                          VERİ TABANI VE ML SERVİSİ                     |
|  - PostgreSQL (RLS Çok Kiracılı Isolation) / SQLite Local DB          |
|  - FastAPI Microservice (Python ML Heavy Computation)                 |
+-----------------------------------------------------------------------+
```
