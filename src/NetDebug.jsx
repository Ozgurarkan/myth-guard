// A tiny network read-out for both pages. Hidden until Ctrl+Shift+D; a second press hides it again (design 4.12).
import React, { useEffect, useState } from 'react';

const fmt = value => (value === null || value === undefined ? '-' : typeof value === 'number' ? String(Math.round(value * 10) / 10) : String(value));

/**
 * @param {() => object|null} read   getGMNetStats / getPlayerNetStats
 * @param {string} [status]          the page's connection status word
 * @param {Record<string, any>} [extra]  more lines, e.g. { 'audio underruns': 2 }
 */
export function NetDebug({ read, status, extra }) {
  const [shown, setShown] = useState(false);
  const [stats, setStats] = useState(null);

  useEffect(() => {
    const onKey = event => {
      if (event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey && (event.key === 'D' || event.key === 'd')) {
        event.preventDefault();
        setShown(value => !value);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (!shown) return undefined;
    const tick = () => { try { setStats(read?.() ?? null); } catch { setStats(null); } };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [shown, read]);

  if (!shown) return null;
  const rows = [
    ['status', status],
    ['rtt ms (last / p50 / p95)', stats ? `${fmt(stats.rtt?.last)} / ${fmt(stats.rtt?.p50)} / ${fmt(stats.rtt?.p95)}` : '-'],
    ['loss %', stats?.loss],
    ['reconnects', stats?.reconnects],
    ['up s', stats?.sinceMs == null ? null : Math.round(stats.sinceMs / 1000)],
    ['in / out kB', stats ? `${fmt((stats.bytesIn ?? 0) / 1024)} / ${fmt((stats.bytesOut ?? 0) / 1024)}` : '-'],
    ['patches / fulls', stats ? `${fmt(stats.patches)} / ${fmt(stats.fulls)}` : '-'],
    ['divergence', stats?.divergence],
    ['last close', stats?.lastClose ? `${stats.lastClose.code}${stats.lastClose.reason ? ` ${stats.lastClose.reason}` : ''}` : null],
    ...Object.entries(extra ?? {}),
  ];
  return (
    <aside className="net-debug" aria-label="Network debug (Ctrl+Shift+D to hide)">
      <dl>
        {rows.map(([label, value]) => <React.Fragment key={label}><dt>{label}</dt><dd>{fmt(value)}</dd></React.Fragment>)}
      </dl>
    </aside>
  );
}
