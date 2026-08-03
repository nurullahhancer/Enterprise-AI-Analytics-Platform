import {
  EComAccountingMetricsInput,
  BIEngineEvaluationResult,
  BusinessRiskSignal,
  BusinessOpportunitySignal,
  RiskSeverity,
} from './types';

/**
 * Deterministic Business Intelligence Engine (BI Engine)
 * Evaluates ML predictions, KPIs, and NLP summaries against strict business rules.
 * Strictly prevents LLM from hallucinating business risks or thresholds.
 */
export class BIEngine {
  public static evaluate(input: EComAccountingMetricsInput): BIEngineEvaluationResult {
    const riskSignals: BusinessRiskSignal[] = [];
    const opportunitySignals: BusinessOpportunitySignal[] = [];

    // Rule 1: Stok Tükenme Riski (Inventory Runrate)
    if (input.skuInventory && input.skuInventory.length > 0) {
      for (const item of input.skuInventory) {
        if (item.stockDays < 7) {
          riskSignals.push({
            id: `risk-stock-critical-${item.sku}`,
            category: 'INVENTORY',
            severity: 'CRITICAL',
            title: `Kritik Stok Uyarısı: ${item.name} (${item.sku})`,
            conditionTriggered: 'stok_günü < 7',
            currentValue: item.stockDays,
            thresholdValue: 7,
            unit: 'gün',
            affectedItem: `${item.sku} - ${item.name}`,
            evidence: `Günlük ${item.dailyVelocity} adet satış hızına göre stok ${item.stockDays} gün içinde tükenecektir.`,
            actionRequired: `Tedarikçiye acil en az ${Math.ceil(item.dailyVelocity * 30)} adetlik sipariş oluşturun.`,
          });
        } else if (item.stockDays < 15) {
          riskSignals.push({
            id: `risk-stock-warning-${item.sku}`,
            category: 'INVENTORY',
            severity: 'WARNING',
            title: `Stok Azalma Uyarısı: ${item.name} (${item.sku})`,
            conditionTriggered: 'stok_günü < 15',
            currentValue: item.stockDays,
            thresholdValue: 15,
            unit: 'gün',
            affectedItem: `${item.sku} - ${item.name}`,
            evidence: `Mevcut stok (${item.stockQty} adet) 15 günden daha az bir süre içinde (${item.stockDays} gün) tükenecektir.`,
            actionRequired: 'Tedarik sipariş sürecini başlatın.',
          });
        }
      }
    } else if (input.inventoryDays !== undefined) {
      if (input.inventoryDays < 7) {
        riskSignals.push({
          id: 'risk-stock-general-critical',
          category: 'INVENTORY',
          severity: 'CRITICAL',
          title: 'Genel Stok Kritik Seviyede',
          conditionTriggered: 'stok_günü < 7',
          currentValue: input.inventoryDays,
          thresholdValue: 7,
          unit: 'gün',
          evidence: `Genel stok gün sayınız ${input.inventoryDays} güne düşmüştür.`,
          actionRequired: 'Acil stok tedarik planı oluşturun.',
        });
      }
    }

    // Rule 2: Karlılık Marjı (Profit Margin)
    if (input.profitMarginPct !== undefined) {
      const marginPctInt = Math.round(input.profitMarginPct * 100);
      if (input.profitMarginPct < 0.05) {
        riskSignals.push({
          id: 'risk-margin-critical',
          category: 'PROFITABILITY',
          severity: 'CRITICAL',
          title: 'Kritik Düşük Kâr Marjı',
          conditionTriggered: 'kar_marjı < %5',
          currentValue: marginPctInt,
          thresholdValue: 5,
          unit: '%',
          evidence: `Ortalama net kâr marjı %${marginPctInt} seviyesindedir (Kritik alt eşik: %5).`,
          actionRequired: 'Maliyet yapısını inceleyin ve indirim/promosyon oranlarını revize edin.',
        });
      } else if (input.profitMarginPct < 0.15) {
        riskSignals.push({
          id: 'risk-margin-warning',
          category: 'PROFITABILITY',
          severity: 'WARNING',
          title: 'Düşük Karlılık Marjı',
          conditionTriggered: 'kar_marjı < %15',
          currentValue: marginPctInt,
          thresholdValue: 15,
          unit: '%',
          evidence: `Mevcut net kâr marjı %${marginPctInt} seviyesindedir. Hedef kârlılık marjı min. %15 olmalıdır.`,
          actionRequired: 'Ürün bazlı maliyet ve komisyon oranlarını denetleyin.',
        });
      }
    }

    // Rule 3: Reklam Verimliliği (ROAS)
    if (input.roas !== undefined) {
      if (input.roas < 2.0) {
        riskSignals.push({
          id: 'risk-roas-critical',
          category: 'MARKETING_ROAS',
          severity: 'CRITICAL',
          title: 'Reklam Harcaması Verimsiz (Kritik ROAS)',
          conditionTriggered: 'ROAS < 2.0',
          currentValue: Number(input.roas.toFixed(2)),
          thresholdValue: 2.0,
          unit: 'x',
          evidence: `Reklam harcaması dönüşüm oranı (ROAS) ${input.roas.toFixed(2)}x seviyesine düşmüştür. Harcanan her 1 TL için 2 TL altında ciro üretilmektedir.`,
          actionRequired: 'Düşük dönüşümlü reklam kampanyalarını durdurun veya hedeflemeyi değiştirin.',
        });
      } else if (input.roas >= 4.0) {
        opportunitySignals.push({
          id: 'opp-roas-high',
          category: 'MARKETING_ROAS',
          title: 'Reklam Bütçesini Artırma Fırsatı',
          evidence: `Mevcut ROAS değeri ${input.roas.toFixed(2)}x ile oldukça yüksek performans göstermektedir.`,
          estimatedImpact: 'Ciroda %20-%35 ek artış potansiyeli.',
          suggestedAction: 'Başarılı kampanyaların günlük bütçesini kademeli olarak %25 artırın.',
        });
      }
    }

    // Rule 4: İade Oranı (Return Rate)
    if (input.returnRatePct !== undefined) {
      const returnPctInt = Number((input.returnRatePct * 100).toFixed(1));
      if (input.returnRatePct > 0.08) {
        riskSignals.push({
          id: 'risk-return-critical',
          category: 'RETURNS_QUALITY',
          severity: 'CRITICAL',
          title: 'Yüksek İade Oranı & Kalite Uyarısı',
          conditionTriggered: 'iade_oranı > %8',
          currentValue: returnPctInt,
          thresholdValue: 8.0,
          unit: '%',
          evidence: `İade oranı %${returnPctInt} ile belirlenen %8.0 kritik eşiğinin üzerine çıkmıştır.`,
          actionRequired: 'İade nedenlerini inceleyin (beden, kargo hasarı veya görsel uyuşmazlık).',
        });
      }
    }

    // Rule 5: Nakit Akışı Riski (Cash Flow)
    if (input.cashFlow30dForecast !== undefined && input.cashFlow30dForecast < 0) {
      riskSignals.push({
        id: 'risk-cashflow-critical',
        category: 'CASH_FLOW',
        severity: 'CRITICAL',
        title: 'Negatif Nakit Akışı Riski',
        conditionTriggered: 'nakit_akışı < 0',
        currentValue: input.cashFlow30dForecast,
        thresholdValue: 0,
        unit: 'TL',
        evidence: `Gelecek 30 günlük nakit akışı tahmini ${input.cashFlow30dForecast.toLocaleString('tr-TR')} TL negatiftir.`,
        actionRequired: 'Alacakların tahsilatını hızlandırın ve vadesi gelen ödemeleri yeniden yapılandırın.',
      });
    }

    // Rule 6: Müşteri Terk Riski (Churn Rate)
    if (input.churnRatePct !== undefined && input.churnRatePct > 0.10) {
      const churnPctInt = Number((input.churnRatePct * 100).toFixed(1));
      riskSignals.push({
        id: 'risk-churn-warning',
        category: 'CUSTOMER_CHURN',
        severity: 'WARNING',
        title: 'Müşteri Kayıp Riski Yüksek',
        conditionTriggered: 'churn_rate > %10',
        currentValue: churnPctInt,
        thresholdValue: 10.0,
        unit: '%',
        evidence: `Son 60 günde tekrar sipariş vermeyen müşteri oranı %${churnPctInt} seviyesine ulaşmıştır.`,
        actionRequired: 'Sık alışveriş yapan müşterilere özel e-posta re-engagement kampanyaları başlatın.',
      });
    }

    // Rule 7: NLP Müşteri Şikayet Trendi
    if (input.nlpTopComplaint && input.nlpTopComplaint.percentage > 20) {
      riskSignals.push({
        id: 'risk-nlp-complaint',
        category: 'CUSTOMER_FEEDBACK',
        severity: input.nlpTopComplaint.percentage > 30 ? 'CRITICAL' : 'WARNING',
        title: `Müşteri Şikayet Yoğunluğu: ${input.nlpTopComplaint.topic}`,
        conditionTriggered: 'nlp_şikayet_oranı > %20',
        currentValue: input.nlpTopComplaint.percentage,
        thresholdValue: 20,
        unit: '%',
        evidence: `Müşteri yorumlarının %${input.nlpTopComplaint.percentage}'si (${input.nlpTopComplaint.count} yorum) "${input.nlpTopComplaint.topic}" konusunda olumsuzdur.`,
        actionRequired: `Lojistik / Paketleme operasyon ekibiyle "${input.nlpTopComplaint.topic}" aksiyon planı oluşturun.`,
      });
    }

    // Growth opportunity
    if (input.salesGrowthVsLastWeekPct !== undefined && input.salesGrowthVsLastWeekPct > 10) {
      opportunitySignals.push({
        id: 'opp-sales-growth',
        category: 'PROFITABILITY',
        title: 'Hızlı Satış Büyüme Trendi',
        evidence: `Satışlar geçen haftaya kıyasla %${input.salesGrowthVsLastWeekPct} artış göstermiştir.`,
        estimatedImpact: 'Haftalık ciroda sürdürülebilir yükseliş.',
        suggestedAction: 'Büyüyen kategorilerdeki popüler ürünlerin stoklarını kontrol edin.',
      });
    }

    // Evaluate Overall Status
    const criticalCount = riskSignals.filter((s) => s.severity === 'CRITICAL').length;
    const warningCount = riskSignals.filter((s) => s.severity === 'WARNING').length;
    const opportunityCount = opportunitySignals.length;

    let overallHealthStatus: 'EXCELLENT' | 'STABLE' | 'AT_RISK' | 'CRITICAL' = 'EXCELLENT';
    if (criticalCount >= 2) overallHealthStatus = 'CRITICAL';
    else if (criticalCount === 1 || warningCount >= 2) overallHealthStatus = 'AT_RISK';
    else if (warningCount === 1) overallHealthStatus = 'STABLE';

    return {
      riskSignals,
      opportunitySignals,
      overallHealthStatus,
      summaryCounts: {
        criticalCount,
        warningCount,
        opportunityCount,
      },
    };
  }
}
