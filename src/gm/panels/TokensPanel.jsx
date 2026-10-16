import React, { useCallback, useEffect, useState } from 'react';
import { Button, IconButton, EmptyState, Avatar, Badge, Icon, ask } from '../../ui';
import { useGM, nanoid } from '../../store';
import { dbListPresets, dbDeletePreset } from '../../db';
import { tokenKind } from '../../combat';
import { PanelSection, SearchField } from './PanelParts';

function TokenRow({ token }) {
  const { state, dispatch } = useGM();
  const hidden = token.visibleToPlayers === false;
  const owner = state.players.find(player => player.id === token.ownerId);
  const kind = tokenKind(token);
  return (
    <div className={`row is-clickable token-row${state.selectedId === token.id ? ' is-selected' : ''}${hidden ? ' is-hidden-token' : ''}`} onClick={() => dispatch({ type: 'SELECT', id: token.id })}>
      <Avatar src={token.imageSrc} name={token.name} color={token.color} size={38} />
      <div className="row__main">
        <span className="row__title">{token.name || 'Unnamed token'}{token.showNumber ? ` #${token.number}` : ''}</span>
        <span className="row__meta">
          <Icon name={kind === 'npc' ? 'skull' : 'shield'} size={12} /> {kind === 'npc' ? 'Creature' : 'Hero'} · {token.gridSize * state.feetPerCell} ft{token.maxHp ? ` · ${token.maxHp} HP` : ''}{owner ? ` · ${owner.name}` : token.ownerId ? ' · a player' : ''}
        </span>
      </div>
      <div className="row__actions" onClick={event => event.stopPropagation()}>
        <IconButton icon={hidden ? 'eye-off' : 'eye'} size="sm" variant={hidden ? 'danger' : 'ghost'}
          label={hidden ? 'Hidden from players — click to reveal' : 'Visible to players — click to hide'}
          onClick={() => dispatch({ type: 'TOKEN_TOGGLE_PLAYER_VISIBLE', id: token.id })} />
        <span className="token-row__more">
          <IconButton icon="pencil" size="sm" label="Edit token" onClick={() => dispatch({ type: 'MODAL_TOKEN_SHOW', token })} />
          <IconButton icon="copy" size="sm" label="Duplicate token"
            onClick={() => dispatch({ type: 'TOKEN_ADD', token: { ...token, id: nanoid(), x: token.x + state.gridSize, y: token.y + state.gridSize } })} />
          <IconButton icon="trash" size="sm" label="Delete token" onClick={() => dispatch({ type: 'TOKEN_DELETE', id: token.id })} />
        </span>
      </div>
    </div>
  );
}

/** A library preset: portrait, name, size, and one clear action. */
function PresetCard({ preset, feetPerCell, onPlace, onEdit, onRemove }) {
  return (
    <article className="preset-card">
      <div className="preset-card__tools">
        <IconButton icon="pencil" size="sm" label={`Edit ${preset.name || 'preset'}`} onClick={onEdit} />
        <IconButton icon="trash" size="sm" label={`Remove ${preset.name || 'preset'}`} onClick={onRemove} />
      </div>
      <Avatar src={preset.imageSrc} name={preset.name} color={preset.color} size={52} />
      <div className="preset-card__text">
        <strong title={preset.name}>{preset.name || 'Unnamed'}</strong>
        <span>{preset.gridSize * feetPerCell} ft{preset.maxHp ? ` · ${preset.maxHp} HP` : ''}</span>
      </div>
      <Button size="sm" icon="plus" block onClick={onPlace}>Place</Button>
    </article>
  );
}

export function TokensPanel() {
  const { state, dispatch } = useGM();
  const [presets, setPresets] = useState([]);
  const [search, setSearch] = useState('');

  const load = useCallback(() => { dbListPresets().then(setPresets); }, []);
  useEffect(() => {
    load();
    window.addEventListener('library-updated', load);
    return () => window.removeEventListener('library-updated', load);
  }, [load]);

  const place = preset => {
    const { id: _id, savedAt: _saved, ...data } = preset;
    dispatch({ type: 'MODAL_TOKEN_SHOW', token: data });
  };
  const removePreset = async preset => {
    if (!(await ask({ title: 'Remove this preset?', message: `“${preset.name}” will be removed from your token library. Tokens already on the map stay.`, confirmLabel: 'Remove', danger: true }))) return;
    await dbDeletePreset(preset.id);
    setPresets(list => list.filter(item => item.id !== preset.id));
  };

  const q = search.trim().toLowerCase();
  const tokens = q ? state.tokens.filter(token => (token.name || '').toLowerCase().includes(q)) : state.tokens;
  const hiddenCount = state.tokens.filter(token => token.visibleToPlayers === false).length;

  return (
    <div>
      <PanelSection title="On the map" count={state.tokens.length} action={<Button size="sm" variant="primary" icon="plus" onClick={() => dispatch({ type: 'MODAL_TOKEN_SHOW', token: null })}>Add token</Button>}>
        {hiddenCount > 0 && <p className="panel-note"><Badge tone="danger" icon="eye-off">{hiddenCount} hidden</Badge> Players cannot see these until you reveal them.</p>}
        {state.tokens.length > 6 && <SearchField label="Find a token" placeholder="Find a token…" value={search} onChange={event => setSearch(event.target.value)} />}
        {state.tokens.length === 0 && <EmptyState icon="users" art="token" title="The table is empty" action={<Button variant="primary" icon="plus" onClick={() => dispatch({ type: 'MODAL_TOKEN_SHOW', token: null })}>Add your first token</Button>}>Heroes, monsters, doors or treasure chests — anything that moves.</EmptyState>}
        {state.tokens.length > 0 && tokens.length === 0 && <EmptyState icon="search">No token matches “{search}”.</EmptyState>}
        <div className="rows">{tokens.map(token => <TokenRow key={token.id} token={token} />)}</div>
      </PanelSection>

      <PanelSection title="Token library" count={presets.length}>
        {presets.length === 0 && <EmptyState icon="backpack">Tick “Save to token library” when adding a token, or right-click a token on the map, to keep it for later.</EmptyState>}
        {[['PC', 'Heroes'], ['NPC', 'Creatures & folk']].map(([category, title]) => {
          const group = presets.filter(preset => (preset.category ?? 'NPC') === category);
          if (!group.length) return null;
          return (
            <div key={category} className="preset-group">
              <h4 className="preset-group__title">{title}<span>{group.length}</span></h4>
              <div className="preset-grid">
                {group.map(preset => (
                  <PresetCard key={preset.id} preset={preset} feetPerCell={state.feetPerCell}
                    onPlace={() => place(preset)} onEdit={() => dispatch({ type: 'MODAL_PRESET_SHOW', preset })} onRemove={() => removePreset(preset)} />
                ))}
              </div>
            </div>
          );
        })}
      </PanelSection>
    </div>
  );
}
