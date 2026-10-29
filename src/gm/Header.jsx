import React, { useState } from 'react';
import { Icon, Button, IconButton, toast } from '../ui';
import { openPlayerView } from './openPlayerView';
import { useGM, hasUnsavedChanges, sceneHasContent } from '../store';
import { useWorkspace } from './workspace';
import { useAudio } from '../audio/AudioProvider';
import { LogoMark } from '../brand';
import { saveScene, importMapFile } from './sceneActions';
import { useTableState } from './tableState';

/** The pill that shows whether players can reach the table, and opens the invite dialog. */
function TableStatus() {
  const { state } = useGM();
  const { setSessionOpen } = useWorkspace();
  const { audio } = useAudio();
  const { status, latency } = state.net;
  const { table, requests } = useTableState();
  const online = state.players.filter(player => player.online && player.admitted).length;
  const waiting = requests.length;
  const locked = table?.locked === true;
  const label = status === 'open'
    ? `${online} ${online === 1 ? 'player' : 'players'}`
    : status === 'reconnecting' ? 'Reconnecting…' : 'Connecting…';
  return (
    <button type="button" className={`table-status is-${status}${waiting ? ' has-requests' : ''}${locked ? ' is-locked' : ''}`} onClick={() => setSessionOpen(true)}
      title={waiting ? `${waiting} waiting to join. Click to answer.` : status === 'open' ? `The table is ${locked ? 'locked' : 'open'}${latency ? ` · ${latency} ms to the server` : ''}. Click to invite players.` : 'Trying to reach the table server…'}>
      <span className="table-status__lamp" aria-hidden="true" />
      <Icon name={status === 'open' ? 'wifi' : 'wifi-off'} size={16} />
      <span className="table-status__label">{label}</span>
      {locked && <span className="table-status__lock" title="The table is locked"><Icon name="lock" size={13} /><span className="sr-only">Table locked</span></span>}
      {waiting > 0 && <span className="table-status__badge" role="status"><span aria-hidden="true">{waiting}</span><span className="sr-only">{waiting} {waiting === 1 ? 'player is' : 'players are'} waiting to join</span></span>}
      {audio?.active && <span className="table-status__live" title="Broadcasting sound to players"><Icon name="music" size={13} /></span>}
    </button>
  );
}

export function Header() {
  const { state, dispatch } = useGM();
  const { openPanel, setShortcutsOpen, plannerOpen, setPlannerOpen } = useWorkspace();
  const [busy, setBusy] = useState(false);
  const dirty = hasUnsavedChanges(state) && sceneHasContent(state);

  const handleImport = async event => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setBusy(true);
    try { await importMapFile(file, state, dispatch); toast('Map imported. Set the grid size in Settings if the squares do not line up.', { tone: 'success' }); }
    catch { toast('That image could not be opened. Try a PNG, JPG or WebP map.', { tone: 'danger' }); }
    finally { setBusy(false); }
  };

  const quickSave = async () => {
    if (!state.currentMapId) { openPanel('scenes'); toast('Give your scene a name, then save it.'); return; }
    try { const name = await saveScene(state, dispatch); toast(`“${name}” saved.`, { tone: 'success' }); }
    catch { toast('The scene could not be saved. Try again.', { tone: 'danger' }); }
  };

  return (
    <header className="header">
      <div className="brand">
        <span className="brand__mark"><LogoMark size={40} /></span>
        <div className="brand__text"><span className="brand__name">Myth Guard</span><small>Game Master’s screen</small></div>
      </div>

      <button type="button" className="scene-chip" onClick={() => openPanel('scenes')} title="Open the scene library">
        <Icon name="map" size={16} />
        <span className="scene-chip__text">
          <span className="scene-chip__label">Scene</span>
          <span className="scene-chip__name">{state.currentMapName}</span>
        </span>
        {dirty && <span className="scene-chip__dirty" title="Unsaved changes" aria-label="Unsaved changes" />}
      </button>

      <div className="header__spacer" />
      <TableStatus />

      <div className="header__actions">
        <Button variant="secondary" icon="notebook-pen" onClick={() => setPlannerOpen(open => !open)} aria-pressed={plannerOpen} title="Plan your session: a page for everything you want to remember (N)">Session plan</Button>
        <label className={`btn btn--secondary${busy ? ' is-busy' : ''}`} title="Choose an image to use as the battle map">
          <Icon name="upload" size={17} /><span className="btn__label">{busy ? 'Opening…' : 'Import map'}</span>
          <input className="visually-hidden-input" aria-label="Import battle map" type="file" accept="image/*" onChange={handleImport} disabled={busy} />
        </label>
        <Button variant="primary" icon="save" onClick={quickSave} title={dirty ? 'Save this scene — you have unsaved changes (Ctrl+S)' : 'Save this scene (Ctrl+S)'} className={dirty ? 'has-dot' : undefined}>Save</Button>
        <Button variant="secondary" icon="external-link" onClick={() => openPlayerView()} title="See exactly what your players see (opens already joined)">Player view</Button>
        <IconButton icon="keyboard" label="Keyboard shortcuts (?)" onClick={() => setShortcutsOpen(true)} />
      </div>
    </header>
  );
}
