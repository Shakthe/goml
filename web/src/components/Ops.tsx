import { useEffect, useState } from 'react';

interface Stats {
  sale: { saleId: string; state: string; remaining: number; totalStock: number; strategy: string; startsAt: number };
  redisStock: number;
  dbStock: number | null;
  confirmedOrders: number;
  queue: { depth: number; consumers: number; deadLetters: number };
  responseCodes: Record<string, string>;
  requestsByInstance: Record<string, string>;
  ordersByWorker: Record<string, string>;
  series: { t: number; codes: Record<string, string> }[];
}

const CODE_COLORS: Record<string, string> = { '202': 'var(--ok)', '200': 'var(--ok)', '409': 'var(--grey)', '425': 'var(--amber)' };

function Tile({ label, value, tone }: { label: string; value: string | number; tone?: 'ok' | 'bad' }) {
  return (
    <div className={`tile ${tone ?? ''}`}>
      <span className="tile-label">{label}</span>
      <span className="tile-value">{value}</span>
    </div>
  );
}

function Breakdown({ title, data }: { title: string; data: Record<string, string> }) {
  const rows = Object.entries(data).sort((a, b) => a[0].localeCompare(b[0]));
  return (
    <div className="panel">
      <h3>{title}</h3>
      {rows.length === 0 ? <p className="muted small">Nothing yet.</p> : (
        <table className="kv">
          <tbody>
            {rows.map(([k, v]) => <tr key={k}><td>{k}</td><td>{Number(v).toLocaleString()}</td></tr>)}
          </tbody>
        </table>
      )}
    </div>
  );
}

function RpsChart({ series }: { series: Stats['series'] }) {
  const totals = series.map((p) => Object.values(p.codes).reduce((a, n) => a + Number(n), 0));
  const max = Math.max(1, ...totals);
  return (
    <div className="panel">
      <h3>Checkout requests per second (last 60 s) · peak {max.toLocaleString()}</h3>
      <svg viewBox="0 0 600 120" className="chart" preserveAspectRatio="none" role="img" aria-label="Requests per second">
        {series.map((p, i) => {
          let y = 120;
          return Object.entries(p.codes).sort().map(([code, n]) => {
            const h = (Number(n) / max) * 116;
            y -= h;
            return <rect key={`${i}-${code}`} x={i * 10 + 1} y={y} width={8} height={h} fill={CODE_COLORS[code] ?? 'var(--err)'} />;
          });
        })}
      </svg>
      <p className="muted small legend">
        <span className="sw" style={{ background: 'var(--ok)' }} /> accepted
        <span className="sw" style={{ background: 'var(--grey)' }} /> sold out / duplicate
        <span className="sw" style={{ background: 'var(--err)' }} /> errors
      </p>
    </div>
  );
}

function AdminForm({ onDone }: { onDone: () => void }) {
  const [token, setToken] = useState('');
  const [stock, setStock] = useState(500);
  const [startsIn, setStartsIn] = useState(30);
  const [strategy, setStrategy] = useState('queue');
  const [msg, setMsg] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setMsg('Starting…');
    const res = await fetch('/api/admin/sale', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Token': token },
      body: JSON.stringify({ stock, startsInSeconds: startsIn, strategy }),
    });
    const body = await res.json().catch(() => ({}));
    setMsg(res.ok ? `New sale ${body.saleId} starts in ${startsIn} s.` : `Failed (${res.status}): ${body.message ?? ''}`);
    onDone();
  };

  return (
    <form className="panel admin" onSubmit={submit}>
      <h3>Start a new sale</h3>
      <p className="muted small">Clears all orders and resets stock. Needs the admin token from your .env.</p>
      <label>Admin token<input type="password" value={token} onChange={(e) => setToken(e.target.value)} required /></label>
      <label>Units<input type="number" min={1} value={stock} onChange={(e) => setStock(Number(e.target.value))} /></label>
      <label>Starts in (seconds)<input type="number" min={0} value={startsIn} onChange={(e) => setStartsIn(Number(e.target.value))} /></label>
      <label>Checkout strategy
        <select value={strategy} onChange={(e) => setStrategy(e.target.value)}>
          <option value="queue">queue: Redis + RabbitMQ</option>
          <option value="naive">naive: the old bug</option>
          <option value="pessimistic">pessimistic: FOR UPDATE</option>
          <option value="optimistic">optimistic: version check</option>
        </select>
      </label>
      <button className="buy small" type="submit">Start sale</button>
      {msg && <p className="small">{msg}</p>}
    </form>
  );
}

export default function Ops() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState('');

  const load = async () => {
    try {
      const res = await fetch('/api/stats');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setStats(await res.json());
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  };

  useEffect(() => {
    void load();
    const t = setInterval(load, 1000);
    return () => clearInterval(t);
  }, []);

  if (!stats) return <p className="pad muted">{error ? `Could not load stats: ${error}` : 'Loading…'}</p>;
  const oversold = stats.confirmedOrders > stats.sale.totalStock;

  return (
    <section className="ops">
      <div className="ops-head">
        <h1>Ops</h1>
        <p className="muted">Sale {stats.sale.saleId} · {stats.sale.state} · strategy <b>{stats.sale.strategy}</b>{error && ` · last refresh failed: ${error}`}</p>
      </div>
      <div className="tiles">
        <Tile label="Units for sale" value={stats.sale.totalStock} />
        <Tile label="Redis stock" value={stats.redisStock} />
        <Tile label="Database stock" value={stats.dbStock ?? '-'} />
        <Tile label="Confirmed orders" value={stats.confirmedOrders} tone={oversold ? 'bad' : 'ok'} />
        <Tile label="Oversold" value={oversold ? `+${stats.confirmedOrders - stats.sale.totalStock}` : '0'} tone={oversold ? 'bad' : 'ok'} />
        <Tile label="Queue depth" value={stats.queue.depth} />
        <Tile label="Workers" value={stats.queue.consumers} />
        <Tile label="Dead letters" value={stats.queue.deadLetters} tone={stats.queue.deadLetters ? 'bad' : undefined} />
      </div>
      <RpsChart series={stats.series} />
      <div className="grid3">
        <Breakdown title="Checkout responses" data={stats.responseCodes} />
        <Breakdown title="Requests per API instance" data={stats.requestsByInstance} />
        <Breakdown title="Orders written per worker" data={stats.ordersByWorker} />
      </div>
      <AdminForm onDone={load} />
    </section>
  );
}
