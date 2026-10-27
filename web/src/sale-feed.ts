import { fetchSale } from './api';
import { useStore } from './store';

// Live sale updates. Server-Sent Events first (one connection, server pushes only
// when something changes). If the stream keeps failing, fall back to polling.
export function startSaleFeed(): () => void {
  let es: EventSource | null = null;
  let failures = 0;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const poll = async () => {
    if (stopped) return;
    try {
      const res = await fetchSale();
      if (res.status === 200) useStore.getState().setSale(res.body);
    } catch {
      /* try again next tick */
    }
    pollTimer = setTimeout(poll, 2000 + Math.random() * 1000);
  };

  const startPolling = () => {
    useStore.getState().setFeed('polling');
    void poll();
  };

  if (typeof EventSource === 'undefined') {
    startPolling();
  } else {
    es = new EventSource('/api/sale/stream');
    es.addEventListener('sale', (e) => {
      failures = 0;
      useStore.getState().setFeed('live');
      useStore.getState().setSale(JSON.parse((e as MessageEvent).data));
    });
    es.onerror = () => {
      failures += 1;
      if (failures >= 3 && es) {
        es.close();
        es = null;
        startPolling();
      }
    };
  }

  return () => {
    stopped = true;
    es?.close();
    clearTimeout(pollTimer);
  };
}
