import { describe, expect, it } from 'vitest';
import { eventToEntitlement, verifyStripeWebhook } from './billing';

describe('Stripe helpers', () => {
  it('maps subscription status without touching persistence', () => {
    expect(
      eventToEntitlement({
        id: 'evt_1',
        type: 'customer.subscription.updated',
        data: {
          object: {
            id: 'sub_1',
            customer: 'cus_1',
            status: 'active',
            current_period_end: 1_800_000_000,
          },
        },
      }),
    ).toMatchObject({ customerId: 'cus_1', plan: 'personal', active: true });
  });

  it('validates the raw body signature', async () => {
    const body = '{"id":"evt_1"}';
    const timestamp = Math.floor(Date.now() / 1000);
    const secret = 'whsec_test';
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const signed = await crypto.subtle.sign(
      'HMAC',
      key,
      new TextEncoder().encode(`${timestamp}.${body}`),
    );
    const signature = [...new Uint8Array(signed)]
      .map((value) => value.toString(16).padStart(2, '0'))
      .join('');
    await expect(
      verifyStripeWebhook(body, `t=${timestamp},v1=${signature}`, secret),
    ).resolves.toMatchObject({ id: 'evt_1' });
    await expect(
      verifyStripeWebhook(`${body} `, `t=${timestamp},v1=${signature}`, secret),
    ).rejects.toThrow();
  });
});
