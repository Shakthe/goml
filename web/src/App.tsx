import { lazy, Suspense, useEffect, useState } from 'react';
import { useStore } from './store';
import { startSaleFeed } from './sale-feed';
import { Storefront } from './components/Storefront';

// The ops page is split into its own chunk so shoppers never download it.
const loadOps = () => import('./components/Ops');
const Ops = lazy(loadOps);

export default function App() {
  const [path, setPath] = useState(window.location.pathname);
  const [error, setError] = useState<string | null>(null);
  const init = useStore((s) => s.init);

  useEffect(() => {
    init().catch((err: Error) => setError(err.message));
    const stop = startSaleFeed();
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener('popstate', onPop);
    return () => {
      stop();
      window.removeEventListener('popstate', onPop);
    };
  }, [init]);

  const go = (to: string) => (e: React.MouseEvent) => {
    e.preventDefault();
    window.history.pushState({}, '', to);
    setPath(to);
  };

  return (
    <>
      <header className="nav">
        <a href="/" onClick={go('/')} className="brand">
          <span className="brand-mark" aria-hidden /> flash
        </a>
        <nav>
          <a href="/" onClick={go('/')} className={path !== '/ops' ? 'active' : ''}>Store</a>
          <a href="/ops" onClick={go('/ops')} onMouseEnter={loadOps} onFocus={loadOps}
            className={path === '/ops' ? 'active' : ''}>Ops</a>
        </nav>
      </header>
      <main>
        {error && <div className="banner error">Could not reach the store: {error}. Refresh to try again.</div>}
        {path === '/ops' ? (
          <Suspense fallback={<p className="muted pad">Loading…</p>}>
            <Ops />
          </Suspense>
        ) : (
          <Storefront />
        )}
      </main>
      <footer className="foot">
        <span>Prices include GST. One unit per customer.</span>
      </footer>
    </>
  );
}
