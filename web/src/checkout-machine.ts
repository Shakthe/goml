// The buy button is driven by this small state machine. Keeping it pure makes the
// rules easy to test: once a request is in flight, further clicks do nothing.

export type CheckoutPhase =
  | 'idle'
  | 'submitting'
  | 'queued'
  | 'confirmed'
  | 'sold_out'
  | 'already_purchased'
  | 'rate_limited'
  | 'not_started'
  | 'failed';

export interface CheckoutState {
  phase: CheckoutPhase;
  orderId?: string;
  idempotencyKey?: string;
  message?: string;
}

export type CheckoutEvent =
  | { type: 'CLICK'; idempotencyKey: string }
  | { type: 'RESPONSE'; status: number; body: Record<string, unknown> }
  | { type: 'NETWORK_ERROR' }
  | { type: 'ORDER_STATUS'; status: string }
  | { type: 'RESET' };

export const initialCheckout: CheckoutState = { phase: 'idle' };

const RETRYABLE: CheckoutPhase[] = ['idle', 'failed', 'rate_limited', 'not_started'];

export function canClick(state: CheckoutState): boolean {
  return RETRYABLE.includes(state.phase);
}

export function checkoutReducer(state: CheckoutState, event: CheckoutEvent): CheckoutState {
  switch (event.type) {
    case 'CLICK':
      if (!canClick(state)) return state;
      // A retry after a failure reuses the same key, so the server can never create two orders.
      return { phase: 'submitting', idempotencyKey: state.idempotencyKey ?? event.idempotencyKey };

    case 'RESPONSE': {
      if (state.phase !== 'submitting') return state;
      const { status, body } = event;
      const orderId = typeof body.orderId === 'string' ? body.orderId : undefined;
      if (status === 202) return { ...state, phase: 'queued', orderId };
      if (status === 200 && body.status === 'CONFIRMED') return { ...state, phase: 'confirmed', orderId };
      if (status === 409 && body.code === 'SOLD_OUT') return { phase: 'sold_out' };
      if (status === 409 && body.code === 'ALREADY_PURCHASED') return { phase: 'already_purchased', orderId };
      if (status === 425) return { ...state, phase: 'not_started' };
      if (status === 429) return { ...state, phase: 'rate_limited' };
      return { ...state, phase: 'failed', message: typeof body.message === 'string' ? body.message : undefined };
    }

    case 'NETWORK_ERROR':
      return state.phase === 'submitting' ? { ...state, phase: 'failed' } : state;

    case 'ORDER_STATUS':
      if (state.phase !== 'queued' && state.phase !== 'already_purchased') return state;
      if (event.status === 'CONFIRMED') return { ...state, phase: 'confirmed' };
      if (event.status === 'FAILED') return { phase: 'sold_out' };
      return state;

    case 'RESET':
      return initialCheckout;
  }
}
