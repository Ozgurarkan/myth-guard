import React, { useEffect } from 'react';
import { Modal, Button, toast } from '../ui';
import { useGM } from '../store';
import { useWorkspace } from './workspace';
import { saveScene } from './sceneActions';

const TOOL_KEYS = { v: 'select', h: 'pan', f: 'fog', e: 'fogErase', c: 'areaCircle', r: 'areaRect', k: 'areaCone', m: 'marker' };

export function KeyboardHandler() {
  const { state, dispatch } = useGM();
  const { setShortcutsOpen, setPlannerOpen } = useWorkspace();

  useEffect(() => {
    const handler = event => {
      const tag = event.target.tagName;
      const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || event.target.isContentEditable;
      const key = event.key.toLowerCase();

      if ((event.ctrlKey || event.metaKey) && key === 's') {
        event.preventDefault();
        if (!state.currentMapId) { dispatch({ type: 'TAB_SET', tab: 'scenes' }); toast('Give your scene a name, then save it.'); return; }
        saveScene(state, dispatch).then(name => toast(`“${name}” saved.`, { tone: 'success' }), () => toast('The scene could not be saved.', { tone: 'danger' }));
        return;
      }
      if (typing || event.ctrlKey || event.metaKey || event.altKey) return;
      // The session plan is a page of its own: the map's one-key tools stay out of its way.
      if (document.querySelector('.planner')) { if (key === 'n') setPlannerOpen(false); return; }
      // Open dialogs own the keyboard
      if (state.previewSrc || state.showImagePicker || state.showTokenModal || document.querySelector('.modal-overlay')) return;

      if (key === '?' || (key === '/' && event.shiftKey)) { setShortcutsOpen(true); return; }
      // The sheet viewer takes 1–9 / ← → / Esc for itself while it is on screen
      if (key === 's') { dispatch({ type: 'SHEETS_TOGGLE' }); return; }
      if (state.showSheets && (/^[1-9]$/.test(key) || key === 'arrowleft' || key === 'arrowright' || key === 'escape')) return;

      if (TOOL_KEYS[key]) { dispatch({ type: 'TOOL_SET', tool: TOOL_KEYS[key] }); return; }
      if (key === 'n') { setPlannerOpen(true); return; }
      if (key === 'g') { dispatch({ type: 'GRID_TOGGLE' }); return; }
      if (key === 'p') { dispatch({ type: 'PV_TOGGLE' }); return; }
      if (key === 'escape') { dispatch({ type: 'TOOL_SET', tool: 'select' }); dispatch({ type: 'SELECT', id: null }); return; }
      if ((key === 'delete' || key === 'backspace') && state.selectedId) {
        if (state.tokens.some(t => t.id === state.selectedId)) dispatch({ type: 'TOKEN_DELETE', id: state.selectedId });
        else if (state.areaEffects.some(a => a.id === state.selectedId)) dispatch({ type: 'AREA_DELETE', id: state.selectedId });
        else if (state.markers.some(m => m.id === state.selectedId)) dispatch({ type: 'MARKER_DELETE', id: state.selectedId });
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [state, dispatch, setShortcutsOpen, setPlannerOpen]);

  return null;
}

const SHORTCUTS = [
  ['Tools', [['V', 'Select and move'], ['H', 'Pan the map'], ['M', 'Place a marker'], ['F', 'Hide with fog'], ['E', 'Reveal fog'], ['C', 'Circle spell'], ['R', 'Square spell'], ['K', 'Cone spell']]],
  ['View', [['G', 'Show or hide the grid'], ['P', 'Show the player frame'], ['S', 'Show or hide character sheets'], ['N', 'Open or close the session plan'], ['Scroll', 'Zoom the map'], ['Middle-drag', 'Pan the map']]],
  ['Sheets', [['1 – 9', 'Jump to an open sheet'], ['← →', 'Step through sheets'], ['Esc', 'Hide the viewer']]],
  ['General', [['Ctrl + S', 'Save the scene'], ['Delete', 'Remove the selection'], ['Esc', 'Back to Select'], ['?', 'This list']]],
];

export function ShortcutsDialog({ onClose }) {
  return (
    <Modal title="Keyboard shortcuts" icon="keyboard" width={640} onClose={onClose} footer={<Button variant="primary" onClick={onClose}>Got it</Button>}>
      <div className="gm-shortcuts">
        {SHORTCUTS.map(([group, items]) => (
          <section key={group}>
            <h3 className="eyebrow">{group}</h3>
            <dl>{items.map(([keys, what]) => <div key={keys + what}><dt><kbd className="key">{keys}</kbd></dt><dd>{what}</dd></div>)}</dl>
          </section>
        ))}
      </div>
    </Modal>
  );
}
