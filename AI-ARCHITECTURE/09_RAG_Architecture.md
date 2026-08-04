# 09 - RAG Mimarisi (Retrieval-Augmented Generation)

## 📚 Kurumsal Doküman Vektörleştirme ve Bilgi Erişimi

Enterprise AI Analytics Platform, işletmelerin PDF, Word, Excel ve sözleşme dokümanlarını RAG mimarisi ile analiz eder (`src/views/EnterpriseSuite.tsx` & `/api/enterprise/documents`).

---

## 🔄 RAG İş Akış Adımları

```
Doküman Yükleme  --->  Metin Parçalama (Chunking)  --->  Vektör Gömmeleri (Embeddings)  --->  Vektör Veritabanı Indeksi  --->  Soru-Cevap Anlamsal Arama
```

1. **Parçalama (Chunking)**: Dokümanlar 500-1000 karakterlik örtüşen (overlapping) parçalara bölünür.
2. **Vektörleştirme (Embeddings)**: Her parça yüksek boyutlu vektör uzayına dönüştürülür.
3. **Anlamsal Arama (Semantic Search)**: AI Chat üzerinden gelen soru ile en yüksek benzerlik skoru gösteren doküman parçaları filtrelenir.
4. **Bağlam Enjeksiyonu**: Bulunan parçalar LLM promptuna eklenerek kurumsal dokümanlara dayalı doğru yanıtlar üretilir.
