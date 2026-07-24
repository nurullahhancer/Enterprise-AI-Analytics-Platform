import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { getPlan, type PlanKey } from './plans';

export type BillingProviderName = 'iyzico';
export type IyzicoLocale = 'tr' | 'en';
export type IyzicoSubscriptionInitialStatus = 'ACTIVE' | 'PENDING';
export type IyzicoSubscriptionStatus = 'ACTIVE' | 'PENDING' | 'UNPAID' | 'UPGRADED' | 'CANCELED' | 'EXPIRED';
export type IyzicoSubscriptionEventType = 'subscription.order.success' | 'subscription.order.failure';

const IYZICO_ALLOWED_HOSTS = new Set(['api.iyzipay.com', 'sandbox-api.iyzipay.com']);
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_WEBHOOK_BYTES = 64 * 1024;
const REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const FORBIDDEN_CARD_KEYS = new Set([
  'paymentcard',
  'cardnumber',
  'cardholdername',
  'cvc',
  'cvv',
  'expiremonth',
  'expireyear',
  'expiry',
]);

export class BillingConfigurationError extends Error {
  readonly code = 'BILLING_NOT_CONFIGURED';

  constructor(message = 'Ödeme sağlayıcısı güvenli biçimde yapılandırılmadı.') {
    super(message);
    this.name = 'BillingConfigurationError';
  }
}

export class BillingValidationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'BillingValidationError';
    this.code = code;
  }
}

export class BillingProviderError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;
  readonly providerCode?: string;

  constructor(
    code: string,
    message: string,
    options: { status?: number; retryable?: boolean; providerCode?: string } = {}
  ) {
    super(message);
    this.name = 'BillingProviderError';
    this.code = code;
    this.status = options.status ?? 502;
    this.retryable = options.retryable ?? false;
    this.providerCode = options.providerCode;
  }
}

export interface IyzicoAddress {
  address: string;
  zipCode?: string;
  contactName: string;
  city: string;
  country: string;
  district?: string;
}

export interface IyzicoCustomer {
  name: string;
  surname: string;
  email: string;
  gsmNumber: string;
  identityNumber: string;
  billingAddress: IyzicoAddress;
  shippingAddress?: IyzicoAddress;
}

export interface InitializeHostedSubscriptionInput {
  planCode: PlanKey;
  callbackUrl: string;
  customer: IyzicoCustomer;
  conversationId?: string;
  locale?: IyzicoLocale;
  subscriptionInitialStatus?: IyzicoSubscriptionInitialStatus;
}

export interface HostedSubscriptionCheckout {
  provider: 'iyzico';
  status: 'initialized';
  token: string;
  checkoutFormContent: string;
  paymentPageUrl?: string;
  tokenExpireTime: number;
  conversationId?: string;
  systemTime?: number;
}

export interface RetrieveHostedSubscriptionInput {
  token: string;
  conversationId?: string;
}

export interface SubscriptionCheckoutResult {
  provider: 'iyzico';
  status: 'success';
  token: string;
  conversationId?: string;
  referenceCode: string;
  parentReferenceCode?: string;
  pricingPlanReferenceCode: string;
  customerReferenceCode: string;
  subscriptionStatus: IyzicoSubscriptionStatus;
  trialDays?: number;
  trialStartDate?: number;
  trialEndDate?: number;
  createdDate?: number;
  startDate?: number;
  endDate?: number;
  systemTime?: number;
}

export type AiCreditPackageQuantity = 1000 | 5000;

export interface InitializeAiCreditCheckoutInput {
  quantity: AiCreditPackageQuantity;
  amountMinor: number;
  callbackUrl: string;
  conversationId: string;
  organizationId: string;
  buyerIp: string;
  customer: IyzicoCustomer;
}

export interface AiCreditCheckoutResult {
  provider: 'iyzico';
  status: 'success';
  token: string;
  conversationId: string;
  paymentId: string;
  basketId: string;
  currency: 'TRY';
  priceMinor: number;
  paidPriceMinor: number;
}

export interface IyzicoSubscriptionDetail {
  provider: 'iyzico';
  referenceCode: string;
  parentReferenceCode?: string;
  pricingPlanReferenceCode?: string;
  pricingPlanName?: string;
  productReferenceCode?: string;
  productName?: string;
  customerReferenceCode?: string;
  customerEmail?: string;
  customerGsmNumber?: string;
  subscriptionStatus: IyzicoSubscriptionStatus;
  trialDays?: number;
  trialStartDate?: number;
  trialEndDate?: number;
  createdDate?: number;
  startDate?: number;
  endDate?: number;
  systemTime?: number;
}

export interface CanceledSubscription {
  provider: 'iyzico';
  status: 'canceled';
  referenceCode: string;
  systemTime?: number;
}

export interface IyzicoSubscriptionWebhookEvent {
  orderReferenceCode: string;
  customerReferenceCode: string;
  subscriptionReferenceCode: string;
  iyziReferenceCode: string;
  iyziEventType: IyzicoSubscriptionEventType;
  iyziEventTime: number;
  merchantId?: string | number;
}

export interface VerifiedSubscriptionWebhook {
  provider: 'iyzico';
  eventId: string;
  event: IyzicoSubscriptionWebhookEvent;
}

export interface BillingProvider {
  readonly name: BillingProviderName;
  initializeHostedSubscription(input: InitializeHostedSubscriptionInput): Promise<HostedSubscriptionCheckout>;
  retrieveHostedSubscriptionResult(input: RetrieveHostedSubscriptionInput): Promise<SubscriptionCheckoutResult>;
  initializeAiCreditCheckout(input: InitializeAiCreditCheckoutInput): Promise<HostedSubscriptionCheckout>;
  retrieveAiCreditCheckoutResult(input: RetrieveHostedSubscriptionInput): Promise<AiCreditCheckoutResult>;
  cancelSubscription(subscriptionReferenceCode: string): Promise<CanceledSubscription>;
  getSubscriptionDetails(subscriptionReferenceCode: string): Promise<IyzicoSubscriptionDetail>;
  verifySubscriptionWebhook(payload: unknown, signature: string | string[] | undefined): VerifiedSubscriptionWebhook;
}

export interface IyzicoBillingConfiguration {
  apiKey: string;
  secretKey: string;
  baseUrl: string;
  merchantId?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  fetchImpl?: typeof fetch;
}

export interface PublicIyzicoBillingConfiguration {
  provider: 'iyzico';
  configured: boolean;
  environment?: 'sandbox' | 'live';
  issue?: 'missing-api-key' | 'missing-secret-key' | 'missing-base-url' | 'invalid-base-url';
  configuredPlans: PlanKey[];
  webhookVerificationConfigured: boolean;
  aiCreditPackages: Array<{ quantity: AiCreditPackageQuantity; priceLabel: string; amountMinor: number | null; checkoutAvailable: boolean }>;
}

type JsonObject = Record<string, unknown>;

function boundedInteger(raw: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(raw);
  return Number.isInteger(parsed) ? Math.max(minimum, Math.min(parsed, maximum)) : fallback;
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requireString(value: unknown, field: string, maximum = 200): string {
  if (typeof value !== 'string') {
    throw new BillingValidationError('INVALID_BILLING_INPUT', `${field} alanı geçersiz.`);
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || /[\0\r\n]/.test(normalized)) {
    throw new BillingValidationError('INVALID_BILLING_INPUT', `${field} alanı geçersiz.`);
  }
  return normalized;
}

function optionalString(value: unknown, maximum = 200): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return requireString(value, 'Sağlayıcı yanıtı', maximum);
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function requireProviderContent(value: unknown, field: string, maximum: number): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > maximum ||
    value.includes('\0')
  ) {
    throw new BillingProviderError('BILLING_MALFORMED_RESPONSE', `Ödeme sağlayıcısı ${field} alanını döndürmedi.`);
  }
  return value;
}

function normalizeLocale(value: unknown): IyzicoLocale {
  if (value === undefined) return 'tr';
  if (value === 'tr' || value === 'en') return value;
  throw new BillingValidationError('INVALID_BILLING_INPUT', 'locale alanı geçersiz.');
}

function normalizeInitialStatus(value: unknown): IyzicoSubscriptionInitialStatus {
  if (value === undefined) return 'ACTIVE';
  if (value === 'ACTIVE' || value === 'PENDING') return value;
  throw new BillingValidationError('INVALID_BILLING_INPUT', 'subscriptionInitialStatus alanı geçersiz.');
}

function requireReference(value: unknown, field: string): string {
  const reference = requireString(value, field, 200);
  if (!REFERENCE_PATTERN.test(reference)) {
    throw new BillingValidationError('INVALID_BILLING_REFERENCE', `${field} geçersiz.`);
  }
  return reference;
}

function assertNoCardData(value: unknown, depth = 0): void {
  if (!value || typeof value !== 'object' || depth > 6) return;
  for (const [key, child] of Object.entries(value as JsonObject)) {
    const normalizedKey = key.toLowerCase().replace(/[_-]/g, '');
    if (FORBIDDEN_CARD_KEYS.has(normalizedKey)) {
      throw new BillingValidationError(
        'CARD_DATA_NOT_ALLOWED',
        'Kart bilgisi uygulama sunucusuna gönderilemez; iyzico ödeme formunu kullanın.'
      );
    }
    assertNoCardData(child, depth + 1);
  }
}

function normalizeAddress(address: IyzicoAddress, field: string): Required<Omit<IyzicoAddress, 'zipCode' | 'district'>> & Pick<IyzicoAddress, 'zipCode' | 'district'> {
  if (!isObject(address)) {
    throw new BillingValidationError('INVALID_BILLING_INPUT', `${field} geçersiz.`);
  }
  return {
    address: requireString(address.address, `${field}.address`, 500),
    contactName: requireString(address.contactName, `${field}.contactName`, 120),
    city: requireString(address.city, `${field}.city`, 100),
    country: requireString(address.country, `${field}.country`, 100),
    ...(address.zipCode ? { zipCode: requireString(address.zipCode, `${field}.zipCode`, 20) } : {}),
    ...(address.district ? { district: requireString(address.district, `${field}.district`, 100) } : {}),
  };
}

function normalizeCustomer(customer: IyzicoCustomer): JsonObject {
  if (!isObject(customer)) {
    throw new BillingValidationError('INVALID_BILLING_INPUT', 'Müşteri bilgileri geçersiz.');
  }
  assertNoCardData(customer);
  const email = requireString(customer.email, 'customer.email', 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new BillingValidationError('INVALID_BILLING_INPUT', 'Müşteri e-posta adresi geçersiz.');
  }
  const gsmNumber = requireString(customer.gsmNumber, 'customer.gsmNumber', 24);
  if (!/^\+?[0-9]{7,20}$/.test(gsmNumber)) {
    throw new BillingValidationError('INVALID_BILLING_INPUT', 'Müşteri telefon numarası geçersiz.');
  }
  const billingAddress = normalizeAddress(customer.billingAddress, 'customer.billingAddress');
  const shippingAddress = normalizeAddress(customer.shippingAddress ?? customer.billingAddress, 'customer.shippingAddress');
  return {
    name: requireString(customer.name, 'customer.name', 100),
    surname: requireString(customer.surname, 'customer.surname', 100),
    identityNumber: requireString(customer.identityNumber, 'customer.identityNumber', 64),
    email,
    gsmNumber,
    billingAddress,
    shippingAddress,
  };
}

function validateCallbackUrl(rawUrl: string): string {
  const value = requireString(rawUrl, 'callbackUrl', 2_000);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new BillingValidationError('INVALID_CALLBACK_URL', 'Ödeme dönüş adresi geçersiz.');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new BillingValidationError('INVALID_CALLBACK_URL', 'Ödeme dönüş adresi güvenli bir HTTPS adresi olmalıdır.');
  }
  const appUrl = process.env.APP_URL?.trim();
  if (appUrl) {
    try {
      if (new URL(appUrl).origin !== url.origin) {
        throw new BillingValidationError('INVALID_CALLBACK_URL', 'Ödeme dönüş adresi uygulama origin değeriyle eşleşmelidir.');
      }
    } catch (error) {
      if (error instanceof BillingValidationError) throw error;
      throw new BillingConfigurationError('APP_URL ödeme dönüş adresini doğrulamak için geçerli bir HTTPS adresi olmalıdır.');
    }
  }
  return url.toString();
}

function validateBaseUrl(rawUrl: string): { url: string; environment: 'sandbox' | 'live' } {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new BillingConfigurationError('IYZICO_BASE_URL geçerli bir URL olmalıdır.');
  }
  if (
    url.protocol !== 'https:' ||
    !IYZICO_ALLOWED_HOSTS.has(url.hostname.toLowerCase()) ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash ||
    (url.pathname !== '/' && url.pathname !== '')
  ) {
    throw new BillingConfigurationError('IYZICO_BASE_URL resmi iyzico live veya sandbox HTTPS API adresi olmalıdır.');
  }
  const host = url.hostname.toLowerCase();
  return {
    url: `${url.protocol}//${host}`,
    environment: host.startsWith('sandbox-') ? 'sandbox' : 'live',
  };
}

function configuredPlans(): PlanKey[] {
  return (['starter', 'professional', 'enterprise'] as PlanKey[]).filter((planCode) => {
    const envName = getPlan(planCode).billingPlanEnv;
    return Boolean(envName && process.env[envName]?.trim());
  });
}

function parsePriceMinor(name: string): number | null {
  const raw = process.env[name]?.trim().replace(',', '.');
  if (!raw || !/^\d{1,7}(?:\.\d{1,2})?$/.test(raw)) return null;
  const amount = Math.round(Number(raw) * 100);
  return Number.isSafeInteger(amount) && amount > 0 ? amount : null;
}

export function getAiCreditPackages() {
  return ([1000, 5000] as AiCreditPackageQuantity[]).map((quantity) => {
    const amountMinor = parsePriceMinor(`AI_CREDIT_${quantity}_PRICE_TRY`);
    return {
      quantity,
      amountMinor,
      priceLabel: amountMinor === null ? 'Fiyat yapılandırılmadı' : new Intl.NumberFormat('tr-TR', { style: 'currency', currency: 'TRY' }).format(amountMinor / 100)
    };
  });
}

export function resolveIyzicoPlanReferenceCode(planCode: PlanKey): string {
  const plan = getPlan(planCode);
  if (plan.key !== planCode) {
    throw new BillingValidationError('INVALID_PLAN', 'Abonelik paketi geçersiz.');
  }
  if (!plan.billingPlanEnv) {
    throw new BillingValidationError('PLAN_NOT_BILLABLE', 'Bu paket için ücretli abonelik başlatılamaz.');
  }
  const referenceCode = process.env[plan.billingPlanEnv]?.trim();
  if (!referenceCode) {
    throw new BillingConfigurationError(`${plan.billingPlanEnv} yapılandırılmalıdır.`);
  }
  return requireReference(referenceCode, plan.billingPlanEnv);
}

export function getIyzicoBillingConfiguration(): PublicIyzicoBillingConfiguration {
  const apiKey = process.env.IYZICO_API_KEY?.trim();
  const secretKey = process.env.IYZICO_SECRET_KEY?.trim();
  const baseUrl = process.env.IYZICO_BASE_URL?.trim();
  const common = {
    provider: 'iyzico' as const,
    configuredPlans: configuredPlans(),
    webhookVerificationConfigured: Boolean(secretKey && process.env.IYZICO_MERCHANT_ID?.trim()),
    aiCreditPackages: getAiCreditPackages().map((item) => ({ ...item, checkoutAvailable: Boolean(apiKey && secretKey && baseUrl && item.amountMinor) })),
  };
  if (!apiKey) return { ...common, configured: false, issue: 'missing-api-key' };
  if (!secretKey) return { ...common, configured: false, issue: 'missing-secret-key' };
  if (!baseUrl) return { ...common, configured: false, issue: 'missing-base-url' };
  try {
    const validated = validateBaseUrl(baseUrl);
    return { ...common, configured: true, environment: validated.environment };
  } catch {
    return { ...common, configured: false, issue: 'invalid-base-url' };
  }
}

function configurationFromEnv(): IyzicoBillingConfiguration {
  const apiKey = process.env.IYZICO_API_KEY?.trim();
  const secretKey = process.env.IYZICO_SECRET_KEY?.trim();
  const baseUrl = process.env.IYZICO_BASE_URL?.trim();
  if (!apiKey || apiKey.length > 512 || /[\0\r\n]/.test(apiKey)) {
    throw new BillingConfigurationError('IYZICO_API_KEY yapılandırılmalıdır.');
  }
  if (!secretKey || secretKey.length > 512 || /[\0\r\n]/.test(secretKey)) {
    throw new BillingConfigurationError('IYZICO_SECRET_KEY yapılandırılmalıdır.');
  }
  if (!baseUrl) throw new BillingConfigurationError('IYZICO_BASE_URL yapılandırılmalıdır.');
  return {
    apiKey,
    secretKey,
    baseUrl,
    merchantId: process.env.IYZICO_MERCHANT_ID?.trim(),
    timeoutMs: boundedInteger(process.env.IYZICO_REQUEST_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 3_000, 60_000),
    maxResponseBytes: boundedInteger(
      process.env.IYZICO_MAX_RESPONSE_BYTES,
      DEFAULT_MAX_RESPONSE_BYTES,
      64 * 1024,
      5 * 1024 * 1024
    ),
  };
}

function parseProviderStatus(value: unknown): 'success' | 'failure' {
  if (value === 'success' || value === 'failure') return value;
  throw new BillingProviderError('BILLING_MALFORMED_RESPONSE', 'Ödeme sağlayıcısı beklenmeyen bir yanıt döndürdü.');
}

function providerErrorCode(body: JsonObject): string | undefined {
  const value = body.errorCode;
  return typeof value === 'string' && value.length <= 100 ? value : undefined;
}

function parseSubscriptionStatus(value: unknown): IyzicoSubscriptionStatus {
  if (typeof value === 'string' && ['ACTIVE', 'PENDING', 'UNPAID', 'UPGRADED', 'CANCELED', 'EXPIRED'].includes(value)) {
    return value as IyzicoSubscriptionStatus;
  }
  throw new BillingProviderError('BILLING_MALFORMED_RESPONSE', 'Ödeme sağlayıcısı abonelik durumunu döndürmedi.');
}

function parsePaymentPageUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

function parseWebhookPayload(payload: unknown): IyzicoSubscriptionWebhookEvent {
  let value = payload;
  if (Buffer.isBuffer(value)) {
    if (value.byteLength > MAX_WEBHOOK_BYTES) {
      throw new BillingValidationError('WEBHOOK_TOO_LARGE', 'Webhook gövdesi izin verilen boyutu aşıyor.');
    }
    value = value.toString('utf8');
  }
  if (typeof value === 'string') {
    if (Buffer.byteLength(value, 'utf8') > MAX_WEBHOOK_BYTES) {
      throw new BillingValidationError('WEBHOOK_TOO_LARGE', 'Webhook gövdesi izin verilen boyutu aşıyor.');
    }
    try {
      value = JSON.parse(value);
    } catch {
      throw new BillingValidationError('INVALID_WEBHOOK', 'Webhook gövdesi geçersiz.');
    }
  }
  if (!isObject(value)) {
    throw new BillingValidationError('INVALID_WEBHOOK', 'Webhook gövdesi geçersiz.');
  }
  const eventType = value.iyziEventType;
  if (eventType !== 'subscription.order.success' && eventType !== 'subscription.order.failure') {
    throw new BillingValidationError('INVALID_WEBHOOK_EVENT', 'Webhook olay türü desteklenmiyor.');
  }
  const eventTime = Number(value.iyziEventTime);
  if (!Number.isSafeInteger(eventTime) || eventTime <= 0) {
    throw new BillingValidationError('INVALID_WEBHOOK', 'Webhook olay zamanı geçersiz.');
  }
  return {
    orderReferenceCode: requireReference(value.orderReferenceCode, 'orderReferenceCode'),
    customerReferenceCode: requireReference(value.customerReferenceCode, 'customerReferenceCode'),
    subscriptionReferenceCode: requireReference(value.subscriptionReferenceCode, 'subscriptionReferenceCode'),
    iyziReferenceCode: requireReference(value.iyziReferenceCode, 'iyziReferenceCode'),
    iyziEventType: eventType,
    iyziEventTime: eventTime,
    ...(typeof value.merchantId === 'string' || typeof value.merchantId === 'number' ? { merchantId: value.merchantId } : {}),
  };
}

export class IyzicoBillingProvider implements BillingProvider {
  readonly name = 'iyzico' as const;
  private readonly apiKey: string;
  private readonly secretKey: string;
  private readonly baseUrl: string;
  private readonly merchantId?: string;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly fetchImpl: typeof fetch;

  constructor(configuration: IyzicoBillingConfiguration) {
    const { url } = validateBaseUrl(configuration.baseUrl);
    this.apiKey = requireString(configuration.apiKey, 'IYZICO_API_KEY', 512);
    this.secretKey = requireString(configuration.secretKey, 'IYZICO_SECRET_KEY', 512);
    this.baseUrl = url;
    this.merchantId = configuration.merchantId?.trim();
    this.timeoutMs = Math.max(3_000, Math.min(configuration.timeoutMs ?? DEFAULT_TIMEOUT_MS, 60_000));
    this.maxResponseBytes = Math.max(
      64 * 1024,
      Math.min(configuration.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES, 5 * 1024 * 1024)
    );
    this.fetchImpl = configuration.fetchImpl ?? fetch;
  }

  async initializeHostedSubscription(input: InitializeHostedSubscriptionInput): Promise<HostedSubscriptionCheckout> {
    assertNoCardData(input);
    const planReferenceCode = resolveIyzicoPlanReferenceCode(input.planCode);
    const conversationId = input.conversationId === undefined
      ? undefined
      : requireReference(input.conversationId, 'conversationId');
    const body = {
      locale: normalizeLocale(input.locale),
      callbackUrl: validateCallbackUrl(input.callbackUrl),
      pricingPlanReferenceCode: planReferenceCode,
      subscriptionInitialStatus: normalizeInitialStatus(input.subscriptionInitialStatus),
      ...(conversationId ? { conversationId } : {}),
      customer: normalizeCustomer(input.customer),
    };
    const response = await this.request('POST', '/v2/subscription/checkoutform/initialize', body);
    if (parseProviderStatus(response.status) !== 'success') {
      throw this.providerFailure(response);
    }
    const token = requireReference(response.token, 'token');
    const checkoutFormContent = requireProviderContent(
      response.checkoutFormContent,
      'checkoutFormContent',
      this.maxResponseBytes
    );
    const tokenExpireTime = Number(response.tokenExpireTime);
    if (!Number.isSafeInteger(tokenExpireTime) || tokenExpireTime <= 0 || tokenExpireTime > 86_400) {
      throw new BillingProviderError('BILLING_MALFORMED_RESPONSE', 'Ödeme formu geçerlilik süresi alınamadı.');
    }
    return {
      provider: 'iyzico',
      status: 'initialized',
      token,
      checkoutFormContent,
      tokenExpireTime,
      ...(parsePaymentPageUrl(response.paymentPageUrl) ? { paymentPageUrl: parsePaymentPageUrl(response.paymentPageUrl) } : {}),
      ...(optionalString(response.conversationId) ? { conversationId: optionalString(response.conversationId) } : {}),
      ...(optionalNumber(response.systemTime) !== undefined ? { systemTime: optionalNumber(response.systemTime) } : {}),
    };
  }

  async retrieveHostedSubscriptionResult(input: RetrieveHostedSubscriptionInput): Promise<SubscriptionCheckoutResult> {
    const token = requireReference(input.token, 'token');
    const path = `/v2/subscription/checkoutform/${encodeURIComponent(token)}`;
    const response = await this.request('GET', path);
    if (parseProviderStatus(response.status) !== 'success') {
      throw this.providerFailure(response);
    }
    if (!isObject(response.data)) {
      throw new BillingProviderError('BILLING_MALFORMED_RESPONSE', 'Abonelik sonucu alınamadı.');
    }
    const data = response.data;
    return {
      provider: 'iyzico',
      status: 'success',
      token: optionalString(response.token) ?? token,
      referenceCode: requireReference(data.referenceCode, 'referenceCode'),
      pricingPlanReferenceCode: requireReference(data.pricingPlanReferenceCode, 'pricingPlanReferenceCode'),
      customerReferenceCode: requireReference(data.customerReferenceCode, 'customerReferenceCode'),
      subscriptionStatus: parseSubscriptionStatus(data.subscriptionStatus),
      ...(optionalString(response.conversationId) ? { conversationId: optionalString(response.conversationId) } : {}),
      ...(optionalString(data.parentReferenceCode) ? { parentReferenceCode: optionalString(data.parentReferenceCode) } : {}),
      ...(optionalNumber(data.trialDays) !== undefined ? { trialDays: optionalNumber(data.trialDays) } : {}),
      ...(optionalNumber(data.trialStartDate) !== undefined ? { trialStartDate: optionalNumber(data.trialStartDate) } : {}),
      ...(optionalNumber(data.trialEndDate) !== undefined ? { trialEndDate: optionalNumber(data.trialEndDate) } : {}),
      ...(optionalNumber(data.createdDate) !== undefined ? { createdDate: optionalNumber(data.createdDate) } : {}),
      ...(optionalNumber(data.startDate) !== undefined ? { startDate: optionalNumber(data.startDate) } : {}),
      ...(optionalNumber(data.endDate) !== undefined ? { endDate: optionalNumber(data.endDate) } : {}),
      ...(optionalNumber(response.systemTime) !== undefined ? { systemTime: optionalNumber(response.systemTime) } : {}),
    };
  }

  async initializeAiCreditCheckout(input: InitializeAiCreditCheckoutInput): Promise<HostedSubscriptionCheckout> {
    assertNoCardData(input);
    if ((input.quantity !== 1000 && input.quantity !== 5000) || !Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) {
      throw new BillingValidationError('INVALID_AI_CREDIT_PACKAGE', 'Ek yapay zekâ hakkı paketi geçersiz.');
    }
    const customer = normalizeCustomer(input.customer);
    const conversationId = requireReference(input.conversationId, 'conversationId');
    const basketId = requireReference(`AI-${input.organizationId}-${input.quantity}`, 'basketId');
    const buyerIp = requireString(input.buyerIp, 'buyer.ip', 64);
    const price = Number((input.amountMinor / 100).toFixed(2));
    const billingAddress = customer.billingAddress as JsonObject;
    const response = await this.request('POST', '/payment/iyzipos/checkoutform/initialize/auth/ecom', {
      locale: 'tr',
      conversationId,
      price,
      paidPrice: price,
      currency: 'TRY',
      basketId,
      paymentGroup: 'PRODUCT',
      callbackUrl: validateCallbackUrl(input.callbackUrl),
      buyer: {
        id: requireReference(`BUYER-${input.organizationId}`, 'buyer.id'),
        name: customer.name,
        surname: customer.surname,
        gsmNumber: customer.gsmNumber,
        email: customer.email,
        identityNumber: customer.identityNumber,
        registrationAddress: billingAddress.address,
        ip: buyerIp,
        city: billingAddress.city,
        country: billingAddress.country,
        ...(billingAddress.zipCode ? { zipCode: billingAddress.zipCode } : {})
      },
      billingAddress,
      basketItems: [{
        id: `AI_CREDIT_${input.quantity}`,
        name: `${input.quantity.toLocaleString('tr-TR')} ek yapay zekâ hakkı`,
        category1: 'Dijital Hizmet',
        itemType: 'VIRTUAL',
        price
      }]
    });
    if (parseProviderStatus(response.status) !== 'success') throw this.providerFailure(response);
    const token = requireReference(response.token, 'token');
    const checkoutFormContent = requireProviderContent(response.checkoutFormContent, 'checkoutFormContent', this.maxResponseBytes);
    const tokenExpireTime = Number(response.tokenExpireTime || 1800);
    if (!Number.isSafeInteger(tokenExpireTime) || tokenExpireTime <= 0 || tokenExpireTime > 86_400) {
      throw new BillingProviderError('BILLING_MALFORMED_RESPONSE', 'Ödeme formu geçerlilik süresi alınamadı.');
    }
    return { provider: 'iyzico', status: 'initialized', token, checkoutFormContent, tokenExpireTime,
      ...(parsePaymentPageUrl(response.paymentPageUrl) ? { paymentPageUrl: parsePaymentPageUrl(response.paymentPageUrl) } : {}),
      ...(optionalString(response.conversationId) ? { conversationId: optionalString(response.conversationId) } : {}) };
  }

  async retrieveAiCreditCheckoutResult(input: RetrieveHostedSubscriptionInput): Promise<AiCreditCheckoutResult> {
    const token = requireReference(input.token, 'token');
    const conversationId = input.conversationId ? requireReference(input.conversationId, 'conversationId') : undefined;
    const response = await this.request('POST', '/payment/iyzipos/checkoutform/auth/ecom/detail', {
      locale: 'tr', ...(conversationId ? { conversationId } : {}), token
    });
    if (parseProviderStatus(response.status) !== 'success' || response.paymentStatus !== 'SUCCESS' || Number(response.fraudStatus) !== 1) {
      throw this.providerFailure(response);
    }
    const returnedToken = requireReference(response.token, 'token');
    const returnedConversation = requireReference(response.conversationId, 'conversationId');
    const paymentId = requireReference(response.paymentId, 'paymentId');
    const basketId = requireReference(response.basketId, 'basketId');
    const currency = requireString(response.currency, 'currency', 3);
    const priceMinor = Math.round(Number(response.price) * 100);
    const paidPriceMinor = Math.round(Number(response.paidPrice) * 100);
    if (returnedToken !== token || currency !== 'TRY' || !Number.isSafeInteger(priceMinor) || priceMinor <= 0 || !Number.isSafeInteger(paidPriceMinor) || paidPriceMinor < priceMinor) {
      throw new BillingProviderError('BILLING_MALFORMED_RESPONSE', 'Ödeme sonucu tutar veya para birimi doğrulanamadı.');
    }
    const signature = requireString(response.signature, 'signature', 256);
    const signatureMessage = [response.paymentStatus, paymentId, currency, basketId, returnedConversation, response.paidPrice, response.price, returnedToken].join('');
    const expected = createHmac('sha256', this.secretKey).update(signatureMessage, 'utf8').digest();
    const received = /^[a-f0-9]{64}$/i.test(signature) ? Buffer.from(signature, 'hex') : Buffer.alloc(0);
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
      throw new BillingValidationError('INVALID_PAYMENT_SIGNATURE', 'Ödeme sonucu imzası doğrulanamadı.');
    }
    return { provider: 'iyzico', status: 'success', token: returnedToken, conversationId: returnedConversation, paymentId, basketId, currency: 'TRY', priceMinor, paidPriceMinor };
  }

  async cancelSubscription(subscriptionReferenceCode: string): Promise<CanceledSubscription> {
    const referenceCode = requireReference(subscriptionReferenceCode, 'subscriptionReferenceCode');
    const response = await this.request(
      'POST',
      `/v2/subscription/subscriptions/${encodeURIComponent(referenceCode)}/cancel`,
      {}
    );
    if (parseProviderStatus(response.status) !== 'success') {
      throw this.providerFailure(response);
    }
    return {
      provider: 'iyzico',
      status: 'canceled',
      referenceCode,
      ...(optionalNumber(response.systemTime) !== undefined ? { systemTime: optionalNumber(response.systemTime) } : {}),
    };
  }

  async getSubscriptionDetails(subscriptionReferenceCode: string): Promise<IyzicoSubscriptionDetail> {
    const requestedReference = requireReference(subscriptionReferenceCode, 'subscriptionReferenceCode');
    const response = await this.request(
      'GET',
      `/v2/subscription/subscriptions/${encodeURIComponent(requestedReference)}`
    );
    if (parseProviderStatus(response.status) !== 'success') {
      throw this.providerFailure(response);
    }
    if (!isObject(response.data)) {
      throw new BillingProviderError('BILLING_MALFORMED_RESPONSE', 'Abonelik detayı alınamadı.');
    }
    const direct = response.data;
    const item = Array.isArray(direct.items) && isObject(direct.items[0]) ? direct.items[0] : direct;
    return {
      provider: 'iyzico',
      referenceCode: optionalString(item.referenceCode) ?? requestedReference,
      subscriptionStatus: parseSubscriptionStatus(item.subscriptionStatus),
      ...(optionalString(item.parentReferenceCode) ? { parentReferenceCode: optionalString(item.parentReferenceCode) } : {}),
      ...(optionalString(item.pricingPlanReferenceCode) ? { pricingPlanReferenceCode: optionalString(item.pricingPlanReferenceCode) } : {}),
      ...(optionalString(item.pricingPlanName) ? { pricingPlanName: optionalString(item.pricingPlanName) } : {}),
      ...(optionalString(item.productReferenceCode) ? { productReferenceCode: optionalString(item.productReferenceCode) } : {}),
      ...(optionalString(item.productName) ? { productName: optionalString(item.productName) } : {}),
      ...(optionalString(item.customerReferenceCode) ? { customerReferenceCode: optionalString(item.customerReferenceCode) } : {}),
      ...(optionalString(item.customerEmail, 254) ? { customerEmail: optionalString(item.customerEmail, 254) } : {}),
      ...(optionalString(item.customerGsmNumber, 24) ? { customerGsmNumber: optionalString(item.customerGsmNumber, 24) } : {}),
      ...(optionalNumber(item.trialDays) !== undefined ? { trialDays: optionalNumber(item.trialDays) } : {}),
      ...(optionalNumber(item.trialStartDate) !== undefined ? { trialStartDate: optionalNumber(item.trialStartDate) } : {}),
      ...(optionalNumber(item.trialEndDate) !== undefined ? { trialEndDate: optionalNumber(item.trialEndDate) } : {}),
      ...(optionalNumber(item.createdDate) !== undefined ? { createdDate: optionalNumber(item.createdDate) } : {}),
      ...(optionalNumber(item.startDate) !== undefined ? { startDate: optionalNumber(item.startDate) } : {}),
      ...(optionalNumber(item.endDate) !== undefined ? { endDate: optionalNumber(item.endDate) } : {}),
      ...(optionalNumber(response.systemTime) !== undefined ? { systemTime: optionalNumber(response.systemTime) } : {}),
    };
  }

  verifySubscriptionWebhook(payload: unknown, signature: string | string[] | undefined): VerifiedSubscriptionWebhook {
    const event = parseWebhookPayload(payload);
    const merchantId = String(event.merchantId ?? this.merchantId ?? '').trim();
    if (!/^\d{1,32}$/.test(merchantId)) {
      throw new BillingConfigurationError('IYZICO_MERCHANT_ID webhook V3 doğrulaması için yapılandırılmalıdır.');
    }
    const presented = Array.isArray(signature) ? signature[0] : signature;
    if (typeof presented !== 'string' || !/^[a-f0-9]{64}$/i.test(presented.trim())) {
      throw new BillingValidationError('INVALID_WEBHOOK_SIGNATURE', 'Webhook imzası geçersiz.');
    }
    const message = [
      merchantId,
      this.secretKey,
      event.iyziEventType,
      event.subscriptionReferenceCode,
      event.orderReferenceCode,
      event.customerReferenceCode,
    ].join('');
    const expected = createHmac('sha256', this.secretKey).update(message, 'utf8').digest();
    const received = Buffer.from(presented.trim(), 'hex');
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
      throw new BillingValidationError('INVALID_WEBHOOK_SIGNATURE', 'Webhook imzası geçersiz.');
    }
    return { provider: 'iyzico', eventId: event.iyziReferenceCode, event };
  }

  private async request(
    method: 'GET' | 'POST',
    path: string,
    body?: JsonObject
  ): Promise<JsonObject> {
    if (!path.startsWith('/') || path.includes('..')) {
      throw new BillingValidationError('INVALID_PROVIDER_PATH', 'Ödeme sağlayıcısı istek yolu geçersiz.');
    }
    const signingBody = body ?? {};
    const serializedBody = JSON.stringify(signingBody);
    const randomKey = `${Date.now()}${randomBytes(16).toString('hex')}`;
    const signature = createHmac('sha256', this.secretKey)
      .update(`${randomKey}${path}${serializedBody}`, 'utf8')
      .digest('hex');
    const authorizationPayload = Buffer.from(
      `apiKey:${this.apiKey}&randomKey:${randomKey}&signature:${signature}`,
      'utf8'
    ).toString('base64');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Authorization: `IYZWSv2 ${authorizationPayload}`,
          'x-iyzi-rnd': randomKey,
        },
        ...(method === 'POST' ? { body: serializedBody } : {}),
        redirect: 'error',
        signal: controller.signal,
      });
      const responseBody = await this.readResponse(response);
      let parsed: unknown;
      try {
        parsed = JSON.parse(responseBody);
      } catch {
        throw new BillingProviderError('BILLING_MALFORMED_RESPONSE', 'Ödeme sağlayıcısı geçersiz yanıt döndürdü.');
      }
      if (!isObject(parsed)) {
        throw new BillingProviderError('BILLING_MALFORMED_RESPONSE', 'Ödeme sağlayıcısı geçersiz yanıt döndürdü.');
      }
      if (!response.ok) {
        throw new BillingProviderError('BILLING_PROVIDER_REJECTED', 'Ödeme sağlayıcısı isteği kabul etmedi.', {
          status: response.status === 429 ? 429 : 502,
          retryable: response.status === 429 || response.status >= 500,
          providerCode: providerErrorCode(parsed),
        });
      }
      return parsed;
    } catch (error) {
      if (error instanceof BillingProviderError || error instanceof BillingValidationError) throw error;
      if (error instanceof Error && error.name === 'AbortError') {
        throw new BillingProviderError('BILLING_PROVIDER_TIMEOUT', 'Ödeme sağlayıcısı zaman aşımına uğradı.', {
          status: 504,
          retryable: true,
        });
      }
      throw new BillingProviderError('BILLING_PROVIDER_UNAVAILABLE', 'Ödeme sağlayıcısına ulaşılamadı.', {
        status: 502,
        retryable: true,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private async readResponse(response: Response): Promise<string> {
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType && !contentType.toLowerCase().includes('json')) {
      await response.body?.cancel();
      throw new BillingProviderError('BILLING_MALFORMED_RESPONSE', 'Ödeme sağlayıcısı JSON yanıtı döndürmedi.');
    }
    const advertisedLength = Number(response.headers.get('content-length') || 0);
    if (Number.isFinite(advertisedLength) && advertisedLength > this.maxResponseBytes) {
      await response.body?.cancel();
      throw new BillingProviderError('BILLING_RESPONSE_TOO_LARGE', 'Ödeme sağlayıcısı yanıtı izin verilen boyutu aşıyor.');
    }
    if (!response.body) return '';
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > this.maxResponseBytes) {
        await reader.cancel();
        throw new BillingProviderError('BILLING_RESPONSE_TOO_LARGE', 'Ödeme sağlayıcısı yanıtı izin verilen boyutu aşıyor.');
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
  }

  private providerFailure(response: JsonObject): BillingProviderError {
    return new BillingProviderError('BILLING_PROVIDER_REJECTED', 'Ödeme sağlayıcısı işlemi kabul etmedi.', {
      status: 422,
      providerCode: providerErrorCode(response),
    });
  }
}

export function createIyzicoBillingProvider(
  configuration: IyzicoBillingConfiguration = configurationFromEnv()
): IyzicoBillingProvider {
  return new IyzicoBillingProvider(configuration);
}

export function getBillingProvider(): BillingProvider {
  return createIyzicoBillingProvider();
}

export function verifyIyzicoSubscriptionWebhook(
  payload: unknown,
  signature: string | string[] | undefined,
  configuration: IyzicoBillingConfiguration = configurationFromEnv()
): VerifiedSubscriptionWebhook {
  return new IyzicoBillingProvider(configuration).verifySubscriptionWebhook(payload, signature);
}
