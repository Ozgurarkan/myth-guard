import React from 'react';
import { Button, Input, Field, Switch, Segmented, ask, toast } from '../../ui';
import { openPlayerView } from '../openPlayerView';
import { useGM } from '../../store';
import { pxPerFoot } from '../../utils';
import { PanelSection } from './PanelParts';

export function SettingsPanel() {
  const { state, dispatch } = useGM();
  const grid = payload => dispatch({ type: 'GRID_SET', payload });
  const fog = patch => dispatch({ type: 'FOG_SET', ...patch });
  const rect = state.playerViewRect;
  const setRect = patch => dispatch({ type: 'PV_SET_RECT', rect: { ...rect, ...patch } });

  const cover = async () => {
    if (await ask({ title: 'Cover the whole map?', message: 'Every square will be hidden from players until you reveal it.', confirmLabel: 'Cover the map', danger: true })) { dispatch({ type: 'FOG_FILL' }); toast('The whole map is fogged.'); }
  };

  return (
    <div className="settings">
      <PanelSection title="Grid" card>
        <div className="field-row">
          <Field label="Square size (px)" hint="Match your map’s grid">
            <Input type="number" min={10} max={200} value={state.gridSize} onChange={event => grid({ gridSize: Math.max(10, Math.min(200, Number(event.target.value) || 50)) })} />
          </Field>
          <Field label="Line colour"><input className="input" type="color" value={state.gridColor} aria-label="Grid colour" onChange={event => grid({ gridColor: event.target.value })} /></Field>
        </div>
        <Field label={`Line strength — ${Math.round(state.gridOpacity * 100)}%`}>
          <input type="range" min={0} max={1} step={0.01} value={state.gridOpacity} aria-label="Grid opacity" onChange={event => grid({ gridOpacity: Number(event.target.value) })} />
        </Field>
        <div className="settings__switches">
          <Switch checked={state.showGrid} onChange={() => dispatch({ type: 'GRID_TOGGLE' })} label="Show the grid" />
          <Switch checked={state.snapToGrid} onChange={value => grid({ snapToGrid: value })} label="Snap tokens to the grid" hint="Also snaps spell areas placed by exact size." />
        </div>
      </PanelSection>

      <PanelSection title="Scale" card>
        <Field label="One square is…">
          <div className="inline-controls">
            <Segmented label="Feet per square" value={[5, 10].includes(state.feetPerCell) ? state.feetPerCell : 0} onChange={value => value && grid({ feetPerCell: value })}
              options={[{ value: 5, label: '5 ft' }, { value: 10, label: '10 ft' }]} />
            <Input type="number" min={1} max={100} value={state.feetPerCell} aria-label="Feet per square" className="settings__feet"
              onChange={event => grid({ feetPerCell: Math.max(1, Number(event.target.value) || 1) })} />
          </div>
          <span className="field__hint">{Math.round(pxPerFoot(state.gridSize, state.feetPerCell) * 100) / 100} px per foot. Spell areas, markers and token sizes all use this scale.</span>
        </Field>
      </PanelSection>

      <PanelSection title="Fog of war" card>
        <div className="field-row">
          <Field label="Brush size"><Input type="number" min={1} max={10} value={state.fogBrushSize} onChange={event => fog({ brushSize: Math.max(1, Math.min(10, Number(event.target.value) || 1)) })} /></Field>
          <Field label="Fog colour"><input className="input" type="color" value={state.fogColor} aria-label="Fog colour" onChange={event => fog({ color: event.target.value })} /></Field>
        </div>
        <Field label={`Density — ${Math.round(state.fogOpacity * 100)}%`} hint="How dark unrevealed squares look to players.">
          <input type="range" min={0.3} max={1} step={0.01} value={state.fogOpacity} aria-label="Fog density" onChange={event => fog({ opacity: Number(event.target.value) })} />
        </Field>
        <div className="button-row">
          <Button icon="cloud-fog" onClick={cover}>Cover all</Button>
          <Button icon="sun" onClick={() => { dispatch({ type: 'FOG_CLEAR' }); toast('The fog has lifted.'); }}>Clear all</Button>
        </div>
      </PanelSection>

      <PanelSection title="Player view" card>
        <p className="panel-note panel-note--first">The player-view frame decides which part of the map your players see. Drag it on the map, or type its size here.</p>
        <div className="field-row">
          <Field label="Width (px)"><Input type="number" min={100} value={Math.round(rect.width)} onChange={event => setRect({ width: Math.max(100, Number(event.target.value) || 100) })} /></Field>
          <Field label="Height (px)"><Input type="number" min={100} value={Math.round(rect.height)} onChange={event => setRect({ height: Math.max(100, Number(event.target.value) || 100) })} /></Field>
        </div>
        <div className="settings__switches">
          <Switch checked={state.playerViewEnabled} onChange={() => dispatch({ type: 'PV_TOGGLE' })} label="Show the frame on my map" />
          <Switch checked={state.playerCanMoveTokens} onChange={() => dispatch({ type: 'PV_TOGGLE_TOKEN_MOVE' })} label="Players can move their own tokens" />
        </div>
        <div className="panel-gap" />
        <div className="button-row">
          <Button icon="external-link" variant="primary" onClick={() => openPlayerView()}>Open the player view</Button>
          <Button icon="monitor-smartphone" onClick={() => openPlayerView({ tv: true })} title="A big, read-only screen for a television. Cast this window to a Chromecast or Google TV.">Open the TV view</Button>
        </div>
        <p className="panel-note">The TV view has a large turn order down the side, no touch controls, and keeps clear of a TV's screen edges. Cast that window (never the GM screen) to your television.</p>
      </PanelSection>
    </div>
  );
}
