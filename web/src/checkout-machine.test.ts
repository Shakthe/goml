import { describe, expect, it } from 'vitest';
import { canClick, checkoutReducer, initialCheckout, type CheckoutState } from './checkout-machine';

const click = (s: CheckoutState, key = 'key-aaaaaaaa') => checkoutReducer(s, { type: 'CLICK', idempotencyKey: key });
const respond = (s: CheckoutState, status: number, body: Record<string, unknown> = {}) =>
  checkoutReducer(s, { type: 'RESPONSE', status, body });

describe('checkout state machine', () => {
  it('locks after the first click so repeat clicks do nothing', () => {
    const first = click(initialCheckout, 'key-first1');
    expect(first.phase).toBe('submitting');
    expect(canClick(first)).toBe(false);
    const second = click(first, 'key-second');
    expect(second).toBe(first);
  });

  it('moves to queued on 202 and to confirmed when the worker finishes', () => {
    const queued = respond(click(initialCheckout), 202, { orderId: 'o-1' });
    expect(queued).toMatchObject({ phase: 'queued', orderId: 'o-1' });
    expect(canClick(queued)).toBe(false);
    expect(checkoutReducer(queued, { type: 'ORDER_STATUS', status: 'PENDING' }).phase).toBe('queued');
    expect(checkoutReducer(queued, { type: 'ORDER_STATUS', status: 'CONFIRMED' }).phase).toBe('confirmed');
  });

  it('maps sold out, already purchased, too early and rate limited', () => {
    const s = click(initialCheckout);
    expect(respond(s, 409, { code: 'SOLD_OUT' }).phase).toBe('sold_out');
    expect(respond(s, 409, { code: 'ALREADY_PURCHASED', orderId: 'o-9' })).toMatchObject({ phase: 'already_purchased', orderId: 'o-9' });
    expect(respond(s, 425).phase).toBe('not_started');
    expect(respond(s, 429).phase).toBe('rate_limited');
  });

  it('reuses the same idempotency key when retrying after a failure', () => {
    const failed = respond(click(initialCheckout, 'key-original'), 503, { message: 'busy' });
    expect(failed.phase).toBe('failed');
    expect(canClick(failed)).toBe(true);
    const retry = click(failed, 'key-brandnew');
    expect(retry.idempotencyKey).toBe('key-original');
  });

  it('treats a network error during submit as a retryable failure', () => {
    const failed = checkoutReducer(click(initialCheckout), { type: 'NETWORK_ERROR' });
    expect(failed.phase).toBe('failed');
    expect(canClick(failed)).toBe(true);
  });

  it('does not allow buying again after a terminal result', () => {
    for (const s of [
      respond(click(initialCheckout), 409, { code: 'SOLD_OUT' }),
      respond(click(initialCheckout), 200, { status: 'CONFIRMED', orderId: 'x' }),
    ]) {
      expect(canClick(s)).toBe(false);
    }
  });
});
