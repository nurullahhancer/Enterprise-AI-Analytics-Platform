import { describe, expect, it } from 'vitest';
import { cleanAssistantAnswer } from './prompts';

describe('cleanAssistantAnswer', () => {
  it('keeps only the answer when a model starts a self-generated Q&A dialogue', () => {
    const answer = cleanAssistantAnswer('Soru: Gelecek ay ne olur?\nCevap: Yaklaşık 120 satış bekleniyor.\nSoru: Peki neden?\nCevap: Çünkü trend yükseliyor.');

    expect(answer).toBe('Yaklaşık 120 satış bekleniyor.');
  });

  it('removes hidden thinking blocks and keeps a normal direct answer unchanged', () => {
    const answer = cleanAssistantAnswer('<think>Kendime birkaç soru sorayım.</think>Satışlarda artış bekleniyor.');

    expect(answer).toBe('Satışlarda artış bekleniyor.');
  });

  it('allows a dialogue format when the user explicitly requests it', () => {
    const source = 'Soru: Satış nedir?\nCevap: Gerçekleşen işlemlerin toplamıdır.';

    expect(cleanAssistantAnswer(source, true)).toBe(source);
  });

  it('removes rhetorical questions produced by the assistant but keeps their direct answers', () => {
    const answer = cleanAssistantAnswer('Satışlar yükseliyor. Bunun anlamı nedir? Stok hazırlığını artırın.\nNeden? Son dönem değeri daha yüksek.');

    expect(answer).toBe('Satışlar yükseliyor. Stok hazırlığını artırın.\nSon dönem değeri daha yüksek.');
  });
});
