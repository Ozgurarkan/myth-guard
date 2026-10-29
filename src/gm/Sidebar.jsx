// The right-hand sidebar: the active panel, and a tab rail down the edge.
import React from 'react';
import { Icon, IconButton } from '../ui';
import { useGM } from '../store';
import { useWorkspace, PANELS } from './workspace';
import { ScenesPanel } from './panels/ScenesPanel';
import { TokensPanel } from './panels/TokensPanel';
import { CombatPanel } from './panels/CombatPanel';
import { TablePanel } from './panels/TablePanel';
import { LibraryPanel } from './panels/LibraryPanel';
import { SheetsPanel } from './panels/SheetsPanel';
import { HandoutsPanel } from './panels/HandoutsPanel';
import { SpellsPanel } from './panels/SpellsPanel';
import { MarkersPanel } from './panels/MarkersPanel';
import { SoundPanel } from './panels/SoundPanel';
import { SettingsPanel } from './panels/SettingsPanel';

const BODIES = {
  scenes: ScenesPanel,
  tokens: TokensPanel,
  combat: CombatPanel,
  table: TablePanel,
  quests: () => <LibraryPanel kind="quests" />,
  npcs: () => <LibraryPanel kind="npcs" />,
  sheets: SheetsPanel,
  handouts: HandoutsPanel,
  spells: SpellsPanel,
  markers: MarkersPanel,
  sound: SoundPanel,
  settings: SettingsPanel,
};

export function TabRail() {
  const { state } = useGM();
  const { panelOpen, openPanel, setPanelOpen } = useWorkspace();
  return (
    <nav className="tab-rail" aria-label="Codex sections">
      <span className="tab-rail__legend">Codex</span>
      {PANELS.map(panel => {
        const active = state.rightTab === panel.id && panelOpen;
        return (
          <button key={panel.id} id={`workspace-tab-${panel.id}`} type="button" className={`tab-rail__tab${active ? ' is-active' : ''}`} aria-pressed={active}
            title={panel.help} onClick={() => (active ? setPanelOpen(false) : openPanel(panel.id))}>
            <Icon name={panel.icon} size={21} />
            <span>{panel.label}</span>
            {panel.id === 'combat' && state.combat.entries.length > 0 && <i className="tab-rail__dot" aria-label="Combat in progress" />}
            {panel.id === 'table' && state.players.some(player => player.online) && <i className="tab-rail__dot is-green" aria-hidden="true" />}
          </button>
        );
      })}
    </nav>
  );
}

export function Sidebar() {
  const { state } = useGM();
  const { setPanelOpen } = useWorkspace();
  const panel = PANELS.find(item => item.id === state.rightTab) ?? PANELS[0];
  const Body = BODIES[panel.id];
  return (
    <aside className="panel codex" aria-label={panel.title}>
      <header className="panel__head">
        <div>
          <span className="eyebrow">{panel.group}</span>
          <h2>{panel.title}</h2>
          <p>{panel.help}</p>
        </div>
        <IconButton icon="x" label="Close panel" variant="ghost" onClick={() => { setPanelOpen(false); document.getElementById(`workspace-tab-${panel.id}`)?.focus(); }} />
      </header>
      <div className="panel__body" key={panel.id}><Body /></div>
    </aside>
  );
}
