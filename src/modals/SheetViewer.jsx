/**
 * SheetViewer — the character-sheet quick-switcher.
 *
 * Every open sheet keeps its own <iframe> mounted; switching just flips which
 * one is visible, so the PDF never reloads and each sheet keeps its own scroll
 * position and zoom. Mid-combat you press a number key and the next
 * character's sheet is already on screen.
 *
 * Docked mode sits beside the map (drag its left edge to resize); full mode
 * takes the window. Nothing here is ever sent to the players.
 */
import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useGM } from '../store';
import { sheetUrl } from '../sheets';
import { Button, IconButton, Icon } from '../ui';

const MIN_DOCK = 360;
/** Rail + side panel + a usable slice of map must still fit */
const RESERVED = 820;

export default function SheetViewer() {
  const { state, dispatch } = useGM();
  const { sheetTabs, activeSheetId, sheetLayout } = state;
  const [urls, setUrls] = useState({});
  const resizing = useRef(false);
  const [maxDock, setMaxDock] = useState(Math.max(MIN_DOCK, window.innerWidth - RESERVED));

  useEffect(() => {
    let alive = true;
    (async () => {
      const next = {};
      for (const tab of sheetTabs) {
        const url = await sheetUrl(tab.id);
        if (url) next[tab.id] = url;
      }
      if (alive) setUrls(next);
    })();
    return () => { alive = false; };
  }, [sheetTabs]);

  useEffect(() => {
    const onResize = () => setMaxDock(Math.max(MIN_DOCK, window.innerWidth - RESERVED));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    if (state.sheetDockWidth > maxDock) dispatch({ type: 'SHEETS_SET_DOCK_WIDTH', width: maxDock });
  }, [maxDock, state.sheetDockWidth, dispatch]);

  useEffect(() => {
    const onMove = event => {
      if (!resizing.current) return;
      dispatch({ type: 'SHEETS_SET_DOCK_WIDTH', width: Math.max(MIN_DOCK, Math.min(maxDock, window.innerWidth - event.clientX)) });
    };
    const onUp = () => {
      if (!resizing.current) return;
      resizing.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => { window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp); };
  }, [dispatch, maxDock]);

  const step = useCallback(delta => {
    if (sheetTabs.length < 2) return;
    const index = sheetTabs.findIndex(tab => tab.id === activeSheetId);
    dispatch({ type: 'SHEET_SET_ACTIVE', id: sheetTabs[(index + delta + sheetTabs.length) % sheetTabs.length].id });
  }, [sheetTabs, activeSheetId, dispatch]);

  // 1–9 pick a sheet, ← → step, Esc hides
  useEffect(() => {
    const handler = event => {
      const tag = event.target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || document.querySelector('.modal-overlay')) return;
      if (event.key === 'Escape') { dispatch({ type: 'SHEETS_HIDE' }); return; }
      if (event.key === 'ArrowRight') { step(1); event.preventDefault(); return; }
      if (event.key === 'ArrowLeft') { step(-1); event.preventDefault(); return; }
      if (/^[1-9]$/.test(event.key)) {
        const tab = sheetTabs[Number(event.key) - 1];
        if (tab) { dispatch({ type: 'SHEET_SET_ACTIVE', id: tab.id }); event.preventDefault(); }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [sheetTabs, dispatch, step]);

  const isFull = sheetLayout === 'full';
  const active = sheetTabs.find(tab => tab.id === activeSheetId) ?? sheetTabs[0];

  return (
    <section className={`sheet-viewer${isFull ? ' full' : ''}`} aria-label="Character sheets">
      {!isFull && (
        <div className="sheet-resize" title="Drag to resize" role="separator" aria-orientation="vertical"
          onPointerDown={event => { event.preventDefault(); resizing.current = true; document.body.style.cursor = 'col-resize'; document.body.style.userSelect = 'none'; }} />
      )}

      <div className="sheet-tabs">
        {sheetTabs.map((tab, index) => (
          <button type="button" key={tab.id} className={`sheet-tab${tab.id === activeSheetId ? ' is-active' : ''}`} aria-pressed={tab.id === activeSheetId}
            title={`${tab.name}${index < 9 ? `  ·  press ${index + 1}` : ''}`} onClick={() => dispatch({ type: 'SHEET_SET_ACTIVE', id: tab.id })}>
            {index < 9 && <kbd className="key">{index + 1}</kbd>}
            <span className="sheet-tab__name">{tab.name}</span>
            <span role="button" tabIndex={0} className="sheet-tab__x" aria-label={`Close ${tab.name}`}
              onClick={event => { event.stopPropagation(); dispatch({ type: 'SHEET_CLOSE_TAB', id: tab.id }); }}
              onKeyDown={event => { if (event.key === 'Enter') { event.stopPropagation(); dispatch({ type: 'SHEET_CLOSE_TAB', id: tab.id }); } }}><Icon name="x" size={12} /></span>
          </button>
        ))}
        <span className="sheet-tabs__spacer" />
        <Button size="sm" icon="plus" title="Open the sheet library" onClick={() => { if (isFull) dispatch({ type: 'SHEETS_SET_LAYOUT', layout: 'dock' }); dispatch({ type: 'TAB_SET', tab: 'sheets' }); }}>Sheets</Button>
        {active && urls[active.id] && (
          <IconButton icon="external-link" size="sm" variant="secondary" label="Pop out into its own window (handy on a second monitor)"
            onClick={() => window.open(urls[active.id], `sheet-${active.id}`, 'width=900,height=1100')} />
        )}
        <IconButton icon={isFull ? 'panel-right' : 'maximize'} size="sm" variant="secondary" label={isFull ? 'Dock beside the map' : 'Fill the window'}
          onClick={() => dispatch({ type: 'SHEETS_SET_LAYOUT', layout: isFull ? 'dock' : 'full' })} />
        <IconButton icon="x" size="sm" variant="secondary" label="Hide the viewer (Esc) — open sheets stay open" onClick={() => dispatch({ type: 'SHEETS_HIDE' })} />
      </div>

      <div className="sheet-body">
        {sheetTabs.length === 0 && <div className="sheet-empty"><Icon name="book-user" size={32} /><p>No sheet open.<br />Add PDFs in the <strong>Sheets</strong> panel, then open each character.</p></div>}
        {sheetTabs.map(tab => urls[tab.id] ? (
          <iframe key={tab.id} title={tab.name} src={`${urls[tab.id]}#view=FitH`} className="sheet-frame" style={{ display: tab.id === activeSheetId ? 'block' : 'none' }} />
        ) : null)}
      </div>

      {sheetTabs.length > 1 && <div className="sheet-hint">{sheetTabs.length} sheets open · number keys jump · ← → step · Esc hides</div>}
    </section>
  );
}
