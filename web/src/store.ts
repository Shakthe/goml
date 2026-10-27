import { create } from 'zustand';
import { checkout, fetchOrder, fetchSale, getSession, newIdempotencyKey, type SaleView, type Session } from './api';
import { checkoutReducer, initialCheckout, type CheckoutEvent, type CheckoutState } from './checkout-machine';

interface Store {
  session: Session | null;
  sale: SaleView | null;
  clockOffset: number; // serverTime - local time, so the countdown ignores a wrong device clock
  feed: 'connecting' | 'live' | 'polling';
  checkout: CheckoutState;
  dispatch: (e: CheckoutEvent) => void;
  setSale: (s: SaleView, offset?: number) => void;
  setFeed: (f: Store['feed']) => void;
  init: () => Promise<void>;
  buy: () => Promise<void>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const useStore = create<Store>((set, get) => ({
  session: null,
  sale: null,
  clockOffset: 0,
  feed: 'connecting',
  checkout: initialCheckout,

  dispatch: (e) => set((s) => ({ checkout: checkoutReducer(s.checkout, e) })),
  setSale: (sale, offset) =>
    set((s) => ({
      sale,
      clockOffset: offset ?? s.clockOffset,
      // A new sale was started (admin reset): the buy button starts fresh.
      checkout: s.sale && s.sale.saleId !== sale.saleId ? initialCheckout : s.checkout,
    })),
  setFeed: (feed) => set({ feed }),

  init: async () => {
    const started = Date.now();
    const [session, res] = await Promise.all([getSession(), fetchSale()]);
    const rtt = Date.now() - started;
    const offset = res.body.serverTime + rtt / 2 - Date.now();
    set({ session });
    get().setSale(res.body, offset);
  },

  buy: async () => {
    const { session, checkout: before, dispatch } = get();
    if (!session) return;
    dispatch({ type: 'CLICK', idempotencyKey: newIdempotencyKey() });
    const after = get().checkout;
    if (after === before || after.phase !== 'submitting') return; // click ignored: already in flight

    try {
      const res = await checkout(session, after.idempotencyKey!);
      dispatch({ type: 'RESPONSE', status: res.status, body: res.body });
    } catch {
      dispatch({ type: 'NETWORK_ERROR' });
      return;
    }
    const { phase, orderId } = get().checkout;
    if ((phase === 'queued' || phase === 'already_purchased') && orderId) void pollOrder(session, orderId);
  },
}));

// The checkout returns 202 straight away; the order is written by a worker.
// Poll its status with exponential backoff and jitter so thousands of browsers
// don't all hit the server on the same tick.
async function pollOrder(session: Session, orderId: string) {
  let delay = 400;
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    await sleep(delay + Math.random() * delay * 0.5);
    try {
      const res = await fetchOrder(session, orderId);
      if (res.status === 200) {
        useStore.getState().dispatch({ type: 'ORDER_STATUS', status: res.body.status });
        if (res.body.status !== 'PENDING') return;
      }
    } catch {
      // Network blip: keep polling.
    }
    delay = Math.min(delay * 2, 4000);
  }
}
