// The session plan: a full page of the GM's own writing, like a word processor. Many pages (one per session),
// autosaved to this browser only. Nothing here is ever sent to players.
import React, { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { IconButton, Icon, ask, toast } from '../../ui';
import { listPlans, savePlan, deletePlan, TEMPLATES, htmlToText, countWords, toHtmlDocument, downloadFile, exportName } from './plans';
import '../../styles/planner.css';

const PlannerEditor = lazy(() => import('./PlannerEditor'));
const LAST_KEY = 'realm-plan-active';
const remember = id => { try { localStorage.setItem(LAST_KEY, String(id)); } catch { /* optional */ } };
const recalled = () => { try { return Number(localStorage.getItem(LAST_KEY)) || null; } catch { return null; } };
const shortDate = ms => new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

/** A small drop-down that closes itself after a choice. */
function Menu({ icon, label, children, align = 'left' }) {
  const ref = useRef(null);
  const close = () => ref.current?.removeAttribute('open');
  useEffect(() => {
    const away = event => { if (ref.current?.open && !ref.current.contains(event.target)) close(); };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, []);
  return (
    <details className="planner-menu" ref={ref}>
      <summary className="btn btn--secondary btn--sm"><Icon name={icon} size={16} /><span className="btn__label">{label}</span></summary>
      <div className={`planner-menu__list is-${align}`} role="menu" onClick={close}>{children}</div>
    </details>
  );
}

export default function SessionPlanner({ onClose }) {
  const [plans, setPlans] = useState(null);          // null while loading
  const [activeId, setActiveId] = useState(null);
  const [status, setStatus] = useState('saved');     // saved | saving | error
  const [search, setSearch] = useState('');
  const [sideOpen, setSideOpen] = useState(() => window.innerWidth > 900);
  const latest = useRef(null);                       // the open page as last edited
  const pending = useRef(null);                      // an edited page waiting to be written
  const timer = useRef(null);

  const flush = useCallback(async () => {
    clearTimeout(timer.current);
    const record = pending.current;
    if (!record) return;
    pending.current = null;
    setStatus('saving');
    try {
      await savePlan(record);
      setStatus(pending.current ? 'saving' : 'saved');
    } catch {
      setStatus('error');
      toast('The page could not be saved in this browser.', { tone: 'danger' });
    }
  }, []);

  // Open the planner: load the pages, and start a first one from the outline if there are none.
  useEffect(() => {
    let live = true;
    (async () => {
      let list = await listPlans().catch(() => []);
      if (!list.length) {
        const outline = TEMPLATES[1];
        const record = { title: 'Session 1', html: outline.html, text: htmlToText(outline.html), createdAt: Date.now() };
        const id = await savePlan(record);
        list = [{ ...record, id, updatedAt: Date.now() }];
      }
      if (!live) return;
      const open = list.find(plan => plan.id === recalled()) ?? list[0];
      latest.current = open;
      setPlans(list);
      setActiveId(open.id);
    })();
    return () => { live = false; };
  }, []);

  // Never lose words: save when the page is left, hidden or closed.
  useEffect(() => {
    const leave = () => { flush(); };
    window.addEventListener('pagehide', leave);
    return () => { window.removeEventListener('pagehide', leave); flush(); };
  }, [flush]);

  const active = plans?.find(plan => plan.id === activeId) ?? null;

  const edit = useCallback(patch => {
    if (!latest.current) return;
    const next = { ...latest.current, ...patch, updatedAt: Date.now() };
    latest.current = next;
    pending.current = next;
    setPlans(list => list.map(plan => (plan.id === next.id ? next : plan)));
    setStatus('saving');
    clearTimeout(timer.current);
    timer.current = setTimeout(flush, 700);
  }, [flush]);

  const openPage = async id => {
    if (id === activeId) return;
    await flush();
    const next = plans.find(plan => plan.id === id);
    if (!next) return;
    latest.current = next;
    remember(id);
    setActiveId(id);
    if (window.innerWidth <= 900) setSideOpen(false);
  };

  const addPage = async template => {
    await flush();
    const number = (plans?.length ?? 0) + 1;
    const record = { title: `Session ${number}`, html: template.html, text: htmlToText(template.html), createdAt: Date.now() };
    const id = await savePlan(record);
    const created = { ...record, id, updatedAt: Date.now() };
    latest.current = created;
    remember(id);
    setPlans(list => [created, ...(list ?? [])]);
    setActiveId(id);
    if (window.innerWidth <= 900) setSideOpen(false);
  };

  const duplicate = async () => {
    if (!active) return;
    await flush();
    const record = { title: `${active.title || 'Untitled'} (copy)`, html: active.html, text: active.text, createdAt: Date.now() };
    const id = await savePlan(record);
    const created = { ...record, id, updatedAt: Date.now() };
    latest.current = created;
    remember(id);
    setPlans(list => [created, ...list]);
    setActiveId(id);
  };

  const remove = async () => {
    if (!active) return;
    if (!(await ask({ title: 'Delete this page?', message: `“${active.title || 'Untitled'}” will be removed for good.`, confirmLabel: 'Delete', danger: true }))) return;
    clearTimeout(timer.current);
    pending.current = null;
    await deletePlan(active.id);
    const rest = plans.filter(plan => plan.id !== active.id);
    if (!rest.length) { setPlans(rest); await addPage(TEMPLATES[0]); return; }
    latest.current = rest[0];
    remember(rest[0].id);
    setPlans(rest);
    setActiveId(rest[0].id);
    setStatus('saved');
  };

  const close = async () => { await flush(); onClose(); };
  const onKeyDown = event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault(); event.stopPropagation();
      flush().then(() => toast('Page saved.', { tone: 'success' }));
      return;
    }
    if (event.key === 'Escape' && !document.querySelector('.modal-overlay')) { event.stopPropagation(); close(); }
  };

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (plans ?? []).filter(plan => !q || (plan.title || '').toLowerCase().includes(q) || (plan.text || '').toLowerCase().includes(q));
  }, [plans, search]);
  const words = active ? countWords(active.text || '') : 0;

  return createPortal(
    <div className="planner" role="dialog" aria-label="Session plan" onKeyDown={onKeyDown}>
      <aside className={`planner__side${sideOpen ? ' is-open' : ''}`} aria-label="Plan pages">
        <div className="planner__side-head">
          <h2>Session plans</h2>
          <Menu icon="file-plus" label="New page" align="right">
            {TEMPLATES.map(template => (
              <button type="button" role="menuitem" key={template.id} onClick={() => addPage(template)}>
                <strong>{template.label}</strong><span>{template.hint}</span>
              </button>
            ))}
          </Menu>
        </div>
        <label className="planner__search">
          <Icon name="search" size={15} />
          <input type="search" value={search} placeholder="Search your pages…" aria-label="Search pages" onChange={event => setSearch(event.target.value)} />
        </label>
        <ul className="planner__pages">
          {shown.map(plan => (
            <li key={plan.id}>
              <button type="button" className={`planner__page${plan.id === activeId ? ' is-active' : ''}`} aria-current={plan.id === activeId ? 'page' : undefined} onClick={() => openPage(plan.id)}>
                <strong>{plan.title || 'Untitled page'}</strong>
                <span>{shortDate(plan.updatedAt || plan.createdAt)} · {countWords(plan.text || '')} words</span>
              </button>
            </li>
          ))}
          {plans && !shown.length && <li className="planner__none">No page matches “{search}”.</li>}
        </ul>
        <p className="planner__private"><Icon name="lock" size={13} /> Private to you. Players never see your plans.</p>
      </aside>

      <section className="planner__main">
        <header className="planner__bar">
          <IconButton icon="panel-left" label={sideOpen ? 'Hide the page list' : 'Show the page list'} variant="ghost" onClick={() => setSideOpen(open => !open)} />
          <input className="planner__title" value={active?.title ?? ''} placeholder="Untitled page" aria-label="Page title" maxLength={120} disabled={!active}
            onChange={event => edit({ title: event.target.value })} />
          <span className={`planner__status is-${status}`} role="status" aria-live="polite">
            {status === 'saving' ? 'Saving…' : status === 'error' ? 'Not saved' : 'Saved'}
          </span>
          <Menu icon="download" label="Export" align="right">
            <button type="button" role="menuitem" onClick={() => window.print()}><strong>Print or save as PDF</strong><span>Opens your browser’s print window.</span></button>
            <button type="button" role="menuitem" onClick={() => active && downloadFile(exportName(active, 'html'), toHtmlDocument(active), 'text/html')}><strong>Web page (.html)</strong><span>Opens in any browser or word processor.</span></button>
            <button type="button" role="menuitem" onClick={() => active && downloadFile(exportName(active, 'txt'), `${active.title || 'Session plan'}\n\n${htmlToText(active.html)}\n`, 'text/plain')}><strong>Plain text (.txt)</strong><span>Just the words.</span></button>
          </Menu>
          <IconButton icon="copy" label="Duplicate this page" variant="ghost" onClick={duplicate} disabled={!active} />
          <IconButton icon="trash" label="Delete this page" variant="ghost" onClick={remove} disabled={!active} />
          <IconButton icon="x" label="Close the session plan (Esc)" variant="ghost" onClick={close} />
        </header>

        {!plans && <div className="planner__loading" role="status">Opening your plans…</div>}
        {active && (
          <Suspense fallback={<div className="planner__loading" role="status">Opening the editor…</div>}>
            <h1 className="planner__print-title">{active.title}</h1>
            <PlannerEditor key={active.id} content={active.html} autoFocus={!active.text} onChange={html => edit({ html, text: htmlToText(html) })} />
          </Suspense>
        )}
        <footer className="planner__foot">{words} {words === 1 ? 'word' : 'words'}</footer>
      </section>
    </div>,
    document.body,
  );
}
