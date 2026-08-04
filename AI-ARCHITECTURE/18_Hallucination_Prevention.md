# 18 - Halüsinasyon Önleme Mimari Bariyerleri (Hallucination Prevention)

## 🛡️ Anti-Hallucination Güvenlik Duvarı

Yapay zeka modellerinin sayısal veri uydurmasını engellemek için sistemde 4 aşamalı mimari bariyer uygulanmaktadır:

```
[Kullanıcı İsteği] ---> [BI Engine Kural Kontrolü] ---> [<dogrulanmis_analiz> JSON Enjeksiyonu] ---> [LLM Sadece Anlatım Yapar]
```

1. **Strict Data Separation**: Tüm metrikler LLM'e girmeden önce kod tarafında hesaplanır.
2. **Explicit Evidence Schema**: LLM promptuna veriler `<dogrulanmis_analiz>` etiketiyle verilir.
3. **System Prompt Guardrails**: Prompt içerisinde "Veride olmayan hiçbir sayıyı kullanma" kuralı kesin olarak koyulur.
4. **Fallback Guard**: Veri kalitesi yetersizse LLM'e istek atılmadan doğrudan veri kalitesi uyarısı döndürülür.
