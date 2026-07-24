import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  ArrowRight,
  BarChart3,
  Building2,
  Check,
  CheckCircle2,
  CircleDollarSign,
  Copy,
  CreditCard,
  ExternalLink,
  Gauge,
  LoaderCircle,
  Mail,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  ShieldCheck,
  Trash2,
  UserPlus,
  Users,
  X,
} from 'lucide-react';
import { authHeaders, getApiUrl, jsonHeaders } from '../lib/api';
import { cn } from '../lib/utils';

export type SaaSRole = 'admin' | 'analyst' | 'viewer';
export type SaaSPlanKey = 'starter' | 'professional' | 'enterprise';
export type SaaSIdentifier = string | number;

export interface SaaSUser {
  id: string;
  name: string;
  email: string;
  role?: SaaSRole;
}

export interface SaaSOrganization {
  id: SaaSIdentifier;
  tenantId?: string;
  tenant_id?: string;
  name: string;
  slug?: string;
  role?: SaaSRole;
  planKey?: SaaSPlanKey;
  plan_key?: SaaSPlanKey;
  subscriptionStatus?: string;
  subscription_status?: string;
}

export interface SaaSMembership {
  id?: SaaSIdentifier;
  organizationId?: SaaSIdentifier;
  organization_id?: SaaSIdentifier;
  tenantId?: string;
  tenant_id?: string;
  organizationName?: string;
  organization_name?: string;
  organization?: SaaSOrganization;
  userId?: string;
  name?: string;
  email?: string;
  role: SaaSRole;
  status?: string;
  createdAt?: string;
  created_at?: string;
}

export interface SaaSManagementProps {
  section: 'team' | 'billing';
  user: SaaSUser;
  activeOrganization: SaaSOrganization | null;
  memberships: SaaSMembership[];
  onOrganizationSwitch: (organization: SaaSOrganization) => void | Promise<void>;
  onContextRefresh: () => void | Promise<void>;
}

interface OrganizationMember {
  id: SaaSIdentifier;
  userId?: string;
  name: string;
  email: string;
  role: SaaSRole;
  status: string;
  createdAt?: string;
  lastLoginAt?: string;
}

interface PendingInvitation {
  id: SaaSIdentifier;
  email: string;
  role: SaaSRole;
  status: string;
  expiresAt?: string;
}

interface UsageMeter {
  key: string;
  label: string;
  used: number;
  limit: number | null;
  remaining: number | null;
  unit?: string;
}

interface UsageSummary {
  planKey: SaaSPlanKey;
  subscriptionStatus: string;
  period?: { startsAt?: string; endsAt?: string };
  meters: UsageMeter[];
  limits: Record<string, number>;
  ai?: {
    used: number; baseLimit: number; bonusCredits: number; effectiveLimit: number; remaining: number;
    userUsed: number; userLimit: number | null; userRemaining: number | null; creditBalance: number;
    settings: { perUserMonthlyLimit: number | null; autoUsePrepaidCredits: boolean; autoCreditBundle: 1000 | 5000 };
  };
}

interface AiCreditPackage { quantity: 1000 | 5000; priceLabel: string; amountMinor: number | null; checkoutAvailable: boolean }

interface PlanDefinition {
  key: SaaSPlanKey;
  name: string;
  description: string;
  monthlyPriceLabel: string;
  limits: Record<string, number>;
  checkoutAvailable: boolean;
}

interface CheckoutCustomer {
  name: string;
  surname: string;
  email: string;
  gsmNumber: string;
  identityNumber: string;
  address: string;
  city: string;
  country: string;
  zipCode: string;
}

type WorkspaceTab = 'organization' | 'members' | 'usage' | 'billing';
type Notice = { type: 'success' | 'error'; text: string };
type JsonRecord = Record<string, unknown>;

const ROLE_LABELS: Record<SaaSRole, string> = {
  admin: 'Yönetici',
  analyst: 'Analist',
  viewer: 'Görüntüleyici',
};

const ROLE_STYLES: Record<SaaSRole, string> = {
  admin: 'border-indigo-200 bg-indigo-50 text-indigo-700 dark:border-[#FFD700]/25 dark:bg-[#FFD700]/10 dark:text-[#FFD700]',
  analyst: 'border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-500/25 dark:bg-sky-500/10 dark:text-sky-300',
  viewer: 'border-slate-200 bg-slate-50 text-slate-600 dark:border-white/10 dark:bg-white/5 dark:text-white/55',
};

const METER_LABELS: Record<string, string> = {
  members: 'Ekip üyeleri',
  datasets: 'Veri setleri',
  connectors: 'Veri bağlantıları',
  documents: 'Bilgi dosyaları',
  document_chars: 'Doküman hacmi',
  documentChars: 'Doküman hacmi',
  ai_requests: 'Yapay zekâ yanıtları',
  aiRequests: 'Yapay zekâ yanıtları',
  ml_runs: 'Analiz çalışmaları',
  mlRuns: 'Analiz çalışmaları',
};

const FALLBACK_PLANS: PlanDefinition[] = [
  {
    key: 'starter',
    name: 'Başlangıç',
    description: 'Tek çalışma alanında 3 kişiye kadar ücretsiz kullanım.',
    monthlyPriceLabel: 'Ücretsiz',
    checkoutAvailable: false,
    limits: { members: 3, datasets: 10, connectors: 2, documents: 10, aiRequests: 100, mlRuns: 25 },
  },
  {
    key: 'professional',
    name: 'Profesyonel',
    description: 'Tek abonelikle 15 kişiye kadar düzenli analiz yapan ekipler için.',
    monthlyPriceLabel: 'Aylık abonelik',
    checkoutAvailable: true,
    limits: { members: 15, datasets: 100, connectors: 20, documents: 100, aiRequests: 5_000, mlRuns: 1_000 },
  },
  {
    key: 'enterprise',
    name: 'Kurumsal',
    description: 'Tek sözleşmeyle büyük ekipler, yüksek veri hacmi ve özel limitler için.',
    monthlyPriceLabel: 'Özel fiyat',
    checkoutAvailable: true,
    limits: { members: 250, datasets: 500, connectors: 100, documents: 500, aiRequests: 50_000, mlRuns: 10_000 },
  },
];

const isRecord = (value: unknown): value is JsonRecord => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const textValue = (...values: unknown[]): string => {
  const value = values.find((candidate) => typeof candidate === 'string' && candidate.trim());
  return typeof value === 'string' ? value.trim() : '';
};

const numberValue = (value: unknown, fallback = 0): number => {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const roleValue = (value: unknown): SaaSRole => {
  const normalized = String(value || '').toLowerCase();
  return normalized === 'admin' || normalized === 'analyst' ? normalized : 'viewer';
};

const planKeyValue = (value: unknown): SaaSPlanKey => {
  const normalized = String(value || '').toLowerCase();
  return normalized === 'professional' || normalized === 'enterprise' ? normalized : 'starter';
};

const subscriptionStatusLabel = (value: unknown): string => {
  const status = String(value || '').trim().toLowerCase();
  const labels: Record<string, string> = {
    active: 'Ödeme aktif',
    trialing: 'Deneme sürümü',
    pending: 'Ödeme onayı bekleniyor',
    unpaid: 'Ödeme bekleniyor',
    canceled: 'İptal edildi',
    cancelled: 'İptal edildi',
    included: 'Ücretsiz kullanım',
    inactive: 'Etkin abonelik yok',
  };
  return labels[status] || (status ? status : 'Bilgi bekleniyor');
};

const organizationKey = (organization: SaaSOrganization | null | undefined): string => {
  if (!organization) return '';
  return String(organization.id ?? organization.tenantId ?? organization.tenant_id ?? '');
};

const membershipOrganizationKey = (membership: SaaSMembership): string => {
  return String(
    membership.organization?.id ??
    membership.organizationId ??
    membership.organization_id ??
    membership.tenantId ??
    membership.tenant_id ??
    '',
  );
};

const normalizeOrganization = (value: unknown): SaaSOrganization | null => {
  if (!isRecord(value)) return null;
  const id = value.id ?? value.organizationId ?? value.organization_id ?? value.tenantId ?? value.tenant_id;
  const name = textValue(value.name, value.organizationName, value.organization_name);
  if ((typeof id !== 'string' && typeof id !== 'number') || !name) return null;
  return {
    id,
    name,
    tenantId: textValue(value.tenantId, value.tenant_id) || undefined,
    slug: textValue(value.slug) || undefined,
    role: value.role ? roleValue(value.role) : undefined,
    planKey: value.planKey || value.plan_key ? planKeyValue(value.planKey ?? value.plan_key) : undefined,
    subscriptionStatus: textValue(value.subscriptionStatus, value.subscription_status) || undefined,
  };
};

const organizationFromMembership = (membership: SaaSMembership): SaaSOrganization | null => {
  if (membership.organization) return membership.organization;
  const id = membership.organizationId ?? membership.organization_id ?? membership.tenantId ?? membership.tenant_id;
  const name = membership.organizationName ?? membership.organization_name;
  if ((typeof id !== 'string' && typeof id !== 'number') || !name) return null;
  return { id, name, tenantId: membership.tenantId ?? membership.tenant_id, role: membership.role };
};

const uniqueOrganizations = (organizations: Array<SaaSOrganization | null>): SaaSOrganization[] => {
  const seen = new Map<string, SaaSOrganization>();
  organizations.forEach((organization) => {
    const key = organizationKey(organization);
    if (organization && key) seen.set(key, { ...seen.get(key), ...organization });
  });
  return [...seen.values()];
};

const listPayload = (payload: unknown, keys: string[]): unknown[] => {
  if (Array.isArray(payload)) return payload;
  if (!isRecord(payload)) return [];
  for (const key of keys) {
    if (Array.isArray(payload[key])) return payload[key] as unknown[];
  }
  return [];
};

const normalizeMember = (value: unknown): OrganizationMember | null => {
  if (!isRecord(value)) return null;
  const user = isRecord(value.user) ? value.user : {};
  const email = textValue(value.email, user.email);
  if (!email) return null;
  const id = value.id ?? value.membershipId ?? value.membership_id ?? user.id ?? email;
  return {
    id: typeof id === 'string' || typeof id === 'number' ? id : email,
    userId: textValue(value.userId, value.user_id, user.id) || undefined,
    name: textValue(value.name, user.name) || email.split('@')[0],
    email,
    role: roleValue(value.role),
    status: textValue(value.status) || 'active',
    createdAt: textValue(value.createdAt, value.created_at) || undefined,
    lastLoginAt: textValue(value.lastLoginAt, value.last_login_at) || undefined,
  };
};

const normalizeInvitation = (value: unknown): PendingInvitation | null => {
  if (!isRecord(value)) return null;
  const email = textValue(value.email);
  const id = value.id ?? value.invitationId ?? value.invitation_id;
  if (!email || (typeof id !== 'string' && typeof id !== 'number')) return null;
  return {
    id,
    email,
    role: roleValue(value.role),
    status: textValue(value.status) || 'pending',
    expiresAt: textValue(value.expiresAt, value.expires_at) || undefined,
  };
};

const normalizePlan = (value: unknown): PlanDefinition | null => {
  if (!isRecord(value)) return null;
  const key = planKeyValue(value.key ?? value.planKey ?? value.plan_key);
  const limitsRecord = isRecord(value.limits) ? value.limits : {};
  const limits = Object.fromEntries(
    Object.entries(limitsRecord)
      .map(([limitKey, limit]) => [limitKey, numberValue(limit, -1)] as const)
      .filter(([, limit]) => limit >= 0),
  );
  return {
    key,
    name: textValue(value.name) || FALLBACK_PLANS.find((plan) => plan.key === key)?.name || key,
    description: textValue(value.description) || FALLBACK_PLANS.find((plan) => plan.key === key)?.description || '',
    monthlyPriceLabel: textValue(value.monthlyPriceLabel, value.monthly_price_label, value.priceLabel) || 'Plan',
    limits,
    checkoutAvailable: value.checkoutAvailable !== false && key !== 'starter',
  };
};

const normalizeUsage = (payload: unknown): UsageSummary => {
  const source = isRecord(payload) ? payload : {};
  const metricsSource = isRecord(source.metrics) ? source.metrics : {};
  const limitsSource = isRecord(source.limits) ? source.limits : {};
  const explicitMeters = listPayload(source.meters, ['meters']);
  const meters: UsageMeter[] = explicitMeters.length > 0
    ? explicitMeters.flatMap((meterValue) => {
        if (!isRecord(meterValue)) return [];
        const key = textValue(meterValue.key, meterValue.metric);
        if (!key) return [];
        const limit = meterValue.limit === null ? null : numberValue(meterValue.limit, 0);
        const used = numberValue(meterValue.used, 0);
        return [{
          key,
          label: textValue(meterValue.label) || METER_LABELS[key] || key,
          used,
          limit,
          remaining: meterValue.remaining === null ? null : numberValue(meterValue.remaining, limit === null ? 0 : Math.max(limit - used, 0)),
          unit: textValue(meterValue.unit) || undefined,
        }];
      })
    : Object.entries(metricsSource).flatMap(([key, metricValue]) => {
        if (!isRecord(metricValue)) return [];
        const used = numberValue(metricValue.used, 0);
        const limit = metricValue.limit === null ? null : numberValue(metricValue.limit, 0);
        return [{
          key,
          label: METER_LABELS[key] || key,
          used,
          limit,
          remaining: metricValue.remaining === null ? null : numberValue(metricValue.remaining, limit === null ? 0 : Math.max(limit - used, 0)),
        }];
      });

  const limits = Object.fromEntries(
    Object.entries(limitsSource)
      .map(([key, value]) => [key, numberValue(value, -1)] as const)
      .filter(([, value]) => value >= 0),
  );
  const periodSource = isRecord(source.period) ? source.period : {};
  const aiSource = isRecord(source.ai) ? source.ai : null;
  const settingsSource = aiSource && isRecord(aiSource.settings) ? aiSource.settings : {};
  return {
    planKey: planKeyValue(source.planKey ?? source.plan_key),
    subscriptionStatus: textValue(source.subscriptionStatus, source.subscription_status) || 'active',
    period: Object.keys(periodSource).length > 0 ? {
      startsAt: textValue(periodSource.startsAt, periodSource.starts_at) || undefined,
      endsAt: textValue(periodSource.endsAt, periodSource.ends_at) || undefined,
    } : undefined,
    meters,
    limits,
    ai: aiSource ? {
      used: numberValue(aiSource.used), baseLimit: numberValue(aiSource.baseLimit), bonusCredits: numberValue(aiSource.bonusCredits),
      effectiveLimit: numberValue(aiSource.effectiveLimit), remaining: numberValue(aiSource.remaining),
      userUsed: numberValue(aiSource.userUsed), userLimit: aiSource.userLimit == null ? null : numberValue(aiSource.userLimit),
      userRemaining: aiSource.userRemaining == null ? null : numberValue(aiSource.userRemaining), creditBalance: numberValue(aiSource.creditBalance),
      settings: {
        perUserMonthlyLimit: settingsSource.perUserMonthlyLimit == null ? null : numberValue(settingsSource.perUserMonthlyLimit),
        autoUsePrepaidCredits: settingsSource.autoUsePrepaidCredits === true,
        autoCreditBundle: numberValue(settingsSource.autoCreditBundle) === 5000 ? 5000 : 1000,
      },
    } : undefined,
  };
};

const scopedUrl = (path: string, organizationId: string): string => {
  if (!organizationId) return path;
  const separator = path.includes('?') ? '&' : '?';
  return `${path}${separator}organizationId=${encodeURIComponent(organizationId)}`;
};

const apiRequest = async <T,>(path: string, init: RequestInit = {}): Promise<T> => {
  const response = await fetch(getApiUrl(path), {
    ...init,
    headers: {
      ...(init.body ? jsonHeaders() : {}),
      ...authHeaders(),
      ...(init.headers || {}),
    },
  });
  const payload = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) {
    const message = isRecord(payload) && isRecord(payload.error)
      ? textValue(payload.error.message)
      : '';
    throw new Error(message || 'İşlem tamamlanamadı. Lütfen tekrar deneyin.');
  }
  return payload as T;
};

const formatDate = (value?: string): string => {
  if (!value) return 'Belirtilmedi';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Belirtilmedi' : date.toLocaleDateString('tr-TR');
};

const formatLimit = (value: number, key: string): string => {
  if (key.toLowerCase().includes('chars')) {
    return `${new Intl.NumberFormat('tr-TR', { notation: 'compact', maximumFractionDigits: 1 }).format(value)} karakter`;
  }
  return value.toLocaleString('tr-TR');
};

export default function SaaSManagement({
  section,
  user,
  activeOrganization,
  memberships,
  onOrganizationSwitch,
  onContextRefresh,
}: SaaSManagementProps) {
  const [activeTab, setActiveTab] = useState<WorkspaceTab>(() => section === 'billing' ? 'billing' : 'members');
  const [organizations, setOrganizations] = useState<SaaSOrganization[]>(() => uniqueOrganizations([
    activeOrganization,
    ...memberships.map(organizationFromMembership),
  ]));
  const [members, setMembers] = useState<OrganizationMember[]>([]);
  const [invitations, setInvitations] = useState<PendingInvitation[]>([]);
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [plans, setPlans] = useState<PlanDefinition[]>(FALLBACK_PLANS);
  const [creditPackages, setCreditPackages] = useState<AiCreditPackage[]>([]);
  const [perUserAiLimit, setPerUserAiLimit] = useState('');
  const [autoUseCredits, setAutoUseCredits] = useState(false);
  const [autoCreditBundle, setAutoCreditBundle] = useState<1000 | 5000>(1000);
  const [isContextLoading, setIsContextLoading] = useState(true);
  const [isWorkspaceLoading, setIsWorkspaceLoading] = useState(false);
  const [busyAction, setBusyAction] = useState('');
  const [notice, setNotice] = useState<Notice | null>(null);

  const [organizationName, setOrganizationName] = useState('');
  const [activeOrganizationName, setActiveOrganizationName] = useState(activeOrganization?.name || '');
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<SaaSRole>('analyst');
  const [generatedInviteUrl, setGeneratedInviteUrl] = useState('');
  const [selectedPlan, setSelectedPlan] = useState<SaaSPlanKey>('professional');
  const [cancelConfirmation, setCancelConfirmation] = useState(false);
  const [customer, setCustomer] = useState<CheckoutCustomer>(() => {
    const parts = user.name.trim().split(/\s+/);
    return {
      name: parts.shift() || '',
      surname: parts.join(' '),
      email: user.email,
      gsmNumber: '',
      identityNumber: '',
      address: '',
      city: '',
      country: 'Türkiye',
      zipCode: '',
    };
  });

  const activeOrganizationId = organizationKey(activeOrganization);
  const currentMembership = useMemo(() => memberships.find((membership) => (
    membershipOrganizationKey(membership) === activeOrganizationId
  )), [activeOrganizationId, memberships]);
  const currentRole = roleValue(currentMembership?.role ?? activeOrganization?.role ?? user.role);
  const isAdmin = currentRole === 'admin';
  const canCreateOrganization = memberships.length === 0 || isAdmin;
  const hasActiveOrganization = Boolean(activeOrganization && activeOrganizationId);
  const activePlanKey = usage?.planKey ?? activeOrganization?.planKey ?? activeOrganization?.plan_key ?? 'starter';
  const activePlan = plans.find((plan) => plan.key === activePlanKey) ?? FALLBACK_PLANS[0];

  useEffect(() => {
    setActiveTab(section === 'billing' ? 'billing' : 'members');
    setNotice(null);
  }, [section]);

  useEffect(() => {
    setOrganizations((current) => uniqueOrganizations([
      ...current,
      activeOrganization,
      ...memberships.map(organizationFromMembership),
    ]));
    setActiveOrganizationName(activeOrganization?.name || '');
    setNotice(null);
  }, [activeOrganization, memberships]);

  const loadContext = useCallback(async (signal?: AbortSignal) => {
    setIsContextLoading(true);
    try {
      const [contextPayload, organizationsPayload] = await Promise.all([
        apiRequest<unknown>('/api/saas/context', { signal }),
        apiRequest<unknown>('/api/saas/organizations', { signal }),
      ]);
      const contextOrganizations = listPayload(contextPayload, ['organizations', 'items'])
        .map(normalizeOrganization)
        .filter((organization): organization is SaaSOrganization => Boolean(organization));
      const listedOrganizations = listPayload(organizationsPayload, ['organizations', 'items'])
        .map(normalizeOrganization)
        .filter((organization): organization is SaaSOrganization => Boolean(organization));
      setOrganizations((current) => uniqueOrganizations([
        ...current,
        ...contextOrganizations,
        ...listedOrganizations,
        activeOrganization,
        ...memberships.map(organizationFromMembership),
      ]));
      const contextRecord = isRecord(contextPayload) ? contextPayload : {};
      const normalizedPlans = listPayload(contextRecord.plans, ['plans', 'items'])
        .map(normalizePlan)
        .filter((plan): plan is PlanDefinition => Boolean(plan));
      if (normalizedPlans.length > 0) setPlans(normalizedPlans);
      const billingRecord = isRecord(contextRecord.billing) ? contextRecord.billing : {};
      setCreditPackages(listPayload(billingRecord.aiCreditPackages, ['items']).flatMap((value) => {
        if (!isRecord(value)) return [];
        const quantity = numberValue(value.quantity);
        if (quantity !== 1000 && quantity !== 5000) return [];
        return [{ quantity, priceLabel: textValue(value.priceLabel) || 'Fiyat tanımlanmadı', amountMinor: value.amountMinor == null ? null : numberValue(value.amountMinor), checkoutAvailable: value.checkoutAvailable === true } as AiCreditPackage];
      }));
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        setNotice({ type: 'error', text: error instanceof Error ? error.message : 'Çalışma alanı bilgileri yüklenemedi.' });
      }
    } finally {
      setIsContextLoading(false);
    }
  }, [activeOrganization, memberships]);

  useEffect(() => {
    const controller = new AbortController();
    void loadContext(controller.signal);
    return () => controller.abort();
  }, [loadContext]);

  const loadWorkspace = useCallback(async (signal?: AbortSignal) => {
    if (!activeOrganizationId) {
      setMembers([]);
      setInvitations([]);
      setUsage(null);
      return;
    }
    setIsWorkspaceLoading(true);
    try {
      const [membersPayload, invitationsPayload, usagePayload] = await Promise.all([
        apiRequest<unknown>(scopedUrl('/api/saas/members', activeOrganizationId), { signal }),
        apiRequest<unknown>(scopedUrl('/api/saas/invitations', activeOrganizationId), { signal }),
        apiRequest<unknown>(scopedUrl('/api/saas/usage', activeOrganizationId), { signal }),
      ]);
      setMembers(listPayload(membersPayload, ['members', 'items'])
        .map(normalizeMember)
        .filter((member): member is OrganizationMember => Boolean(member)));
      setInvitations(listPayload(invitationsPayload, ['invitations', 'items'])
        .map(normalizeInvitation)
        .filter((invitation): invitation is PendingInvitation => Boolean(invitation)));
      const nextUsage = normalizeUsage(usagePayload);
      setUsage(nextUsage);
      setPerUserAiLimit(nextUsage.ai?.settings.perUserMonthlyLimit == null ? '' : String(nextUsage.ai.settings.perUserMonthlyLimit));
      setAutoUseCredits(nextUsage.ai?.settings.autoUsePrepaidCredits === true);
      setAutoCreditBundle(nextUsage.ai?.settings.autoCreditBundle || 1000);
      setSelectedPlan((current) => current === nextUsage.planKey
        ? (nextUsage.planKey === 'professional' ? 'enterprise' : 'professional')
        : current);
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        setNotice({ type: 'error', text: error instanceof Error ? error.message : 'Çalışma alanı bilgileri yüklenemedi.' });
      }
    } finally {
      setIsWorkspaceLoading(false);
    }
  }, [activeOrganizationId]);

  useEffect(() => {
    const controller = new AbortController();
    void loadWorkspace(controller.signal);
    return () => controller.abort();
  }, [loadWorkspace]);

  const refreshContext = async () => {
    await Promise.all([loadContext(), onContextRefresh()]);
    await loadWorkspace();
  };

  const runAction = async (key: string, action: () => Promise<void>) => {
    setBusyAction(key);
    setNotice(null);
    try {
      await action();
    } catch (error) {
      setNotice({ type: 'error', text: error instanceof Error ? error.message : 'İşlem tamamlanamadı.' });
    } finally {
      setBusyAction('');
    }
  };

  const handleCreateOrganization = (event: React.FormEvent) => {
    event.preventDefault();
    const name = organizationName.trim();
    if (!name || !canCreateOrganization) return;
    void runAction('create-organization', async () => {
      const payload = await apiRequest<unknown>('/api/saas/organizations', {
        method: 'POST',
        body: JSON.stringify({ name }),
      });
      const source = isRecord(payload) && isRecord(payload.organization) ? payload.organization : payload;
      const organization = normalizeOrganization(source);
      setOrganizationName('');
      setNotice({ type: 'success', text: 'Çalışma alanı oluşturuldu.' });
      await refreshContext();
      if (organization) await onOrganizationSwitch(organization);
    });
  };

  const handleRenameOrganization = (event: React.FormEvent) => {
    event.preventDefault();
    const name = activeOrganizationName.trim();
    if (!isAdmin || !activeOrganizationId || !name || name === activeOrganization?.name) return;
    void runAction('rename-organization', async () => {
      await apiRequest('/api/saas/organizations', {
        method: 'PUT',
        body: JSON.stringify({ organizationId: activeOrganizationId, name }),
      });
      setOrganizations((current) => current.map((organization) => (
        organizationKey(organization) === activeOrganizationId ? { ...organization, name } : organization
      )));
      setNotice({ type: 'success', text: 'Çalışma alanı adı güncellendi.' });
      await refreshContext();
    });
  };

  const handleSwitchOrganization = (organization: SaaSOrganization) => {
    if (organizationKey(organization) === activeOrganizationId || busyAction) return;
    void runAction(`switch-${organizationKey(organization)}`, async () => {
      await onOrganizationSwitch(organization);
      setActiveTab('organization');
      setNotice({ type: 'success', text: `“${organization.name}” çalışma alanına geçildi.` });
    });
  };

  const handleInvite = (event: React.FormEvent) => {
    event.preventDefault();
    const email = inviteEmail.trim().toLowerCase();
    if (!isAdmin || !activeOrganizationId || !email) return;
    void runAction('invite-member', async () => {
      const response = await apiRequest<unknown>('/api/saas/invitations', {
        method: 'POST',
        body: JSON.stringify({ organizationId: activeOrganizationId, email, role: inviteRole }),
      });
      const responseRecord = isRecord(response) ? response : {};
      const inviteUrl = textValue(responseRecord.inviteUrl);
      setInviteEmail('');
      setInviteRole('analyst');
      setGeneratedInviteUrl(inviteUrl);
      setNotice({ type: 'success', text: inviteUrl ? 'Davet bağlantısı hazır. Aşağıdaki bağlantıyı kişiyle paylaşın.' : `${email} adresine davet gönderildi.` });
      await refreshContext();
    });
  };

  const handleCopyInvite = () => {
    if (!generatedInviteUrl) return;
    void navigator.clipboard.writeText(generatedInviteUrl).then(
      () => setNotice({ type: 'success', text: 'Davet bağlantısı kopyalandı.' }),
      () => setNotice({ type: 'error', text: 'Bağlantı kopyalanamadı. Metni seçip kopyalayabilirsiniz.' }),
    );
  };

  const handleRevokeInvitation = (invitation: PendingInvitation) => {
    if (!isAdmin) return;
    void runAction(`revoke-${invitation.id}`, async () => {
      await apiRequest(`/api/saas/invitations/${encodeURIComponent(String(invitation.id))}`, { method: 'DELETE' });
      setInvitations((current) => current.filter((item) => item.id !== invitation.id));
      setGeneratedInviteUrl('');
      setNotice({ type: 'success', text: `${invitation.email} için davet iptal edildi.` });
    });
  };

  const handleRoleChange = (member: OrganizationMember, role: SaaSRole) => {
    if (!isAdmin || member.email.toLowerCase() === user.email.toLowerCase() || member.role === role) return;
    void runAction(`role-${member.id}`, async () => {
      await apiRequest('/api/saas/members', {
        method: 'PUT',
        body: JSON.stringify({
          organizationId: activeOrganizationId,
          membershipId: member.id,
          email: member.email,
          role,
        }),
      });
      setMembers((current) => current.map((item) => item.id === member.id ? { ...item, role } : item));
      setNotice({ type: 'success', text: `${member.name} için rol güncellendi.` });
      await onContextRefresh();
    });
  };

  const handleRemoveMember = (member: OrganizationMember) => {
    if (!isAdmin || member.email.toLowerCase() === user.email.toLowerCase()) return;
    void runAction(`remove-${member.id}`, async () => {
      await apiRequest('/api/saas/members', {
        method: 'DELETE',
        body: JSON.stringify({
          organizationId: activeOrganizationId,
          membershipId: member.id,
          email: member.email,
        }),
      });
      setMembers((current) => current.filter((item) => item.id !== member.id));
      setNotice({ type: 'success', text: `${member.name} çalışma alanından çıkarıldı.` });
      await refreshContext();
    });
  };

  const handleCheckout = (event: React.FormEvent) => {
    event.preventDefault();
    if (!isAdmin || !activeOrganizationId || selectedPlan === 'starter') return;
    void runAction('checkout', async () => {
      const response = await apiRequest<unknown>('/api/saas/billing/checkout', {
        method: 'POST',
        body: JSON.stringify({
          organizationId: activeOrganizationId,
          planKey: selectedPlan,
          customer: {
            name: customer.name.trim(),
            surname: customer.surname.trim(),
            email: customer.email.trim().toLowerCase(),
            gsmNumber: customer.gsmNumber.trim(),
            identityNumber: customer.identityNumber.trim(),
            billingAddress: {
              address: customer.address.trim(),
              zipCode: customer.zipCode.trim() || undefined,
              contactName: `${customer.name} ${customer.surname}`.trim(),
              city: customer.city.trim(),
              country: customer.country.trim(),
            },
          },
        }),
      });
      const record = isRecord(response) ? response : {};
      const hostedUrl = textValue(record.hostedUrl, record.checkoutUrl, record.paymentPageUrl);
      if (!hostedUrl) {
        throw new Error('Güvenli ödeme sayfası hazırlanamadı. Lütfen daha sonra tekrar deneyin.');
      }
      const parsedUrl = new URL(hostedUrl, window.location.origin);
      if (parsedUrl.protocol !== 'https:' && parsedUrl.origin !== window.location.origin) {
        throw new Error('Ödeme sağlayıcısı geçersiz bir yönlendirme adresi döndürdü.');
      }
      window.location.assign(parsedUrl.toString());
    });
  };

  const handleCancelSubscription = () => {
    if (!isAdmin || !activeOrganizationId || !cancelConfirmation) {
      setCancelConfirmation(true);
      return;
    }
    void runAction('cancel-subscription', async () => {
      await apiRequest('/api/saas/billing/cancel', {
        method: 'POST',
        body: JSON.stringify({ organizationId: activeOrganizationId }),
      });
      setCancelConfirmation(false);
      setNotice({ type: 'success', text: 'Abonelik iptal talebi alındı.' });
      await refreshContext();
    });
  };

  const customerPayload = () => ({
    name: customer.name.trim(), surname: customer.surname.trim(), email: customer.email.trim().toLowerCase(),
    gsmNumber: customer.gsmNumber.trim(), identityNumber: customer.identityNumber.trim(),
    billingAddress: { address: customer.address.trim(), zipCode: customer.zipCode.trim() || undefined,
      contactName: `${customer.name} ${customer.surname}`.trim(), city: customer.city.trim(), country: customer.country.trim() }
  });

  const handleSaveAiSettings = () => {
    if (!isAdmin) return;
    void runAction('ai-settings', async () => {
      await apiRequest('/api/saas/ai-settings', { method: 'PUT', body: JSON.stringify({
        perUserMonthlyLimit: perUserAiLimit.trim() ? Number(perUserAiLimit) : null,
        autoUsePrepaidCredits: autoUseCredits, autoCreditBundle
      }) });
      setNotice({ type: 'success', text: 'Yapay zekâ kullanım ayarları kaydedildi.' });
      await loadWorkspace();
    });
  };

  const handleAllocateCredits = (quantity: 1000 | 5000) => {
    void runAction(`allocate-${quantity}`, async () => {
      await apiRequest('/api/saas/ai-credits/allocate', { method: 'POST', body: JSON.stringify({ quantity }) });
      setNotice({ type: 'success', text: `${quantity.toLocaleString('tr-TR')} hak bu aya aktarıldı.` });
      await loadWorkspace();
    });
  };

  const handleCreditCheckout = (quantity: 1000 | 5000) => {
    void runAction(`credit-${quantity}`, async () => {
      const response = await apiRequest<unknown>('/api/saas/ai-credits/checkout', { method: 'POST', body: JSON.stringify({ quantity, customer: customerPayload() }) });
      const record = isRecord(response) ? response : {};
      const checkoutUrl = textValue(record.checkoutUrl);
      if (!checkoutUrl) throw new Error('Güvenli ödeme sayfası hazırlanamadı.');
      window.location.assign(new URL(checkoutUrl, window.location.origin).toString());
    });
  };

  const tabs = section === 'billing'
    ? [
        { id: 'billing' as const, label: 'Paket ve Ödeme', icon: CreditCard },
        { id: 'usage' as const, label: 'Kullanım Durumu', icon: Gauge },
      ]
    : [
        { id: 'members' as const, label: 'Ekip Üyeleri', icon: Users },
        { id: 'organization' as const, label: 'Çalışma Alanları', icon: Building2 },
      ];

  const pageCopy = section === 'billing'
    ? {
        eyebrow: 'Paket ve ödeme',
        title: 'Paketim',
        description: 'Ekibinizin paketini, ortak kullanım haklarını ve ödemeyi yönetin.',
      }
    : {
        eyebrow: 'Ekip ve yetkiler',
        title: 'Ekibim',
        description: 'Ekibinize kişileri ekleyin ve kimlerin neleri yapabileceğini belirleyin.',
      };

  return (
    <div className="mx-auto flex w-full max-w-[1440px] flex-col gap-6 p-4 pb-6 md:p-8 lg:p-10">
      <header className="flex flex-col gap-4 border-b border-slate-200 pb-6 dark:border-white/10 lg:flex-row lg:items-end lg:justify-between">
        <div className="min-w-0">
          <div className="mb-2 flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-indigo-600 dark:text-[#FFD700]">
            <span className="h-2 w-2 rounded-full bg-emerald-500" />
            {pageCopy.eyebrow}
          </div>
          <h1 className="text-3xl font-bold text-slate-950 dark:text-white md:text-4xl">{pageCopy.title}</h1>
          <p className="mt-2 max-w-2xl text-sm text-slate-500 dark:text-white/55">{pageCopy.description}</p>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-slate-500 dark:text-white/55">
            <span className="max-w-full truncate">{activeOrganization?.name || 'Çalışma alanı seçilmedi'}</span>
            {hasActiveOrganization && (
              <span className={cn('rounded border px-2 py-1 text-[10px] font-bold uppercase tracking-wider', ROLE_STYLES[currentRole])}>
                {ROLE_LABELS[currentRole]}
              </span>
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={() => void refreshContext()}
          disabled={isContextLoading || Boolean(busyAction)}
          title="Yenile"
          aria-label="Çalışma alanı bilgilerini yenile"
          className="inline-flex h-11 w-11 shrink-0 items-center justify-center self-start rounded-lg border border-slate-300 bg-white text-slate-600 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-white/15 dark:bg-white/5 dark:text-white/70 dark:hover:bg-white/10 lg:self-auto"
        >
          <RefreshCw className={cn('h-4 w-4', (isContextLoading || isWorkspaceLoading) && 'animate-spin')} />
        </button>
      </header>

      <nav className="flex max-w-full gap-1 overflow-x-auto border-b border-slate-200 dark:border-white/10" role="tablist" aria-label={section === 'billing' ? 'Paket bölümleri' : 'Ekip bölümleri'}>
        {tabs.map((tab) => {
          const disabled = tab.id !== 'organization' && !hasActiveOrganization;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={activeTab === tab.id}
              disabled={disabled}
              onClick={() => setActiveTab(tab.id)}
              className={cn(
                'flex min-h-11 shrink-0 items-center gap-2 border-b-2 px-4 py-3 text-xs font-bold transition-colors disabled:cursor-not-allowed disabled:opacity-35',
                activeTab === tab.id
                  ? 'border-indigo-600 text-indigo-600 dark:border-[#FFD700] dark:text-[#FFD700]'
                  : 'border-transparent text-slate-400 hover:text-slate-700 dark:hover:text-white',
              )}
            >
              <tab.icon className="h-4 w-4" />
              {tab.label}
            </button>
          );
        })}
      </nav>

      {notice && (
        <div
          role={notice.type === 'error' ? 'alert' : 'status'}
          className={cn(
            'flex items-start justify-between gap-3 rounded-lg border px-4 py-3 text-sm font-medium',
            notice.type === 'success'
              ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/20 dark:bg-emerald-500/10 dark:text-emerald-300'
              : 'border-red-200 bg-red-50 text-red-700 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-300',
          )}
        >
          <span className="flex min-w-0 items-start gap-3">
            {notice.type === 'success'
              ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
              : <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />}
            <span>{notice.text}</span>
          </span>
          <button type="button" onClick={() => setNotice(null)} aria-label="Bildirimi kapat" className="rounded p-1 hover:bg-black/5 dark:hover:bg-white/10">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {activeTab === 'organization' && (
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
          <section className="overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-white/10 dark:bg-white/[0.035]">
            <div className="border-b border-slate-200 px-5 py-4 dark:border-white/10">
              <h2 className="flex items-center gap-2 text-base font-bold text-slate-900 dark:text-white">
                <Building2 className="h-5 w-5 text-indigo-500 dark:text-[#FFD700]" />
                Çalışma Alanları
              </h2>
              <p className="mt-1 text-xs text-slate-500 dark:text-white/45">{organizations.length} çalışma alanı</p>
            </div>
            <div className="divide-y divide-slate-200 dark:divide-white/10">
              {organizations.map((organization) => {
                const key = organizationKey(organization);
                const membership = memberships.find((item) => membershipOrganizationKey(item) === key);
                const role = roleValue(membership?.role ?? organization.role);
                const active = key === activeOrganizationId;
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => handleSwitchOrganization(organization)}
                    disabled={active || Boolean(busyAction)}
                    className={cn(
                      'flex min-h-16 w-full items-center gap-3 px-5 py-4 text-left transition-colors disabled:cursor-default',
                      active ? 'bg-indigo-50/70 dark:bg-[#FFD700]/5' : 'hover:bg-slate-50 dark:hover:bg-white/5',
                    )}
                  >
                    <span className={cn(
                      'flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border',
                      active
                        ? 'border-indigo-200 bg-indigo-100 text-indigo-700 dark:border-[#FFD700]/25 dark:bg-[#FFD700]/10 dark:text-[#FFD700]'
                        : 'border-slate-200 bg-slate-50 text-slate-500 dark:border-white/10 dark:bg-white/5 dark:text-white/50',
                    )}>
                      {busyAction === `switch-${key}` ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Building2 className="h-4 w-4" />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-bold text-slate-900 dark:text-white">{organization.name}</span>
                      <span className="mt-1 block truncate text-[11px] text-slate-400 dark:text-white/35">{organization.slug || organization.tenantId || organization.tenant_id || key}</span>
                    </span>
                    <span className={cn('rounded border px-2 py-1 text-[9px] font-bold uppercase tracking-wider', ROLE_STYLES[role])}>{ROLE_LABELS[role]}</span>
                    {active ? <Check className="h-4 w-4 shrink-0 text-emerald-500" /> : <ArrowRight className="h-4 w-4 shrink-0 text-slate-300 dark:text-white/20" />}
                  </button>
                );
              })}
              {!isContextLoading && organizations.length === 0 && (
                <div className="px-5 py-10 text-center text-sm text-slate-400 dark:text-white/35">Henüz çalışma alanı bulunmuyor.</div>
              )}
              {isContextLoading && organizations.length === 0 && (
                <div className="flex items-center justify-center gap-2 px-5 py-10 text-xs text-slate-400 dark:text-white/35">
                  <LoaderCircle className="h-4 w-4 animate-spin" /> Yükleniyor...
                </div>
              )}
            </div>
          </section>

          <div className="flex flex-col gap-6">
            <section className="rounded-lg border border-slate-200 bg-white p-5 dark:border-white/10 dark:bg-white/[0.035]">
              <h2 className="flex items-center gap-2 text-base font-bold text-slate-900 dark:text-white">
                <Pencil className="h-5 w-5 text-indigo-500 dark:text-[#FFD700]" />
                Çalışma Alanı Adı
              </h2>
              <form onSubmit={handleRenameOrganization} className="mt-5 flex flex-col gap-3 sm:flex-row">
                <input
                  type="text"
                  value={activeOrganizationName}
                  onChange={(event) => setActiveOrganizationName(event.target.value)}
                  disabled={!hasActiveOrganization || !isAdmin}
                  maxLength={100}
                  className="min-h-11 min-w-0 flex-1 rounded-lg border border-slate-300 bg-slate-50 px-4 text-base text-slate-900 outline-none transition-colors focus:border-indigo-500 disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/10 dark:bg-white/5 dark:text-white dark:focus:border-[#FFD700] md:text-sm"
                  placeholder="Çalışma alanı adı"
                  aria-label="Çalışma alanı adı"
                />
                <button
                  type="submit"
                  disabled={!isAdmin || !activeOrganizationName.trim() || activeOrganizationName.trim() === activeOrganization?.name || busyAction === 'rename-organization'}
                  className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-indigo-600 px-5 text-xs font-bold text-white transition-colors hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-[#FFD700] dark:text-black dark:hover:bg-[#ffe24d]"
                >
                  {busyAction === 'rename-organization' ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                  Kaydet
                </button>
              </form>
              {!isAdmin && hasActiveOrganization && <p className="mt-3 text-xs text-amber-600 dark:text-amber-300">Çalışma alanı adını yalnız yöneticiler değiştirebilir.</p>}
            </section>

            <section className="rounded-lg border border-slate-200 bg-white p-5 dark:border-white/10 dark:bg-white/[0.035]">
              <h2 className="flex items-center gap-2 text-base font-bold text-slate-900 dark:text-white">
                <Plus className="h-5 w-5 text-indigo-500 dark:text-[#FFD700]" />
                Yeni Çalışma Alanı
              </h2>
              <form onSubmit={handleCreateOrganization} className="mt-5 flex flex-col gap-3 sm:flex-row">
                <input
                  type="text"
                  value={organizationName}
                  onChange={(event) => setOrganizationName(event.target.value)}
                  disabled={!canCreateOrganization}
                  maxLength={100}
                  required
                  className="min-h-11 min-w-0 flex-1 rounded-lg border border-slate-300 bg-slate-50 px-4 text-base text-slate-900 outline-none transition-colors focus:border-indigo-500 disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/10 dark:bg-white/5 dark:text-white dark:focus:border-[#FFD700] md:text-sm"
                  placeholder="Çalışma alanı adı"
                  aria-label="Yeni çalışma alanı adı"
                />
                <button
                  type="submit"
                  disabled={!canCreateOrganization || !organizationName.trim() || busyAction === 'create-organization'}
                  className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-indigo-600 px-5 text-xs font-bold text-white transition-colors hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-[#FFD700] dark:text-black dark:hover:bg-[#ffe24d]"
                >
                  {busyAction === 'create-organization' ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                  Oluştur
                </button>
              </form>
              {!canCreateOrganization && <p className="mt-3 text-xs text-amber-600 dark:text-amber-300">Yeni çalışma alanı oluşturma yetkiniz bulunmuyor.</p>}
            </section>
          </div>
        </div>
      )}

      {activeTab === 'members' && hasActiveOrganization && (
        <div className="flex flex-col gap-6">
          <section className="overflow-hidden rounded-lg border border-indigo-200 bg-indigo-50/70 dark:border-[#FFD700]/20 dark:bg-[#FFD700]/5">
            <div className="flex items-start gap-3 border-b border-indigo-200 px-5 py-4 dark:border-[#FFD700]/15">
              <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-indigo-600 dark:text-[#FFD700]" />
              <div>
                <h2 className="text-base font-bold text-slate-900 dark:text-white">Her ekip üyesinin ayrı paket alması gerekmez</h2>
                <p className="mt-1 text-sm leading-6 text-slate-600 dark:text-white/55">
                  <strong>{activePlan.name}</strong> paketi <strong>{activeOrganization?.name}</strong> çalışma alanına aittir ve en fazla <strong>{numberValue(activePlan.limits.members).toLocaleString('tr-TR')} kişiyi</strong> kapsar. Yönetici bir kez satın alır; davet edilen kişiler ayrıca ödeme yapmaz.
                </p>
              </div>
            </div>
            <div className="grid grid-cols-1 divide-y divide-indigo-200 dark:divide-[#FFD700]/10 md:grid-cols-3 md:divide-x md:divide-y-0">
              <div className="p-4">
                <p className="text-sm font-bold text-slate-900 dark:text-white">Yönetici</p>
                <p className="mt-1 text-xs leading-5 text-slate-600 dark:text-white/50">Ekibi, yetkileri, çalışma alanını ve ödemeyi yönetir. Analiz özelliklerini de kullanabilir.</p>
              </div>
              <div className="p-4">
                <p className="text-sm font-bold text-slate-900 dark:text-white">Analist</p>
                <p className="mt-1 text-xs leading-5 text-slate-600 dark:text-white/50">Veri yükler, analiz yapar ve sonuç üretir; ekip veya ödeme ayarlarını değiştiremez.</p>
              </div>
              <div className="p-4">
                <p className="text-sm font-bold text-slate-900 dark:text-white">Görüntüleyici</p>
                <p className="mt-1 text-xs leading-5 text-slate-600 dark:text-white/50">Hazır sonuçları görür; verileri, ekibi ve paket ayarlarını değiştiremez.</p>
              </div>
            </div>
          </section>

          <section className="rounded-lg border border-slate-200 bg-white p-5 dark:border-white/10 dark:bg-white/[0.035]">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
              <div>
                <h2 className="flex items-center gap-2 text-base font-bold text-slate-900 dark:text-white">
                  <UserPlus className="h-5 w-5 text-indigo-500 dark:text-[#FFD700]" />
                  Üye Davet Et
                </h2>
                <p className="mt-1 text-xs text-slate-500 dark:text-white/45">{activeOrganization?.name}</p>
              </div>
              <form onSubmit={handleInvite} className="grid w-full grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_140px_auto] lg:max-w-3xl">
                <input
                  type="email"
                  inputMode="email"
                  autoCapitalize="none"
                  spellCheck={false}
                  value={inviteEmail}
                  onChange={(event) => setInviteEmail(event.target.value)}
                  disabled={!isAdmin}
                  required
                  className="min-h-11 min-w-0 rounded-lg border border-slate-300 bg-slate-50 px-4 text-base text-slate-900 outline-none transition-colors focus:border-indigo-500 disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/10 dark:bg-white/5 dark:text-white dark:focus:border-[#FFD700] md:text-sm"
                  placeholder="isim@sirket.com"
                  aria-label="Davet edilecek e-posta"
                />
                <select
                  value={inviteRole}
                  onChange={(event) => setInviteRole(roleValue(event.target.value))}
                  disabled={!isAdmin}
                  aria-label="Davet rolü"
                  className="min-h-11 rounded-lg border border-slate-300 bg-slate-50 px-3 text-base text-slate-900 outline-none focus:border-indigo-500 disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/10 dark:bg-[#191919] dark:text-white dark:focus:border-[#FFD700] md:text-sm"
                >
                  <option value="admin">Yönetici</option>
                  <option value="analyst">Analist</option>
                  <option value="viewer">Görüntüleyici</option>
                </select>
                <button
                  type="submit"
                  disabled={!isAdmin || !inviteEmail.trim() || busyAction === 'invite-member'}
                  className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-indigo-600 px-5 text-xs font-bold text-white transition-colors hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-[#FFD700] dark:text-black dark:hover:bg-[#ffe24d]"
                >
                  {busyAction === 'invite-member' ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Mail className="h-4 w-4" />}
                  Davet Et
                </button>
              </form>
            </div>
            {generatedInviteUrl && (
              <div className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 p-4 dark:border-emerald-500/25 dark:bg-emerald-500/10">
                <p className="text-sm font-bold text-emerald-800 dark:text-emerald-200">Davet bağlantısı hazır</p>
                <p className="mt-1 text-xs leading-5 text-emerald-700 dark:text-emerald-300/80">E-posta gönderimi bağlı olmadığı için bu tek kullanımlık bağlantıyı davet ettiğiniz kişiyle güvenli bir kanaldan paylaşın. Bağlantı 72 saat geçerlidir.</p>
                <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                  <input readOnly value={generatedInviteUrl} aria-label="Davet bağlantısı" className="min-h-11 min-w-0 flex-1 rounded-lg border border-emerald-200 bg-white px-3 text-sm text-slate-700 outline-none dark:border-emerald-500/25 dark:bg-black/20 dark:text-white" />
                  <button type="button" onClick={handleCopyInvite} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-emerald-600 px-4 text-xs font-bold text-white hover:bg-emerald-700"><Copy className="h-4 w-4" />Bağlantıyı Kopyala</button>
                </div>
              </div>
            )}
            {!isAdmin && <p className="mt-4 text-xs text-amber-600 dark:text-amber-300">Davet ve yetki işlemlerini yalnız yöneticiler yapabilir.</p>}
          </section>

          <section className="overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-white/10 dark:bg-white/[0.035]">
            <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-5 py-4 dark:border-white/10">
              <div>
                <h2 className="text-base font-bold text-slate-900 dark:text-white">Aktif Üyeler</h2>
                <p className="mt-1 text-xs text-slate-500 dark:text-white/45">{members.length} üye</p>
              </div>
              {isWorkspaceLoading && <LoaderCircle className="h-4 w-4 animate-spin text-slate-400" />}
            </div>
            <div className="divide-y divide-slate-200 dark:divide-white/10">
              {members.map((member) => {
                const isCurrentUser = member.email.toLowerCase() === user.email.toLowerCase();
                return (
                  <div key={String(member.id)} className="grid grid-cols-1 gap-3 px-5 py-4 sm:grid-cols-[minmax(0,1fr)_140px_44px] sm:items-center">
                    <div className="flex min-w-0 items-center gap-3">
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-indigo-100 text-sm font-bold text-indigo-700 dark:bg-white/10 dark:text-[#FFD700]">
                        {member.name.charAt(0).toUpperCase()}
                      </div>
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="truncate text-sm font-bold text-slate-900 dark:text-white">{member.name}</p>
                          {isCurrentUser && <span className="text-[9px] font-bold uppercase tracking-wider text-slate-400">Siz</span>}
                        </div>
                        <p className="truncate text-xs text-slate-500 dark:text-white/40">{member.email}</p>
                        {isAdmin && <p className="mt-1 text-[10px] text-slate-400 dark:text-white/30">Son başarılı giriş: {member.lastLoginAt ? new Date(member.lastLoginAt).toLocaleString('tr-TR') : 'Henüz giriş yapmadı'}</p>}
                      </div>
                    </div>
                    <select
                      value={member.role}
                      onChange={(event) => handleRoleChange(member, roleValue(event.target.value))}
                      disabled={!isAdmin || isCurrentUser || busyAction === `role-${member.id}`}
                      aria-label={`${member.name} rolü`}
                      className={cn(
                        'min-h-11 rounded-lg border px-3 text-sm font-bold outline-none disabled:cursor-not-allowed disabled:opacity-60',
                        ROLE_STYLES[member.role],
                      )}
                    >
                      <option value="admin">Yönetici</option>
                      <option value="analyst">Analist</option>
                      <option value="viewer">Görüntüleyici</option>
                    </select>
                    <button
                      type="button"
                      onClick={() => handleRemoveMember(member)}
                      disabled={!isAdmin || isCurrentUser || busyAction === `remove-${member.id}`}
                      title="Üyeyi çıkar"
                      aria-label={`${member.name} üyesini çıkar`}
                      className="inline-flex h-11 w-11 items-center justify-center justify-self-end rounded-lg text-red-500 transition-colors hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-30 dark:hover:bg-red-500/10 sm:justify-self-auto"
                    >
                      {busyAction === `remove-${member.id}` ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                    </button>
                  </div>
                );
              })}
              {!isWorkspaceLoading && members.length === 0 && <div className="px-5 py-10 text-center text-sm text-slate-400 dark:text-white/35">Üye bulunamadı.</div>}
            </div>
          </section>

          {invitations.length > 0 && (
            <section className="overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-white/10 dark:bg-white/[0.035]">
              <div className="border-b border-slate-200 px-5 py-4 dark:border-white/10">
                <h2 className="text-base font-bold text-slate-900 dark:text-white">Bekleyen Davetler</h2>
              </div>
              <div className="divide-y divide-slate-200 dark:divide-white/10">
                {invitations.map((invitation) => (
                  <div key={String(invitation.id)} className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center">
                    <Mail className="h-4 w-4 shrink-0 text-slate-400" />
                    <p className="min-w-0 flex-1 truncate text-sm font-medium text-slate-800 dark:text-white/80">{invitation.email}</p>
                    <span className={cn('self-start rounded border px-2 py-1 text-[9px] font-bold uppercase tracking-wider sm:self-auto', ROLE_STYLES[invitation.role])}>{ROLE_LABELS[invitation.role]}</span>
                    <span className="text-xs text-slate-400">{invitation.expiresAt ? `${formatDate(invitation.expiresAt)} tarihine kadar` : 'Bekliyor'}</span>
                    <button type="button" onClick={() => handleRevokeInvitation(invitation)} disabled={!isAdmin || busyAction === `revoke-${invitation.id}`} className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg px-3 text-xs font-bold text-red-600 hover:bg-red-50 disabled:opacity-40 dark:text-red-300 dark:hover:bg-red-500/10">
                      {busyAction === `revoke-${invitation.id}` ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />} İptal Et
                    </button>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      )}

      {activeTab === 'usage' && hasActiveOrganization && (
        <div className="flex flex-col gap-6">
          <section className="grid grid-cols-1 overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-white/10 dark:bg-white/[0.035] md:grid-cols-3">
            <div className="p-5 md:border-r md:border-slate-200 md:dark:border-white/10">
              <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-white/35">Aktif paket</p>
              <p className="mt-2 text-xl font-bold text-slate-900 dark:text-white">{activePlan.name}</p>
              <p className="mt-1 text-xs text-slate-500 dark:text-white/45">Bu çalışma alanının paketi · {activePlan.monthlyPriceLabel}</p>
            </div>
            <div className="border-t border-slate-200 p-5 dark:border-white/10 md:border-r md:border-t-0 md:dark:border-white/10">
              <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-white/35">Paketin durumu</p>
              <p className="mt-2 text-xl font-bold text-slate-900 dark:text-white">{subscriptionStatusLabel(usage?.subscriptionStatus)}</p>
              <p className="mt-1 text-xs text-slate-500 dark:text-white/45">{activePlanKey === 'starter' ? 'Bu paket için ödeme gerekmez.' : activeOrganization?.name}</p>
            </div>
            <div className="border-t border-slate-200 p-5 dark:border-white/10 md:border-t-0">
              <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-white/35">Kullanım dönemi</p>
              <p className="mt-2 text-sm font-bold text-slate-900 dark:text-white">{formatDate(usage?.period?.startsAt)} - {formatDate(usage?.period?.endsAt)}</p>
              <p className="mt-1 text-xs text-slate-500 dark:text-white/45">Aylık sayaçlar</p>
            </div>
          </section>

          {activePlanKey === 'starter' && (
            <div className="flex items-start gap-3 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-900 dark:border-blue-500/20 dark:bg-blue-500/10 dark:text-blue-200">
              <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
              <p>Bu çalışma alanı şu anda Başlangıç paketinde. Yönetici olmak ücretli paketi otomatik açmaz; yönetici ödemeyi tamamladığında Profesyonel veya Kurumsal paket bütün ekip için etkinleşir.</p>
            </div>
          )}

          <section className="overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-white/10 dark:bg-white/[0.035]">
            <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-5 py-4 dark:border-white/10">
              <h2 className="flex items-center gap-2 text-base font-bold text-slate-900 dark:text-white"><BarChart3 className="h-5 w-5 text-indigo-500 dark:text-[#FFD700]" /> Bu Ayki Kullanım</h2>
              {isWorkspaceLoading && <LoaderCircle className="h-4 w-4 animate-spin text-slate-400" />}
            </div>
            <div className="grid grid-cols-1 divide-y divide-slate-200 dark:divide-white/10 md:grid-cols-2 md:divide-y-0">
              {(usage?.meters || []).map((meter, index) => {
                const percentage = meter.limit && meter.limit > 0 ? Math.min((meter.used / meter.limit) * 100, 100) : 0;
                const critical = percentage >= 90;
                return (
                  <div key={meter.key} className={cn(
                    'p-5',
                    index % 2 === 1 && 'md:border-l md:border-slate-200 md:dark:border-white/10',
                    index >= 2 && 'md:border-t md:border-slate-200 md:dark:border-white/10',
                  )}>
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-sm font-bold text-slate-900 dark:text-white">{meter.label}</p>
                        <p className="mt-1 text-xs text-slate-500 dark:text-white/40">{meter.used.toLocaleString('tr-TR')} / {meter.limit === null ? 'Sınırsız' : meter.limit.toLocaleString('tr-TR')}</p>
                      </div>
                      <span className={cn('text-sm font-bold', critical ? 'text-red-500' : 'text-indigo-600 dark:text-[#FFD700]')}>{Math.round(percentage)}%</span>
                    </div>
                    <div
                      className="mt-4 h-2 overflow-hidden rounded-full bg-slate-100 dark:bg-white/10"
                      role="progressbar"
                      aria-label={meter.label}
                      aria-valuemin={0}
                      aria-valuemax={meter.limit ?? undefined}
                      aria-valuenow={meter.used}
                    >
                      <div className={cn('h-full rounded-full', critical ? 'bg-red-500' : 'bg-indigo-600 dark:bg-[#FFD700]')} style={{ width: `${percentage}%` }} />
                    </div>
                  </div>
                );
              })}
              {!isWorkspaceLoading && (usage?.meters.length || 0) === 0 && <div className="px-5 py-10 text-center text-sm text-slate-400 dark:text-white/35 md:col-span-2">Kullanım sayacı bulunamadı.</div>}
            </div>
          </section>

          {usage && Object.keys(usage.limits).length > 0 && (
            <section className="overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-white/10 dark:bg-white/[0.035]">
              <div className="border-b border-slate-200 px-5 py-4 dark:border-white/10"><h2 className="text-base font-bold text-slate-900 dark:text-white">Paketin Sağladığı Haklar</h2></div>
              <div className="grid grid-cols-2 divide-x divide-y divide-slate-200 dark:divide-white/10 md:grid-cols-4">
                {Object.entries(usage.limits).map(([key, limit]) => (
                  <div key={key} className="min-w-0 p-4">
                    <p className="truncate text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-white/35">{METER_LABELS[key] || key}</p>
                    <p className="mt-2 truncate text-lg font-bold text-slate-900 dark:text-white">{formatLimit(numberValue(limit), key)}</p>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      )}

      {activeTab === 'billing' && hasActiveOrganization && (
        <div className="flex flex-col gap-6">
          <section className="rounded-lg border border-indigo-200 bg-indigo-50/70 p-5 dark:border-[#FFD700]/20 dark:bg-[#FFD700]/5">
            <div className="flex items-start gap-3">
              <Users className="mt-0.5 h-5 w-5 shrink-0 text-indigo-600 dark:text-[#FFD700]" />
              <div>
                <h2 className="text-base font-bold text-slate-900 dark:text-white">Bir paket, seçili çalışma alanındaki bütün ekibi kapsar</h2>
                <p className="mt-1 text-sm leading-6 text-slate-600 dark:text-white/55">
                  Paketi yalnızca bir yönetici satın alır. <strong>{members.length} aktif üyenin</strong> hiçbiri ayrı ödeme yapmaz; ekip birlikte aynı veri ve aylık kullanım haklarından yararlanır.
                </p>
              </div>
            </div>
            <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div className="rounded-lg border border-indigo-200 bg-white/70 p-3 dark:border-white/10 dark:bg-black/15">
                <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-white/35">Ödeme</p>
                <p className="mt-1 text-sm font-bold text-slate-900 dark:text-white">Ekip için tek abonelik</p>
              </div>
              <div className="rounded-lg border border-indigo-200 bg-white/70 p-3 dark:border-white/10 dark:bg-black/15">
                <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-white/35">Kişi hakkı</p>
                <p className="mt-1 text-sm font-bold text-slate-900 dark:text-white">En fazla {numberValue(activePlan.limits.members).toLocaleString('tr-TR')} kişi</p>
              </div>
              <div className="rounded-lg border border-indigo-200 bg-white/70 p-3 dark:border-white/10 dark:bg-black/15">
                <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-white/35">Kullanım hakları</p>
                <p className="mt-1 text-sm font-bold text-slate-900 dark:text-white">Ekipçe ortak kullanılır</p>
              </div>
            </div>
            <p className="mt-4 text-xs leading-5 text-slate-500 dark:text-white/45">Yeni bir çalışma alanı açılırsa o alan Başlangıç paketiyle başlar ve paketi ayrı yönetilir.</p>
          </section>

          <section className="rounded-lg border border-slate-200 bg-white p-5 dark:border-white/10 dark:bg-white/[0.035]">
            <div className="flex flex-col gap-4 border-b border-slate-200 pb-5 dark:border-white/10 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <h2 className="flex items-center gap-2 text-base font-bold text-slate-900 dark:text-white"><Gauge className="h-5 w-5 text-indigo-500 dark:text-[#FFD700]" /> Yapay Zekâ Kullanımı</h2>
                <p className="mt-1 text-xs text-slate-500 dark:text-white/45">Haklar {formatDate(usage?.period?.endsAt)} tarihinde yenilenir. Yalnız başarılı yanıtlar haktan düşer.</p>
              </div>
              <div className="rounded-lg bg-slate-50 px-4 py-3 text-right dark:bg-white/5">
                <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Kalan ortak hak</p>
                <p className="mt-1 text-xl font-bold text-slate-900 dark:text-white">{numberValue(usage?.ai?.remaining).toLocaleString('tr-TR')}</p>
              </div>
            </div>
            <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                ['Bu ay kullanılan', usage?.ai?.used], ['Paket hakkı', usage?.ai?.baseLimit],
                ['Bu aya eklenen', usage?.ai?.bonusCredits], ['Ön ödemeli bakiye', usage?.ai?.creditBalance],
              ].map(([label, value]) => <div key={String(label)} className="rounded-lg border border-slate-200 p-3 dark:border-white/10"><p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">{label}</p><p className="mt-1 text-lg font-bold text-slate-900 dark:text-white">{numberValue(value).toLocaleString('tr-TR')}</p></div>)}
            </div>
            <div className="mt-5 grid grid-cols-1 gap-4 lg:grid-cols-2">
              <div className="rounded-lg border border-slate-200 p-4 dark:border-white/10">
                <p className="text-sm font-bold text-slate-900 dark:text-white">Ekip kullanım ayarları</p>
                <label className="mt-4 block"><span className="mb-2 block text-xs text-slate-500 dark:text-white/50">Kişi başı aylık üst sınır (boşsa ortak kota geçerli)</span><input type="number" min={1} max={1000000} value={perUserAiLimit} onChange={(event) => setPerUserAiLimit(event.target.value)} disabled={!isAdmin} className="min-h-11 w-full rounded-lg border border-slate-300 bg-slate-50 px-3 text-sm dark:border-white/10 dark:bg-white/5 dark:text-white" /></label>
                <label className="mt-4 flex items-start gap-3"><input type="checkbox" checked={autoUseCredits} onChange={(event) => setAutoUseCredits(event.target.checked)} disabled={!isAdmin} className="mt-1 h-4 w-4" /><span className="text-sm text-slate-700 dark:text-white/70">Aylık hak biterse ön ödemeli bakiyeden otomatik olarak ek hak aktar.</span></label>
                <label className="mt-4 block"><span className="mb-2 block text-xs text-slate-500 dark:text-white/50">Otomatik aktarılacak miktar</span><select value={autoCreditBundle} onChange={(event) => setAutoCreditBundle(Number(event.target.value) === 5000 ? 5000 : 1000)} disabled={!isAdmin || !autoUseCredits} className="min-h-11 w-full rounded-lg border border-slate-300 bg-slate-50 px-3 text-sm dark:border-white/10 dark:bg-[#191919] dark:text-white"><option value={1000}>1.000 hak</option><option value={5000}>5.000 hak</option></select></label>
                <button type="button" onClick={handleSaveAiSettings} disabled={!isAdmin || busyAction === 'ai-settings'} className="mt-4 inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 text-xs font-bold text-white disabled:opacity-40 dark:bg-[#FFD700] dark:text-black">{busyAction === 'ai-settings' ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Ayarları Kaydet</button>
              </div>
              <div className="rounded-lg border border-slate-200 p-4 dark:border-white/10">
                <p className="text-sm font-bold text-slate-900 dark:text-white">Ek yapay zekâ hakkı</p>
                <p className="mt-1 text-xs leading-5 text-slate-500 dark:text-white/45">Satın alınan haklar bakiyede kalır. İsterseniz şimdi bu aya aktarın, isterseniz aylık hak bitince otomatik kullanılsın.</p>
                <div className="mt-4 space-y-3">
                  {(creditPackages.length ? creditPackages : [{ quantity: 1000, priceLabel: 'Fiyat tanımlanmadı', amountMinor: null, checkoutAvailable: false }, { quantity: 5000, priceLabel: 'Fiyat tanımlanmadı', amountMinor: null, checkoutAvailable: false }] as AiCreditPackage[]).map((item) => (
                    <div key={item.quantity} className="flex flex-col gap-3 rounded-lg bg-slate-50 p-3 dark:bg-white/5 sm:flex-row sm:items-center">
                      <div className="min-w-0 flex-1"><p className="text-sm font-bold text-slate-900 dark:text-white">{item.quantity.toLocaleString('tr-TR')} ek hak</p><p className="text-xs text-slate-500 dark:text-white/45">{item.priceLabel}</p></div>
                      <button type="button" onClick={() => handleCreditCheckout(item.quantity)} disabled={!isAdmin || !item.checkoutAvailable || busyAction === `credit-${item.quantity}`} className="min-h-10 rounded-lg bg-indigo-600 px-3 text-xs font-bold text-white disabled:opacity-35 dark:bg-[#FFD700] dark:text-black">Satın Al</button>
                      <button type="button" onClick={() => handleAllocateCredits(item.quantity)} disabled={!isAdmin || numberValue(usage?.ai?.creditBalance) < item.quantity || busyAction === `allocate-${item.quantity}`} className="min-h-10 rounded-lg border border-slate-300 px-3 text-xs font-bold text-slate-700 disabled:opacity-35 dark:border-white/15 dark:text-white/70">Bu Aya Aktar</button>
                    </div>
                  ))}
                </div>
                {!creditPackages.some((item) => item.checkoutAvailable) && <p className="mt-3 text-xs text-amber-600 dark:text-amber-300">Satış fiyatı veya iyzico bağlantısı tanımlanınca satın alma düğmeleri açılır.</p>}
              </div>
            </div>
          </section>

          <section>
            <div className="mb-4 flex items-end justify-between gap-3">
              <div>
                <h2 className="text-lg font-bold text-slate-900 dark:text-white">Paketler</h2>
                <p className="mt-1 text-xs text-slate-500 dark:text-white/45">Aktif paket: {activePlan.name}</p>
              </div>
              <ShieldCheck className="h-5 w-5 text-emerald-500" />
            </div>
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
              {plans.map((plan) => {
                const current = plan.key === activePlanKey;
                const selected = plan.key === selectedPlan;
                const visibleLimits = Object.entries(plan.limits).filter(([key]) => ['members', 'datasets', 'connectors', 'aiRequests', 'ai_requests'].includes(key)).slice(0, 4);
                return (
                  <button
                    key={plan.key}
                    type="button"
                    onClick={() => plan.checkoutAvailable && setSelectedPlan(plan.key)}
                    disabled={!isAdmin || current || !plan.checkoutAvailable}
                    className={cn(
                      'flex min-h-64 flex-col rounded-lg border p-5 text-left transition-colors disabled:cursor-not-allowed',
                      current
                        ? 'border-emerald-300 bg-emerald-50/60 dark:border-emerald-500/30 dark:bg-emerald-500/5'
                        : selected
                          ? 'border-indigo-500 bg-indigo-50/60 dark:border-[#FFD700] dark:bg-[#FFD700]/5'
                          : 'border-slate-200 bg-white hover:border-indigo-300 dark:border-white/10 dark:bg-white/[0.035] dark:hover:border-white/25',
                    )}
                  >
                    <div className="flex w-full items-start justify-between gap-3">
                      <div>
                        <p className="text-lg font-bold text-slate-900 dark:text-white">{plan.name}</p>
                        <p className="mt-1 text-sm font-bold text-indigo-600 dark:text-[#FFD700]">{plan.monthlyPriceLabel}</p>
                      </div>
                      {current ? <CheckCircle2 className="h-5 w-5 text-emerald-500" /> : selected ? <Check className="h-5 w-5 text-indigo-600 dark:text-[#FFD700]" /> : <CircleDollarSign className="h-5 w-5 text-slate-300 dark:text-white/20" />}
                    </div>
                    <p className="mt-4 text-xs leading-5 text-slate-500 dark:text-white/45">{plan.description}</p>
                    <div className="mt-5 w-full space-y-2 border-t border-slate-200 pt-4 dark:border-white/10">
                      {visibleLimits.map(([key, limit]) => (
                        <div key={key} className="flex items-center justify-between gap-3 text-xs">
                          <span className="text-slate-500 dark:text-white/45">{METER_LABELS[key] || key}</span>
                          <span className="font-bold text-slate-800 dark:text-white/80">{formatLimit(numberValue(limit), key)}</span>
                        </div>
                      ))}
                    </div>
                    <span className="mt-auto pt-5 text-xs font-bold text-slate-700 dark:text-white/70">{current ? 'Aktif paket' : plan.checkoutAvailable ? 'Paketi seç' : 'Başlangıç paketi'}</span>
                  </button>
                );
              })}
            </div>
          </section>

          {!isAdmin && (
            <div className="flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-300">
              <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" /> Paket ve ödeme değişikliklerini yalnız yöneticiler yapabilir. Diğer ekip üyelerinin ayrıca paket alması gerekmez.
            </div>
          )}

          <section className="rounded-lg border border-slate-200 bg-white p-5 dark:border-white/10 dark:bg-white/[0.035]">
            <div className="flex flex-col gap-3 border-b border-slate-200 pb-5 dark:border-white/10 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h2 className="flex items-center gap-2 text-base font-bold text-slate-900 dark:text-white"><CreditCard className="h-5 w-5 text-indigo-500 dark:text-[#FFD700]" /> Güvenli Ödeme Bilgileri</h2>
                <p className="mt-1 text-xs text-slate-500 dark:text-white/45">{plans.find((plan) => plan.key === selectedPlan)?.name || selectedPlan}</p>
              </div>
              <ExternalLink className="h-5 w-5 text-slate-300 dark:text-white/20" />
            </div>
            <form onSubmit={handleCheckout} className="mt-5 grid grid-cols-1 gap-4 md:grid-cols-2">
              {[
                { key: 'name', label: 'Ad', autoComplete: 'given-name' },
                { key: 'surname', label: 'Soyad', autoComplete: 'family-name' },
                { key: 'email', label: 'E-posta', autoComplete: 'email', type: 'email' },
                { key: 'gsmNumber', label: 'Telefon', autoComplete: 'tel', type: 'tel' },
                { key: 'identityNumber', label: 'T.C. / Vergi Kimlik No', autoComplete: 'off' },
                { key: 'city', label: 'Şehir', autoComplete: 'address-level2' },
                { key: 'country', label: 'Ülke', autoComplete: 'country-name' },
                { key: 'zipCode', label: 'Posta Kodu', autoComplete: 'postal-code', required: false },
              ].map((field) => (
                <label key={field.key} className="block">
                  <span className="mb-2 block text-[10px] font-bold uppercase tracking-widest text-slate-500 dark:text-white/45">{field.label}</span>
                  <input
                    type={field.type || 'text'}
                    autoComplete={field.autoComplete}
                    required={field.required !== false}
                    disabled={!isAdmin}
                    value={customer[field.key as keyof CheckoutCustomer]}
                    onChange={(event) => setCustomer((current) => ({ ...current, [field.key]: event.target.value }))}
                    className="min-h-11 w-full rounded-lg border border-slate-300 bg-slate-50 px-4 text-base text-slate-900 outline-none transition-colors focus:border-indigo-500 disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/10 dark:bg-white/5 dark:text-white dark:focus:border-[#FFD700] md:text-sm"
                  />
                </label>
              ))}
              <label className="block md:col-span-2">
                <span className="mb-2 block text-[10px] font-bold uppercase tracking-widest text-slate-500 dark:text-white/45">Fatura Adresi</span>
                <textarea
                  required
                  disabled={!isAdmin}
                  rows={3}
                  value={customer.address}
                  onChange={(event) => setCustomer((current) => ({ ...current, address: event.target.value }))}
                  className="w-full resize-y rounded-lg border border-slate-300 bg-slate-50 px-4 py-3 text-base text-slate-900 outline-none transition-colors focus:border-indigo-500 disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/10 dark:bg-white/5 dark:text-white dark:focus:border-[#FFD700] md:text-sm"
                />
              </label>
              <div className="flex flex-col gap-3 border-t border-slate-200 pt-5 dark:border-white/10 sm:flex-row sm:items-center sm:justify-between md:col-span-2">
                <p className="text-xs text-slate-500 dark:text-white/45">Kart bilgileri ödeme sağlayıcısının güvenli sayfasında alınır.</p>
                <button
                  type="submit"
                  disabled={!isAdmin || selectedPlan === 'starter' || selectedPlan === activePlanKey || busyAction === 'checkout'}
                  className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-indigo-600 px-5 text-xs font-bold text-white transition-colors hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-[#FFD700] dark:text-black dark:hover:bg-[#ffe24d]"
                >
                  {busyAction === 'checkout' ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <ExternalLink className="h-4 w-4" />}
                  Ödemeye Geç
                </button>
              </div>
            </form>
          </section>

          {activePlanKey !== 'starter' && (
            <section className="flex flex-col gap-4 rounded-lg border border-red-200 bg-red-50/40 p-5 dark:border-red-500/20 dark:bg-red-500/5 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h2 className="text-sm font-bold text-red-700 dark:text-red-300">Aboneliği İptal Et</h2>
                <p className="mt-1 text-xs text-red-600/70 dark:text-red-300/60">Mevcut fatura dönemi ve erişim durumu sunucu tarafından güncellenir.</p>
              </div>
              <div className="flex flex-wrap gap-2">
                {cancelConfirmation && (
                  <button type="button" onClick={() => setCancelConfirmation(false)} className="min-h-11 rounded-lg border border-slate-300 px-4 text-xs font-bold text-slate-700 dark:border-white/15 dark:text-white/70">Vazgeç</button>
                )}
                <button
                  type="button"
                  onClick={handleCancelSubscription}
                  disabled={!isAdmin || busyAction === 'cancel-subscription'}
                  className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-red-600 px-4 text-xs font-bold text-white transition-colors hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {busyAction === 'cancel-subscription' ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                  {cancelConfirmation ? 'İptali Onayla' : 'Aboneliği İptal Et'}
                </button>
              </div>
            </section>
          )}
        </div>
      )}

      {!hasActiveOrganization && activeTab !== 'organization' && (
        <div className="flex min-h-64 flex-col items-center justify-center rounded-lg border border-dashed border-slate-300 px-6 text-center dark:border-white/15">
          <Building2 className="h-8 w-8 text-slate-300 dark:text-white/20" />
          <p className="mt-4 text-sm font-bold text-slate-700 dark:text-white/70">Önce bir çalışma alanı seçin.</p>
        </div>
      )}
    </div>
  );
}
