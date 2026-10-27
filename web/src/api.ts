export interface SaleView {
  saleId: string;
  product: { id: string; name: string; priceInr: number };
  startsAt: number;
  serverTime: number;
  totalStock: number;
  remaining: number;
  state: 'upcoming' | 'live' | 'sold_out';
  strategy: string;
}

export interface ApiResult<T = Record<string, unknown>> {
  status: number;
  body: T;
}

const SESSION_KEY = 'flash.session';

export interface Session {
  userId: string;
  token: string;
}

function readStoredSession(): Session | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

// Each browser gets an anonymous guest session. Stored locally so a refresh keeps the same buyer.
export async function getSession(): Promise<Session> {
  const stored = readStoredSession();
  if (stored) return stored;
  const res = await fetch('/api/session', { method: 'POST' });
  if (!res.ok) throw new Error(`Could not start a session (${res.status})`);
  const session = (await res.json()) as Session;
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } catch {
    // Private mode: the session lives only for this page load, which is fine.
  }
  return session;
}

export function clearSession() {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
    /* nothing stored */
  }
}

async function call<T = Record<string, unknown>>(path: string, init: RequestInit = {}): Promise<ApiResult<T>> {
  const res = await fetch(path, init);
  let body: unknown = {};
  try {
    body = await res.json();
  } catch {
    body = {};
  }
  return { status: res.status, body: body as T };
}

export function fetchSale() {
  return call<SaleView>('/api/sale');
}

export function checkout(session: Session, idempotencyKey: string) {
  return call('/api/checkout', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${session.token}`,
      'Idempotency-Key': idempotencyKey,
      'Content-Type': 'application/json',
    },
    body: '{}',
  });
}

export function fetchOrder(session: Session, orderId: string) {
  return call<{ orderId: string; status: string; reason?: string }>(`/api/orders/${orderId}`, {
    headers: { Authorization: `Bearer ${session.token}` },
  });
}

export function newIdempotencyKey(): string {
  return crypto.randomUUID().replace(/-/g, '');
}
