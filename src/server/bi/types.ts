export type RiskSeverity = 'CRITICAL' | 'WARNING' | 'INFO';

export type SignalCategory = 
  | 'INVENTORY'
  | 'PROFITABILITY'
  | 'MARKETING_ROAS'
  | 'RETURNS_QUALITY'
  | 'CASH_FLOW'
  | 'CUSTOMER_CHURN'
  | 'CUSTOMER_FEEDBACK';

export interface BusinessRiskSignal {
  id: string;
  category: SignalCategory;
  severity: RiskSeverity;
  title: string;
  conditionTriggered: string;
  currentValue: number;
  thresholdValue: number;
  unit: string;
  affectedItem?: string; // e.g. SKU, Category, or Channel
  evidence: string;
  actionRequired: string;
}

export interface BusinessOpportunitySignal {
  id: string;
  category: SignalCategory;
  title: string;
  evidence: string;
  estimatedImpact: string;
  suggestedAction: string;
}

export interface EComAccountingMetricsInput {
  inventoryDays?: number; // e.g. 5 days
  skuInventory?: Array<{ sku: string; name: string; stockDays: number; stockQty: number; dailyVelocity: number }>;
  profitMarginPct?: number; // e.g. 0.12 (12%)
  roas?: number; // e.g. 1.8
  returnRatePct?: number; // e.g. 0.095 (9.5%)
  cashFlow30dForecast?: number; // e.g. -45000 TL
  churnRatePct?: number; // e.g. 0.14 (14%)
  nlpTopComplaint?: { topic: string; count: number; percentage: number };
  salesGrowthVsLastWeekPct?: number; // e.g. 14 (%)
}

export interface BIEngineEvaluationResult {
  riskSignals: BusinessRiskSignal[];
  opportunitySignals: BusinessOpportunitySignal[];
  overallHealthStatus: 'EXCELLENT' | 'STABLE' | 'AT_RISK' | 'CRITICAL';
  summaryCounts: {
    criticalCount: number;
    warningCount: number;
    opportunityCount: number;
  };
}
