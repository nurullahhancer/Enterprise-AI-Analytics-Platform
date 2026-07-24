import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BillingValidationError, createIyzicoBillingProvider } from './billing';

const configuration = {
  apiKey: 'sandbox-api-key',
  secretKey: 'sandbox-secret-key',
  merchantId: '123456',
  baseUrl: 'https://sandbox-api.iyzipay.com'
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('iyzico hosted subscription adapter', () => {
  it('initializes the hosted form without accepting card data', async () => {
    vi.stubEnv('APP_URL', 'https://app.example.com');
    vi.stubEnv('IYZICO_PLAN_PROFESSIONAL', 'pricing-plan-professional');
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      status: 'success',
      token: 'checkout-token',
      checkoutFormContent: '<script src="https://sandbox-static.iyzipay.com/checkout.js"></script>',
      tokenExpireTime: 1800,
      conversationId: 'conv_test'
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const provider = createIyzicoBillingProvider({ ...configuration, fetchImpl });

    const result = await provider.initializeHostedSubscription({
      planCode: 'professional',
      callbackUrl: 'https://app.example.com/api/saas/billing/callback',
      conversationId: 'conv_test',
      customer: {
        name: 'Ada', surname: 'Lovelace', email: 'ada@example.com', gsmNumber: '+905551112233', identityNumber: '11111111111',
        billingAddress: { address: 'Test Caddesi 1', contactName: 'Ada Lovelace', city: 'Istanbul', country: 'Turkiye' }
      }
    });

    expect(result.token).toBe('checkout-token');
    expect(fetchImpl).toHaveBeenCalledOnce();
    const request = fetchImpl.mock.calls[0][1];
    expect(request.headers.Authorization).toMatch(/^IYZWSv2 /);
    expect(request.body).not.toContain('cardNumber');

    await expect(provider.initializeHostedSubscription({
      planCode: 'professional',
      callbackUrl: 'https://app.example.com/api/saas/billing/callback',
      customer: { cardNumber: '4111111111111111' } as never
    })).rejects.toMatchObject({ code: 'CARD_DATA_NOT_ALLOWED' });
  });

  it('verifies the V3 webhook signature and rejects tampering', () => {
    const provider = createIyzicoBillingProvider(configuration);
    const payload = {
      merchantId: 123456,
      iyziEventType: 'subscription.order.success',
      subscriptionReferenceCode: 'sub_ref_1',
      orderReferenceCode: 'order_ref_1',
      customerReferenceCode: 'customer_ref_1',
      iyziReferenceCode: 'event_ref_1',
      iyziEventTime: Date.now()
    };
    const message = `123456${configuration.secretKey}${payload.iyziEventType}${payload.subscriptionReferenceCode}${payload.orderReferenceCode}${payload.customerReferenceCode}`;
    const signature = createHmac('sha256', configuration.secretKey).update(message).digest('hex');

    expect(provider.verifySubscriptionWebhook(payload, signature).eventId).toBe('event_ref_1');
    expect(() => provider.verifySubscriptionWebhook({ ...payload, orderReferenceCode: 'changed' }, signature))
      .toThrow(BillingValidationError);
  });

  it('initializes one-time AI credits and verifies the retrieved payment signature', async () => {
    vi.stubEnv('APP_URL', 'https://app.example.com');
    const resultBody = {
      status: 'success', paymentStatus: 'SUCCESS', fraudStatus: 1, paymentId: 'payment-1', currency: 'TRY',
      basketId: 'AI-org_test-1000', conversationId: 'credit_test', paidPrice: 199, price: 199, token: 'credit-token'
    };
    const signatureMessage = [resultBody.paymentStatus, resultBody.paymentId, resultBody.currency, resultBody.basketId, resultBody.conversationId, resultBody.paidPrice, resultBody.price, resultBody.token].join('');
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'success', token: 'credit-token', checkoutFormContent: '<script>safe()</script>', tokenExpireTime: 1800, conversationId: 'credit_test' }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...resultBody, signature: createHmac('sha256', configuration.secretKey).update(signatureMessage).digest('hex') }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const provider = createIyzicoBillingProvider({ ...configuration, fetchImpl });
    const customer = {
      name: 'Ada', surname: 'Lovelace', email: 'ada@example.com', gsmNumber: '+905551112233', identityNumber: '11111111111',
      billingAddress: { address: 'Test Caddesi 1', contactName: 'Ada Lovelace', city: 'Istanbul', country: 'Turkiye' }
    };
    const initialized = await provider.initializeAiCreditCheckout({ quantity: 1000, amountMinor: 19900, callbackUrl: 'https://app.example.com/api/saas/billing/ai-credit-callback', conversationId: 'credit_test', organizationId: 'org_test', buyerIp: '127.0.0.1', customer });
    expect(initialized.token).toBe('credit-token');
    const verified = await provider.retrieveAiCreditCheckoutResult({ token: initialized.token, conversationId: 'credit_test' });
    expect(verified).toMatchObject({ paymentId: 'payment-1', priceMinor: 19900, paidPriceMinor: 19900, basketId: 'AI-org_test-1000' });
  });
});
