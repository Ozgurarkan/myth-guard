import React, { useLayoutEffect, useRef, useState, useEffect } from 'react';
import { Icon, toast } from '../ui';
import { useGM, nanoid } from '../store';
import { dbSavePreset } from '../db';

function Item({ icon, children, danger, onClick }) {
  return (
    <button type="button" role="menuitem" className={`gm-ctx__item${danger ? ' is-danger' : ''}`} onClick={onClick}>
      <Icon name={icon} size={16} /><span>{children}</span>
    </button>
  );
}

export function ContextMenu() {
  const { state, dispatch } = useGM();
  const menu = state.contextMenu;
  const ref = useRef(null);
  const [at, setAt] = useState({ left: 0, top: 0 });

  // Keep the menu on screen even when opened near an edge.
  useLayoutEffect(() => {
    if (!menu || !ref.current) return;
    const box = ref.current.getBoundingClientRect();
    setAt({
      left: Math.max(8, Math.min(menu.x, window.innerWidth - box.width - 8)),
      top: Math.max(8, Math.min(menu.y, window.innerHeight - box.height - 8)),
    });
  }, [menu]);

  useEffect(() => {
    if (!menu) return undefined;
    const close = event => { if (!ref.current?.contains(event.target)) dispatch({ type: 'CONTEXT_MENU_HIDE' }); };
    const onKey = event => { if (event.key === 'Escape') dispatch({ type: 'CONTEXT_MENU_HIDE' }); };
    window.addEventListener('pointerdown', close, true);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('pointerdown', close, true); window.removeEventListener('keydown', onKey); };
  }, [menu, dispatch]);

  if (!menu) return null;
  const token = menu.type === 'token' ? state.tokens.find(t => t.id === menu.id) : null;
  const marker = menu.type === 'marker' ? state.markers.find(m => m.id === menu.id) : null;
  const hide = () => dispatch({ type: 'CONTEXT_MENU_HIDE' });

  const saveToLibrary = async category => {
    const { id: _id, x: _x, y: _y, ownerId: _owner, ...preset } = token;
    await dbSavePreset({ ...preset, category, savedAt: Date.now() });
    window.dispatchEvent(new CustomEvent('library-updated'));
    toast(`${token.name || 'Token'} saved to the ${category === 'PC' ? 'hero' : 'creature'} library.`, { tone: 'success' });
    hide();
  };

  return (
    <div ref={ref} className="gm-ctx" role="menu" style={at}>
      {token && <>
        <Item icon="pencil" onClick={() => { dispatch({ type: 'MODAL_TOKEN_SHOW', token }); hide(); }}>Edit token…</Item>
        <Item icon={token.visibleToPlayers === false ? 'eye' : 'eye-off'} onClick={() => dispatch({ type: 'TOKEN_TOGGLE_PLAYER_VISIBLE', id: menu.id })}>
          {token.visibleToPlayers === false ? 'Reveal to players' : 'Hide from players'}
        </Item>
        <Item icon="hexagon" onClick={() => dispatch({ type: 'TOKEN_TOGGLE_NUMBER', id: menu.id })}>{token.showNumber ? 'Remove number badge' : 'Add number badge'}</Item>
        <Item icon="copy" onClick={() => { dispatch({ type: 'TOKEN_ADD', token: { ...token, id: nanoid(), x: token.x + state.gridSize, y: token.y + state.gridSize } }); hide(); }}>Duplicate</Item>
        <div className="gm-ctx__sep" />
        <Item icon="shield" onClick={() => saveToLibrary('PC')}>Save as hero preset</Item>
        <Item icon="skull" onClick={() => saveToLibrary('NPC')}>Save as creature preset</Item>
        <div className="gm-ctx__sep" />
        <Item icon="trash" danger onClick={() => dispatch({ type: 'TOKEN_DELETE', id: menu.id })}>Delete token</Item>
      </>}
      {menu.type === 'effect' && <Item icon="trash" danger onClick={() => dispatch({ type: 'AREA_DELETE', id: menu.id })}>Delete spell area</Item>}
      {marker && <>
        <Item icon={marker.visibleToPlayers ? 'eye-off' : 'eye'} onClick={() => dispatch({ type: 'MARKER_TOGGLE_VISIBLE', id: menu.id })}>
          {marker.visibleToPlayers ? 'Hide from players' : 'Reveal to players'}
        </Item>
        <div className="gm-ctx__sep" />
        <Item icon="trash" danger onClick={() => dispatch({ type: 'MARKER_DELETE', id: menu.id })}>Delete marker</Item>
      </>}
    </div>
  );
}
