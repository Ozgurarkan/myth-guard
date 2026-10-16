// Everything floating over the map: welcome card, combat chip, zoom controls,
// selection actions and the "sharing a handout" banner.
import React, { useState } from 'react';
import { LogoSeal } from '../brand';
import { Icon, Button, IconButton, Avatar, Badge } from '../ui';
import { useGM, nanoid } from '../store';
import { useWorkspace } from './workspace';
import { initiativeOrder } from '../combat';
import { areaSizeLabel } from '../utils';
import { ToolOptions } from './ToolOptions';

const view = detail => window.dispatchEvent(new CustomEvent('realm:view', { detail }));

function Welcome({ onDismiss }) {
  const { dispatch } = useGM();
  const { openPanel } = useWorkspace();
  return (
    <div className="welcome-wrap">
      <section className="welcome" aria-labelledby="welcome-title">
        <span className="welcome__seal"><LogoSeal size={112} /></span>
        <span className="eyebrow">Every adventure begins somewhere</span>
        <h1 id="welcome-title">Set the scene.<br /><em>Tell your story.</em></h1>
        <p>Bring your world to the table: import a battle map, open a saved scene, or place a few heroes on the grid and see where the night takes them.</p>
        <div className="welcome__actions">
          <label className="btn btn--primary btn--lg">
            <Icon name="upload" size={18} /><span className="btn__label">Import a map</span>
            <input className="visually-hidden-input" type="file" accept="image/*" aria-label="Import battle map"
              onChange={event => { const file = event.target.files?.[0]; if (file) window.dispatchEvent(new CustomEvent('realm:import-map', { detail: file })); event.target.value = ''; }} />
          </label>
          <Button icon="map" size="lg" onClick={() => openPanel('scenes')}>Open a scene</Button>
        </div>
        <div className="welcome__links">
          <button type="button" onClick={() => { onDismiss(); dispatch({ type: 'MODAL_TOKEN_SHOW', token: null }); }}>Add a token</button>
          <span aria-hidden="true">◆</span>
          <button type="button" onClick={() => openPanel('table')}>Invite players</button>
          <span aria-hidden="true">◆</span>
          <button type="button" onClick={onDismiss}>Use a blank table</button>
        </div>
      </section>
    </div>
  );
}

function CombatChip() {
  const { state, dispatch } = useGM();
  const { openPanel } = useWorkspace();
  const combat = state.combat;
  const order = initiativeOrder(combat);
  if (!order.length) return null;
  const active = state.tokens.find(token => token.id === combat.activeId);
  return (
    <div className="combat-chip" role="group" aria-label="Combat turn">
      <button type="button" className="combat-chip__round" onClick={() => openPanel('combat')} title="Open the combat tracker">
        <span>Round</span><strong>{combat.round}</strong>
      </button>
      {active
        ? <div className="combat-chip__turn"><Avatar src={active.portraitSrc || active.imageSrc} name={active.name} color={active.color} size={34} />
            <div><span className="eyebrow">Current turn</span><strong>{active.name || 'Unnamed'}</strong></div></div>
        : <div className="combat-chip__turn"><div><span className="eyebrow">Ready</span><strong>{order.length} in initiative</strong></div></div>}
      <div className="combat-chip__buttons">
        <IconButton icon="skip-back" label="Previous turn" size="sm" disabled={!combat.activeId} onClick={() => dispatch({ type: 'COMBAT_PREVIOUS' })} />
        <Button variant="primary" size="sm" iconRight="skip-forward" onClick={() => dispatch({ type: 'COMBAT_NEXT' })}>{combat.activeId ? 'Next turn' : 'Start combat'}</Button>
      </div>
    </div>
  );
}

function SelectionBar() {
  const { state, dispatch } = useGM();
  const { openPanel } = useWorkspace();
  const id = state.selectedId;
  const token = state.tokens.find(t => t.id === id);
  const effect = state.areaEffects.find(e => e.id === id);
  const marker = state.markers.find(m => m.id === id);
  if (!token && !effect && !marker) return null;

  if (token) {
    const hidden = token.visibleToPlayers === false;
    return (
      <div className="selection-bar" role="toolbar" aria-label="Selected token">
        <Avatar src={token.imageSrc} name={token.name} color={token.color} size={34} />
        <div className="selection-bar__who"><strong>{token.name || 'Unnamed token'}</strong>
          <Badge tone={hidden ? 'danger' : 'success'} icon={hidden ? 'eye-off' : 'eye'}>{hidden ? 'Hidden from players' : 'Visible to players'}</Badge></div>
        <div className="selection-bar__actions">
          <Button size="sm" icon={hidden ? 'eye' : 'eye-off'} onClick={() => dispatch({ type: 'TOKEN_TOGGLE_PLAYER_VISIBLE', id })}>{hidden ? 'Reveal' : 'Hide'}</Button>
          <IconButton icon="pencil" label="Edit token" size="sm" variant="secondary" onClick={() => dispatch({ type: 'MODAL_TOKEN_SHOW', token })} />
          <IconButton icon="copy" label="Duplicate token" size="sm" variant="secondary"
            onClick={() => dispatch({ type: 'TOKEN_ADD', token: { ...token, id: nanoid(), x: token.x + state.gridSize, y: token.y + state.gridSize } })} />
          <IconButton icon="users" label="Show in token list" size="sm" variant="secondary" onClick={() => openPanel('tokens')} />
          <IconButton icon="trash" label="Delete token" size="sm" variant="danger" onClick={() => dispatch({ type: 'TOKEN_DELETE', id })} />
        </div>
      </div>
    );
  }
  const label = effect ? `Spell area · ${areaSizeLabel(effect, state.gridSize, state.feetPerCell)}` : `Marker${marker.label ? ` · ${marker.label}` : ''}`;
  return (
    <div className="selection-bar" role="toolbar" aria-label="Selection">
      <div className="selection-bar__who"><strong>{label}</strong></div>
      <div className="selection-bar__actions">
        {marker && <Button size="sm" icon={marker.visibleToPlayers ? 'eye-off' : 'eye'} onClick={() => dispatch({ type: 'MARKER_TOGGLE_VISIBLE', id })}>{marker.visibleToPlayers ? 'Hide' : 'Reveal'}</Button>}
        <IconButton icon="trash" label="Delete" size="sm" variant="danger" onClick={() => dispatch({ type: effect ? 'AREA_DELETE' : 'MARKER_DELETE', id })} />
      </div>
    </div>
  );
}

function ZoomControls() {
  const { state } = useGM();
  return (
    <div className="zoom" role="group" aria-label="Map zoom">
      <IconButton icon="minus" label="Zoom out" size="sm" variant="ghost" onClick={() => view({ zoom: 1 / 1.25 })} />
      <button type="button" className="zoom__value" title="Reset to 100%" onClick={() => view({ reset: true })}>{Math.round(state.stageScale * 100)}%</button>
      <IconButton icon="plus" label="Zoom in" size="sm" variant="ghost" onClick={() => view({ zoom: 1.25 })} />
      <IconButton icon="expand" label="Fit the whole map on screen" size="sm" variant="ghost" onClick={() => view({ fit: true })} />
    </div>
  );
}

export function CanvasOverlays() {
  const { state, dispatch } = useGM();
  const [dismissed, setDismissed] = useState(false);
  const empty = !state.mapImageSrc && !state.tokens.length && !state.markers.length && !state.areaEffects.length;
  const tool = state.activeTool;
  const showSelection = tool === 'select' || tool === 'pan';
  return <>
    <div className="canvas-caption" aria-hidden="true"><span className="eyebrow">1 square = {state.feetPerCell} ft</span></div>
    {empty && !dismissed && <Welcome onDismiss={() => setDismissed(true)} />}
    <CombatChip />
    {(state.handoutSrc || state.playerViewEnabled) && (
      <div className="canvas-notices">
        {state.handoutSrc && (
          <div className="share-banner" role="status">
            <Icon name="images" size={17} /><span>Showing <strong>{state.handoutName || 'a handout'}</strong> to your players</span>
            <Button size="sm" variant="danger" onClick={() => dispatch({ type: 'HANDOUT_CLEAR' })}>Stop sharing</Button>
          </div>
        )}
        {state.playerViewEnabled && <div className="pv-badge"><Icon name="scan-eye" size={14} /> Player frame shown</div>}
      </div>
    )}
    <div className="canvas-bottom">
      <ToolOptions />
      {showSelection && <SelectionBar />}
    </div>
    <ZoomControls />
  </>;
}
