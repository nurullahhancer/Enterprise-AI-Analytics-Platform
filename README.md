# 🚀 Enterprise AI Analytics Platform

[![Node.js](https://img.shields.io/badge/Node.js-v22.x-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![React](https://img.shields.io/badge/React-v19.x-61DAFB?logo=react&logoColor=black)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-v5.x-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![FastAPI](https://img.shields.io/badge/FastAPI-v0.110+-009688?logo=fastapi&logoColor=white)](https://fastapi.tiangolo.com/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-v17-4169E1?logo=postgresql&logoColor=white)](https://www.postgresql.org/)
[![Docker](https://img.shields.io/badge/Docker-Ready-2496ED?logo=docker&logoColor=white)](https://www.docker.com/)
[![License](https://img.shields.io/badge/License-Proprietary-red.svg)](#)

> **Enterprise AI Analytics Platform**, kurumların karmaşık veri kaynaklarını (CSV, JSON, REST API) güvenli biçimde tek analiz kapsamında topladığı; otomatik ETL, gerçek Makine Öğrenimi (ML) tahminlemesi, anomali tespiti ve üretken yapay zekâ (LLM) yorumlaması sunduğu **çok kiracılı (Multi-Tenant) B2B SaaS** platformudur.

---

## 📌 İçindekiler
- [Genel Mimari](#-genel-mimari)
- [Öne Çıkan Özellikler](#-öne-çıkan-özellikler)
- [Teknoloji Yığını](#-teknoloji-yığını)
- [Kurulum & Hızlı Başlangıç](#-kurulum--hızlı-başlangıç)
- [Yetkilendirme ve Rol Yönetimi (RBAC)](#-yetkilendirme-ve-rol-yönetimi-rbac)
- [Ortam Değişkenleri (.env)](#-ortam-değişkenleri-env)
- [Test ve Doğrulama](#-test-ve-doğrulama)
- [Güvenlik ve Mimari İlkeleri](#-güvenlik-ve-mimari-ilkeleri)

---

## 🏗️ Genel Mimari

Uygulama, yüksek güvenlik standartlarına uygun olarak mikroservis benzeri bir konteyner mimarisi ile çalışır. Dış dünya yalnızca Nginx SSL/TLS ters proxy üzerinden iletişim kurar; ML servisi dış ağa kapalıdır.

```text
  [ Tarayıcı / Mobil ]
           │ (HTTPS / SSL - Port 443)
           ▼
     ┌──────────┐
     │  Nginx   │  (SSL Termination & Reverse Proxy)
     └────┬─────┘
          │ (Internal loopback: 127.0.0.1:3000)
          ▼
  ┌───────────────────────────────────────────────────────────┐
  │  Node.js (Express API) + React SPA (Vite)                │
  │  - Session Management & Scrypt JWT Authentication        │
  │  - Row Level Security (RLS) & Multi-Tenant Routing       │
  └───────────────┬───────────────────────────┬───────────────┘
                  │                           │
  (Internal Docker Net)                       │ (DB Connection)
                  ▼                           ▼
       ┌──────────────────┐        ┌──────────────────┐
       │ FastAPI Service  │        │  PostgreSQL 17   │
       │ (Scikit-learn/   │        │  (Forced RLS     │
       │  Pandas ML)      │        │   Isolation)     │
       └──────────────────┘        └──────────────────┘
```

---

## 🌟 Öne Çıkan Özellikler

### 📊 1. Gelişmiş ML Analitik & Tahmin Motoru
* **Zaman Serisi Tahminleme (Forecasting)**: Chronological holdout ile `MAE`, `RMSE`, `R²` ve `SMAPE` metriklerini hesaplayan doğrulanabilir `LinearRegression` tahmin modelleri.
* **Anomali Tespiti**: `IsolationForest` algoritması ile şüpheli veya aykırı veri satırlarının otomatik tespiti.
* **Müşteri & Veri Segmentasyonu**: `K-Means Clustering` ile veri noktalarının otomatik gruplanması.
* **Otomatik Sınıflandırma**: `Logistic Regression` ile ikili sınıflandırma (F1-score, Precision, Recall, ROC-AUC).

### 🛡️ 2. Kurumsal Güvenlik & Çoklu Kiracılık (Multi-Tenancy)
* **PostgreSQL Forced RLS**: Veritabanı seviyesinde kiracı izolasyonu. Kullanıcıların verisi kesinlikle diğer organizasyonlarla karışmaz.
* **Granüler Yetkilendirme (RBAC)**: `Admin`, `Analyst` ve `Viewer` rolleri ile dinamik arayüz ve API erişim kısıtlaması.
* **Audit & Denetim Günlüğü**: Kullanıcıların tüm kritik işlemleri (giriş, veri yükleme, analiz, rol değişimi) değiştirilemez log kayıtları olarak saklanır.

### 💳 3. B2B SaaS ve Faturalandırma Altyapısı
* **iyzico Abonelik Entegrasyonu**: Başlangıç, Profesyonel ve Kurumsal paketler için iyzico hosted checkout altyapısı.
* **Kota ve Limit Yönetimi**: Aylık AI/ML kullanım sayaçları, veri boyutu ve üye kısıtlamaları.

### 🔄 4. Veri İşleme (ETL) ve Konnektörler
* **CSV / JSON İçe Aktarım**: Büyük dosyalar için gelişmiş yükleme ve tip algılama.
* **REST API Konnektörü**: Şifrelenmiş (AES-256-GCM) ve SSRF korumalı dış REST kaynaklarından anlık görüntü senkronizasyonu.
* **ETL Pipeline**: Medyan doldurma, IQR aykırı değer temizleme, otomatik şema eşleştirme ve `kaynak_dosya` izleme (lineage).

### 🤖 5. Üretken Yapay Zeka (LLM) & RAG Doküman Havuzu
* **AI İş Yorumları**: Gerçekleştirilen ML analiz çıktılarının NVIDIA / Gemini modelleri ile doğal dile dönüştürülmesi.
* **PDF & TXT Doküman RAG Havuzu**: PDF ve TXT belgelerinden metin çıkarımı ve belgeler üzerinden bağlamsal AI sohbeti.

---

## 🛠️ Teknoloji Yığını

| Katman | Teknolojiler |
|---|---|
| **Frontend** | React 19, Vite, TypeScript, TailwindCSS, Lucide Icons |
| **Backend API** | Node.js 22, Express.js, TypeScript, Scrypt, JWT |
| **Veritabanı** | PostgreSQL 17 (Forced RLS), SQLite (Dev/Migration) |
| **ML Engine** | Python 3.11+, FastAPI, Scikit-learn, Pandas, NumPy |
| **Ters Proxy & Sunucu** | Nginx, Docker Engine, Docker Compose v2 |
| **Mobil Kabuk** | Capacitor (Android) |

---

## 🚀 Kurulum & Hızlı Başlangıç

### Gereksinimler
- Linux VDS / Sunucu (Ubuntu 22.04 LTS önerilir)
- Docker Engine & Docker Compose v2

### 1. Depoyu Klonlayın ve Ortam Dosyasını Hazırlayın
```bash
git clone https://github.com/nurullahhancer/Enterprise-AI-Analytics-Platform.git
cd Enterprise-AI-Analytics-Platform
cp .env.example .env
chmod 600 .env
```

### 2. .env Dosyasını Yapılandırın
`.env` içerisindeki kritik anahtarları güncelleyin:
```env
JWT_SECRET=en_az_32_karakterlik_tahmin_edilemez_gizli_anahtar
DATA_ENCRYPTION_KEY=32_baytlik_base64_veya_64_karakter_hex_aes_anahtari
BOOTSTRAP_ADMIN_EMAIL=admin@kurumunuz.com
BOOTSTRAP_ADMIN_TOKEN=en_az_32_karakterlik_bootstrap_secret
APP_URL=https://sunucu-ip-veya-domain.com
```

### 3. Konteynerleri Başlatın
```bash
docker compose up -d --build
```

### 4. İlk Yönetici Hesabını Oluşturun
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

---

## 👥 Yetkilendirme ve Rol Yönetimi (RBAC)

| İşlem / Yetki | Admin | Analyst | Viewer |
|---|:---:|:---:|:---:|
| Dashboard, Grafik ve Rapor Görüntüleme | ✅ | ✅ | ✅ |
| CSV, JSON ve Doküman Yükleme | ✅ | ✅ | ❌ |
| ETL İş Akışı Çalıştırma | ✅ | ✅ | ❌ |
| ML Analizi ve Tahmin Çalıştırma | ✅ | ✅ | ✅ |
| REST API Konnektörü Ekleme / Silme | ✅ | ❌ | ❌ |
| REST Konnektöründen İnceleme (Ingest) | ✅ | ✅ | ❌ |
| Kullanıcı Rolü Değiştirme & Doküman Silme | ✅ | ❌ | ❌ |

---

## ⚙️ Ortam Değişkenleri (.env)

Eksiksiz yapılandırma seçenekleri `.env.example` dosyasında yer almaktadır.

| Değişken | Açıklama |
|---|---|
| `APP_URL` | Uygulamanın dış dünyaya açık HTTPS adresi |
| `JWT_SECRET` | 32+ karakterlik JWT imzalama anahtarı |
| `DATABASE_URL` | PostgreSQL bağlantı adresi (`NOBYPASSRLS` erişim rolü ile) |
| `DATA_ENCRYPTION_KEY` | Konnektör şifrelemeleri için AES-256 key |
| `ML_SERVICE_URL` | İç Docker ağındaki FastAPI servis adresi (`http://ml-service:8000`) |
| `IYZICO_*` | iyzico abonelik checkout ve V3 webhook anahtarları |
| `NVIDIA_API_KEY` / `GEMINI_API_KEY` | İsteğe bağlı LLM yapay zeka entegrasyonu anahtarı |

---

## 🧪 Test ve Doğrulama

Birim ve entegrasyon testlerini çalıştırmak için:

```bash
# Lokal ortam doğrulaması
npm test

# Docker konteyner test suitleri
docker compose --profile test build app-test ml-test
docker compose --profile test run --rm app-test
docker compose --profile test run --rm ml-test
```

---

## 🔒 Güvenlik ve Mimari İlkeleri

- **Fail-Closed Authentication**: `JWT_SECRET` eksik veya geçersiz olduğunda kimlik doğrulama servisi güvenli biçimde kapalı kalır.
- **SSRF Koruması**: REST konnektörlerinde iç ağ IP'lerine (127.0.0.1, 10.x.x.x vb.) erişim yasaktır, yalnızca allowlist adreslerine izin verilir.
- **Formül Enjeksiyon Koruması**: Dışa aktarılan CSV raporlarında `=`, `+`, `-`, `@` ile başlayan hücre değerleri otomatik olarak temizlenir.
- **Scrypt Password Hashing**: Kullanıcı parolaları yüksek maliyetli `scrypt` algoritması ile özetlenir.

---

## 📄 Lisans & Telif Hakkı

Bu proje kurumsal kullanım ve SaaS lisanslamasına uygun olarak geliştirilmiştir.  
© 2026 **Enterprise AI Analytics Platform**. Tüm hakları saklıdır.
