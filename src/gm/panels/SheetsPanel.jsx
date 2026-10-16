import React, { useCallback, useEffect, useState } from 'react';
import { Button, IconButton, EmptyState, Icon, ask, toast } from '../../ui';
import { PanelSection, SearchField } from './PanelParts';
import { useGM } from '../../store';
import { dbListSheets, dbGetSheet, dbSaveSheet, dbDeleteSheet } from '../../db';
import { SHEET_EVENT, notifySheets, saveSheetFile, downloadSheet, releaseSheetUrl, fileSizeLabel } from '../../sheets';

export function SheetsPanel() {
  const { state, dispatch } = useGM();
  const [sheets, setSheets] = useState([]);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState('');

  const refresh = useCallback(() => dbListSheets().then(setSheets), []);
  useEffect(() => {
    refresh();
    window.addEventListener(SHEET_EVENT, refresh);
    return () => window.removeEventListener(SHEET_EVENT, refresh);
  }, [refresh]);

  const add = async event => {
    const files = Array.from(event.target.files || []).filter(file => /\.pdf$/i.test(file.name));
    event.target.value = '';
    if (!files.length) { toast('Choose PDF character sheets.', { tone: 'warning' }); return; }
    setBusy(true);
    try {
      for (const file of files) await saveSheetFile(file);
      notifySheets(); await refresh();
      toast(files.length === 1 ? 'Sheet added.' : `${files.length} sheets added.`, { tone: 'success' });
    } catch (error) { toast(error?.message || 'Could not save the PDF. Please try again.', { tone: 'danger' }); }
    finally { setBusy(false); }
  };

  const open = entry => dispatch({ type: 'SHEET_OPEN', sheet: { id: entry.id, name: entry.name } });
  const rename = async entry => {
    const next = window.prompt('Character name', entry.name);
    if (next === null || !next.trim()) return;
    const full = await dbGetSheet(entry.id);
    if (!full) return;
    await dbSaveSheet({ ...full, name: next.trim() });
    dispatch({ type: 'SHEET_RENAME_TAB', id: entry.id, name: next.trim() });
    notifySheets(); refresh();
  };
  const remove = async entry => {
    if (!(await ask({ title: 'Delete this sheet?', message: `“${entry.name}” will be removed from your library.`, confirmLabel: 'Delete', danger: true }))) return;
    dispatch({ type: 'SHEET_CLOSE_TAB', id: entry.id });
    releaseSheetUrl(entry.id);
    await dbDeleteSheet(entry.id);
    notifySheets(); refresh();
  };

  const openIds = new Set(state.sheetTabs.map(tab => tab.id));
  const q = filter.trim().toLowerCase();
  const visible = q ? sheets.filter(sheet => sheet.name.toLowerCase().includes(q)) : sheets;

  return (
    <div>
      <PanelSection title="Open sheets" count={state.sheetTabs.length}>
      {state.sheetTabs.length === 0 ? (
        <EmptyState icon="book-user">Open the characters in this fight, then flip between them with the number keys.</EmptyState>
      ) : <>
        <div className="rows">
          {state.sheetTabs.map((tab, index) => (
            <div key={tab.id} className={`row is-clickable${state.activeSheetId === tab.id ? ' is-selected' : ''}`} onClick={() => dispatch({ type: 'SHEET_SET_ACTIVE', id: tab.id })}>
              <span className="slot" data-active={state.activeSheetId === tab.id}>{index < 9 ? index + 1 : '•'}</span>
              <div className="row__main"><span className="row__title">{tab.name}</span><span className="row__meta">{state.activeSheetId === tab.id ? 'On screen' : index < 9 ? `Press ${index + 1}` : 'Click to view'}</span></div>
              <IconButton icon="x" size="sm" label="Close this sheet" onClick={event => { event.stopPropagation(); dispatch({ type: 'SHEET_CLOSE_TAB', id: tab.id }); }} />
            </div>
          ))}
        </div>
        <div className="button-row">
          <Button variant="primary" size="sm" icon="book-open" onClick={() => dispatch({ type: 'SHEETS_TOGGLE' })}>{state.showSheets ? 'Hide viewer' : 'Show viewer'}</Button>
          <Button size="sm" icon={state.sheetLayout === 'full' ? 'panel-right' : 'maximize'} onClick={() => dispatch({ type: 'SHEETS_SET_LAYOUT', layout: state.sheetLayout === 'full' ? 'dock' : 'full' })}>{state.sheetLayout === 'full' ? 'Dock' : 'Full screen'}</Button>
          <Button size="sm" variant="ghost" onClick={() => dispatch({ type: 'SHEETS_CLOSE_ALL' })}>Close all</Button>
        </div>
      </>}
      </PanelSection>

      <PanelSection title="Sheet library" count={sheets.length}>
        <label className="dropzone">
          <Icon name="upload" size={24} /><strong>{busy ? 'Saving…' : 'Add PDF sheets'}</strong><span>Choose the whole party at once</span>
          <input type="file" accept="application/pdf,.pdf" multiple onChange={add} disabled={busy} aria-label="Add PDF character sheets" />
        </label>
        <div className="panel-gap" />
        {sheets.length > 4 && <SearchField label="Find a sheet" placeholder="Find a character…" value={filter} onChange={event => setFilter(event.target.value)} />}
        {sheets.length > 0 && visible.length === 0 && <EmptyState icon="search">No sheet matches “{filter}”.</EmptyState>}
        <div className="rows">
          {visible.map(entry => {
            const isOpen = openIds.has(entry.id);
            return (
              <div key={entry.id} className={`row is-clickable sheet-row${isOpen ? ' is-selected' : ''}`} onClick={() => open(entry)}>
                <span className="slot slot--pdf"><Icon name="file-text" size={16} /></span>
                <div className="row__main"><span className="row__title">{entry.name}</span><span className="row__meta">{fileSizeLabel(entry.size)}{isOpen ? ' · open' : ''}</span></div>
                <div className="row__actions" onClick={event => event.stopPropagation()}>
                  <Button size="sm" variant={isOpen ? 'secondary' : 'primary'} onClick={() => open(entry)}>{isOpen ? 'View' : 'Open'}</Button>
                  <IconButton icon="download" size="sm" label="Save this PDF to disk" onClick={() => downloadSheet(entry)} />
                  <IconButton icon="pencil" size="sm" label="Rename" onClick={() => rename(entry)} />
                  <IconButton icon="trash" size="sm" label="Delete" onClick={() => remove(entry)} />
                </div>
              </div>
            );
          })}
        </div>
        <p className="panel-note">Sheets stay in this browser and are never sent to players. Open sheets keep their page and scroll position.</p>
      </PanelSection>
    </div>
  );
}
