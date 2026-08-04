# 08 - LLM Mimarisi (LLM & Multi-Provider Architecture)

## 🔌 Çoklu LLM Sağlayıcı Altyapısı (`src/server/ai/provider.ts`)

Platform, tek bir LLM sağlayıcısına bağımlı kalmamak adına esnek bir çoklu sağlayıcı (Multi-Provider) mimarisi kullanır.

```
+-----------------------------------------------------------------------+
|                      LLM PROVIDER ABSTRACTION                         |
|                                                                       |
|   [Express Route] ---> provider.ts ---> [OpenAI (GPT-4o)]            |
|                                     ---> [Anthropic (Claude 3.5)]    |
|                                     ---> [Google (Gemini 1.5/2.0)]   |
+-----------------------------------------------------------------------+
```

---

## 🛡️ Sağlayıcı Öncelik Sıralaması ve Fallback
1. Sistemde tanımlı etkin API anahtarları kontrol edilir (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`).
2. Ana sağlayıcı yanıt vermezse veya zaman aşımına uğrarsa (Timeout: 30 sn), sistem otomatik olarak ikincil sağlayıcıya geçer (Fallback mechanism).

---

## 💳 AI Kredi Yönetimi ve Rate-Limiting (`src/server/ai/quota.ts`)
- Her organizasyonun SaaS planına uygun AI kredi kotası bulunur.
- İstek öncesi `consumeUsage` çağrılarak kredi düşülür. Hata durumunda `refundUsage` ile kredi iade edilir.
- Birim zamanda yapılabilecek azami istek sayısı (Rate Limit) organizasyon bazında sınırlandırılmıştır.
