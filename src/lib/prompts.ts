export const SYSTEM_PROMPT = `Sen E-Ticaret, Muhasebe ve İş Analitiği alanında uzmanlaşmış Yapay Zekâ Destekli Dijital İş Analistisin (Decision Support System).
İşletme sahibinin yanında çalışan dijital bir veri ve iş analisti olarak hareket et.

Temel Yönergeler ve Öncelik Kuralları:
1. BİRİNCİL ÖNCELİK (KULLANICI İSTEMİ VE SORUSU): Kullanıcının yazdığı mesaj, soru, talimat veya senaryo HER ZAMAN BİRİNCİL ÖNCELİKTİR. Yanıtın ilk ve en önemli amacı kullanıcının sorduğu soruya ve yazdığı noktalara doğrudan ve öncelikli cevap vermektir.
2. DESTEKLEYİCİ ML VE HESAPLANMIŞ VERİ BAĞLAMI: Sunucuda hesaplanmış veri ve ML analizleri (tahmin/olasılık), KPI sonuçları ve risk analizleri kullanıcının sorusunu yanıtlamak ve desteklemek için birer referans verisidir. Kullanıcının sorduğu konuyu göz ardı edip rastgele ML verisi dökme; ML verilerini kullanıcının sorusunu açıklamak için kullan.
3. KULLANICI SENARYOLARI VE ÖNERİLERİ: Kullanıcı özel bir varsayım, strateji veya soru belirttiğinde, bunu dikkatle ele al. Kullanıcının sorusuna doğrudan, analitik ve yapıcı yanıt ver.
4. METİN VERİLERİ: Müşteri yorumları/destek talepleri için ham metni listelemek yerine NLP katmanının sunduğu özet ve problem kümelerini kullan.
5. FORMATLAMA: Para değerlerini Türkçe para birimi formatında (örneğin ₺145.000,00) göster.
6. KULLANICI DOSTU YANITLAR: Ham JSON veya hesaplama kod bloğu paylaşma. Net yönetici özetleri, risk açıklamaları ve doğrudan aksiyon adımları sun.
`;

export function sanitizeQuery(query: string): string {
  if (!query) return '';
  let sanitized = query.trim().substring(0, 1000);
  sanitized = sanitized.replace(/[\x00-\x1F\x7F-\x9F]/g, '');
  return sanitized;
}

export function cleanAssistantAnswer(answer: string, allowDialogueFormat = false): string {
  let cleaned = answer
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<\/?think>/gi, '')
    .trim();

  if (!cleaned || allowDialogueFormat) return cleaned;

  const result: string[] = [];
  let waitingForAnswer = false;

  for (const line of cleaned.split(/\r?\n/)) {
    const plain = line.trim().replace(/^[#>*\-\s]+/, '').replace(/\*\*/g, '');
    const isQuestionSpeaker = /^(?:soru|kullanıcı|user)\s*:/i.test(plain);
    const isAnswerSpeaker = /^(?:cevap|yanıt|asistan|assistant)\s*:/i.test(plain);

    if (isQuestionSpeaker) {
      if (result.some((item) => item.trim())) break;
      waitingForAnswer = true;
      continue;
    }

    if (isAnswerSpeaker) {
      if (result.some((item) => item.trim())) break;
      const directAnswer = plain.replace(/^(?:cevap|yanıt|asistan|assistant)\s*:\s*/i, '');
      if (directAnswer) result.push(directAnswer);
      waitingForAnswer = false;
      continue;
    }

    if (waitingForAnswer) continue;
    result.push(line);
  }

  cleaned = result.join('\n').trim();
  cleaned = cleaned
    .split(/\r?\n/)
    .map((line) => {
      const sentences = line.match(/[^.!?]+[.!?]?/g) || [];
      return sentences.filter((sentence) => !sentence.trim().endsWith('?')).join('').trim();
    })
    .filter(Boolean)
    .join('\n')
    .trim();
  return cleaned;
}
