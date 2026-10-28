import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store';
import { canClick, type CheckoutState } from '../checkout-machine';

const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });

function useServerNow(offset: number) {
  const [now, setNow] = useState(() => Date.now() + offset);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now() + offset), 250);
    return () => clearInterval(t);
  }, [offset]);
  return now;
}

function pad(n: number) {
  return String(n).padStart(2, '0');
}

function Countdown({ ms }: { ms: number }) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const parts = [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60];
  return (
    <div className="countdown" role="timer" aria-label="Time until the sale starts">
      {parts.map((p, i) => (
        <div key={i} className="cd-cell">
          <span className="cd-num">{pad(p)}</span>
          <span className="cd-label">{['hours', 'min', 'sec'][i]}</span>
        </div>
      ))}
    </div>
  );
}

function buttonLabel(c: CheckoutState, live: boolean, price: string, opensAt: string) {
  switch (c.phase) {
    case 'submitting': return 'Placing order…';
    case 'queued': return 'Confirming…';
    case 'confirmed': return 'Order confirmed';
    case 'sold_out': return 'Sold out';
    case 'already_purchased': return 'Already ordered';
    case 'failed':
    case 'rate_limited':
    case 'not_started': return live ? 'Try again' : 'Not started yet';
    default: return live ? `Buy now · ${price}` : `Opens at ${opensAt}`;
  }
}

function StatusLine({ c }: { c: CheckoutState }) {
  const id = c.orderId ? <code className="order-id">{c.orderId.slice(0, 8)}</code> : null;
  switch (c.phase) {
    case 'submitting':
      return <p className="status">Sending your order…</p>;
    case 'queued':
      return <p className="status ok">A unit is reserved for you. Confirming your order {id}…</p>;
    case 'confirmed':
      return <p className="status ok">Done. Your order {id} is confirmed.</p>;
    case 'sold_out':
      return <p className="status bad">Sorry, all units are sold.</p>;
    case 'already_purchased':
      return <p className="status">You already have an order in this sale {id}. One per customer.</p>;
    case 'rate_limited':
      return <p className="status bad">Too many attempts. Wait a few seconds, then try again.</p>;
    case 'not_started':
      return <p className="status bad">The sale hasn't started yet.</p>;
    case 'failed':
      return <p className="status bad">{c.message ?? 'Something went wrong.'} Your place is safe to retry.</p>;
    default:
      return null;
  }
}

export function Storefront() {
  const sale = useStore((s) => s.sale);
  const offset = useStore((s) => s.clockOffset);
  const feed = useStore((s) => s.feed);
  const c = useStore((s) => s.checkout);
  const buy = useStore((s) => s.buy);
  const now = useServerNow(offset);
  // A ref flips synchronously, so even two clicks inside the same frame send one request.
  const inFlight = useRef(false);

  if (!sale) return <div className="pad muted">Loading sale…</div>;

  const live = now >= sale.startsAt && sale.remaining > 0;
  const soldOut = now >= sale.startsAt && sale.remaining <= 0;
  const price = inr.format(sale.product.priceInr);
  const sold = sale.totalStock - sale.remaining;
  const pct = sale.totalStock ? (sale.remaining / sale.totalStock) * 100 : 0;
  const disabled = !live || !canClick(c);
  const startsAt = new Date(sale.startsAt);
  const opensAt = startsAt.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });

  const onBuy = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      await buy();
    } finally {
      inFlight.current = false;
    }
  };

  const saleDate = startsAt.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });

  return (
    <>
      <nav className="crumbs" aria-label="Breadcrumb">
        <span>Electronics</span><span>Mobiles</span><span>{sale.product.name}</span>
      </nav>
      <section className="store">
        <div className="product-media">
          <img src="/phone.webp" alt="Shak-V1 phone, back view" width={360} height={640} fetchPriority="high" />
        </div>

        <div className="product-info">
          <h1>{sale.product.name} (256 GB, 6.7" display, 5G)</h1>
          <p className="brand-line"><a href="/">Visit the flash store</a></p>
          <hr className="rule" />
          <span className="deal">Festival flash sale</span>
          <p className="price">{price}</p>
          <p className="tax">Inclusive of all taxes. {sale.totalStock} units only, {saleDate} at {opensAt}.</p>
          <hr className="rule" />

          {now < sale.startsAt && (
            <>
              <p className="label">Sale starts in</p>
              <Countdown ms={sale.startsAt - now} />
              <hr className="rule" />
            </>
          )}

          <div className="about">
            <h2>About this item</h2>
            <ul>
              <li>256 GB storage with a 6.7-inch display and 5G.</li>
              <li>Modular metal back with replaceable panels, held by screws you can open yourself.</li>
              <li>Limited flash sale: one unit per customer, while stock lasts.</li>
              <li>Free delivery in 3 to 5 days and 7-day replacement.</li>
            </ul>
          </div>
        </div>

        <div className="buybox-col">
          <div className="buybox">
            <p className="price">{price}</p>
            <p className="delivery">FREE delivery in <b>3–5 days</b></p>

            {now < sale.startsAt ? (
              <p className="in-stock">Available from {opensAt}</p>
            ) : (
              <div className="stock">
                <div className="stock-row">
                  <span className={soldOut ? 'out-stock' : 'in-stock'}>{soldOut ? 'Sold out' : 'In stock'}</span>
                  <span className="stock-count">
                    <b>{sale.remaining}</b> / {sale.totalStock}
                  </span>
                </div>
                <div className="bar" aria-hidden>
                  <div className="bar-fill" style={{ width: `${pct}%` }} />
                </div>
                <p className="label">{soldOut ? 'Sold out' : 'Units left'} · {sold} sold</p>
              </div>
            )}

            <button
              className={`buy ${c.phase === 'confirmed' ? 'done' : ''}`}
              onClick={onBuy}
              disabled={disabled}
              aria-busy={c.phase === 'submitting' || c.phase === 'queued'}
            >
              {soldOut && c.phase === 'idle' ? 'Sold out' : buttonLabel(c, live, price, opensAt)}
            </button>

            <div aria-live="polite">
              <StatusLine c={c} />
            </div>

            <ul className="facts">
              <li><span>Ships from</span><span>flash</span></li>
              <li><span>Sold by</span><span>flash</span></li>
              <li><span>Limit</span><span>One per customer</span></li>
              <li><span>Returns</span><span>7-day replacement</span></li>
            </ul>

            <p className="feed muted small">
              <span className={`dot ${feed === 'live' ? 'on' : ''}`} /> {feed === 'live' ? 'Live updates' : feed === 'polling' ? 'Updating every few seconds' : 'Connecting…'}
            </p>
          </div>
        </div>
      </section>
    </>
  );
}
