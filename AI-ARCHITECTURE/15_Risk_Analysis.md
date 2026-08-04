# 15 - Risk Analizi ve Taksonomisi (Risk Analysis)

## ⚠️ Risk Seviyeleri ve Kategori Taksonomisi

Platformda tespit edilen riskler 3 temel seviyeye ayrılır:

```ts
export type RiskSeverity = 'CRITICAL' | 'WARNING' | 'INFO';
```

---

## 📊 Risk Taksonomisi Tablosu

| Risk Kategorisi | Risk Adı | Tetiklenme Koşulu | Seviye |
|---|---|---|---|
| **INVENTORY** | Stok Tükenme Riski | `stok_günü < 7` | **CRITICAL** |
| **INVENTORY** | Stok Azalma Uyarısı | `stok_günü < 15` | **WARNING** |
| **PROFITABILITY** | Kritik Düşük Marj | `kar_marjı < %5` | **CRITICAL** |
| **MARKETING_ROAS** | Düşük ROAS | `ROAS < 2.0` | **CRITICAL** |
| **RETURNS_QUALITY** | Yüksek İade Oranı | `iade_oranı > %8.0` | **CRITICAL** |
| **CASH_FLOW** | Negatif Nakit Akışı | `nakit_akışı < 0 TL` | **CRITICAL** |
| **CUSTOMER_CHURN** | Müşteri Kayıp Riski | `churn_rate > %10.0` | **WARNING** |
| **CUSTOMER_FEEDBACK**| Müşteri Şikayet Yüksekliği | `şikayet_oranı > %20` | **WARNING / CRITICAL** |
