export type PlanKey = 'starter' | 'professional' | 'enterprise';
export type UsageMetric = 'ai_requests' | 'ml_runs';

export interface PlanDefinition {
  key: PlanKey;
  name: string;
  description: string;
  monthlyPriceLabel: string;
  billingPlanEnv?: string;
  limits: {
    members: number;
    datasets: number;
    connectors: number;
    documents: number;
    documentChars: number;
    aiRequests: number;
    mlRuns: number;
  };
}

export const PLAN_DEFINITIONS: Record<PlanKey, PlanDefinition> = {
  starter: {
    key: 'starter',
    name: 'Başlangıç',
    description: 'Tek çalışma alanında 3 kişiye kadar ücretsiz kullanım.',
    monthlyPriceLabel: 'Ücretsiz',
    limits: {
      members: 3,
      datasets: 10,
      connectors: 2,
      documents: 10,
      documentChars: 500_000,
      aiRequests: 100,
      mlRuns: 25,
    },
  },
  professional: {
    key: 'professional',
    name: 'Profesyonel',
    description: 'Tek abonelikle 15 kişiye kadar düzenli analiz yapan ekipler için.',
    monthlyPriceLabel: 'Aylık abonelik',
    billingPlanEnv: 'IYZICO_PLAN_PROFESSIONAL',
    limits: {
      members: 15,
      datasets: 100,
      connectors: 20,
      documents: 100,
      documentChars: 10_000_000,
      aiRequests: 5_000,
      mlRuns: 1_000,
    },
  },
  enterprise: {
    key: 'enterprise',
    name: 'Kurumsal',
    description: 'Tek sözleşmeyle büyük ekipler, yüksek veri hacmi ve özel limitler için.',
    monthlyPriceLabel: 'Özel fiyat',
    billingPlanEnv: 'IYZICO_PLAN_ENTERPRISE',
    limits: {
      members: 250,
      datasets: 500,
      connectors: 100,
      documents: 500,
      documentChars: 20_000_000,
      aiRequests: 50_000,
      mlRuns: 10_000,
    },
  },
};

export function isPlanKey(value: unknown): value is PlanKey {
  return typeof value === 'string' && value in PLAN_DEFINITIONS;
}

export function getPlan(key: unknown): PlanDefinition {
  return PLAN_DEFINITIONS[isPlanKey(key) ? key : 'starter'];
}

export function usageLimit(planKey: unknown, metric: UsageMetric): number {
  const plan = getPlan(planKey);
  return metric === 'ai_requests' ? plan.limits.aiRequests : plan.limits.mlRuns;
}
