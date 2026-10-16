import React, { useCallback, useEffect, useState } from 'react';
import { Button, IconButton, Input, Field, EmptyState, Badge, Icon, ask, toast } from '../../ui';
import { PanelSection, SearchField } from './PanelParts';
import { useGM, hasUnsavedChanges, sceneHasContent } from '../../store';
import { dbListMaps, dbDeleteMap } from '../../db';
import { saveScene, loadScene } from '../sceneActions';

export function ScenesPanel() {
  const { state, dispatch } = useGM();
  const [scenes, setScenes] = useState([]);
  const [search, setSearch] = useState('');
  const [name, setName] = useState(state.currentMapName);
  const [busy, setBusy] = useState(false);
  const [loadingId, setLoadingId] = useState(null);
  const dirty = hasUnsavedChanges(state) && sceneHasContent(state);

  const refresh = useCallback(() => dbListMaps().then(setScenes), []);
  useEffect(() => { setName(state.currentMapName); }, [state.currentMapName]);
  useEffect(() => {
    refresh();
    window.addEventListener('scenes-updated', refresh);
    return () => window.removeEventListener('scenes-updated', refresh);
  }, [refresh]);

  const save = async asCopy => {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      const saved = await saveScene(state, dispatch, { name, asCopy });
      toast(asCopy ? `Saved a copy as “${saved}”.` : `“${saved}” saved.`, { tone: 'success' });
    } catch { toast('The scene could not be saved. Try again.', { tone: 'danger' }); }
    finally { setBusy(false); }
  };

  const open = async scene => {
    if (dirty && !(await ask({
      title: 'Leave this scene?', message: `“${state.currentMapName}” has changes you have not saved. Opening “${scene.name}” will discard them.`,
      confirmLabel: 'Open anyway', danger: true,
    }))) return;
    setLoadingId(scene.id);
    try { const title = await loadScene(scene.id, dispatch); toast(`“${title}” is on the table.`, { tone: 'success' }); }
    catch (error) { toast(error.message || 'That scene could not be opened.', { tone: 'danger' }); }
    finally { setLoadingId(null); }
  };

  const remove = async scene => {
    if (!(await ask({ title: 'Delete this scene?', message: `“${scene.name}” and everything saved with it will be gone for good.`, confirmLabel: 'Delete scene', danger: true }))) return;
    await dbDeleteMap(scene.id);
    setScenes(list => list.filter(item => item.id !== scene.id));
    if (state.currentMapId === scene.id) dispatch({ type: 'MAP_SET_META', name: state.currentMapName, id: null });
    toast('Scene deleted.');
  };

  const startNew = async () => {
    if (dirty && !(await ask({ title: 'Start a new scene?', message: 'The current scene has unsaved changes that will be lost.', confirmLabel: 'Start fresh', danger: true }))) return;
    dispatch({ type: 'MAP_NEW' });
  };

  const q = search.trim().toLowerCase();
  const shown = q ? scenes.filter(scene => scene.name.toLowerCase().includes(q)) : scenes;

  return (
    <div>
      <PanelSection title="This scene" action={dirty && <Badge tone="warning" className="dirty-badge"><span className="dirty-dot" aria-hidden="true" />Unsaved changes</Badge>}>
        <div className={`scene-current${dirty ? ' is-dirty' : ''}`}>
          <Field label="Name" htmlFor="scene-name">
            <Input id="scene-name" value={name} placeholder="The Whispering Woods" maxLength={80}
              onChange={event => setName(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') save(false); }} />
          </Field>
          <div className="button-row">
            <Button variant="primary" icon="save" onClick={() => save(false)} disabled={busy || !name.trim()}>{busy ? 'Saving…' : state.currentMapId ? 'Save' : 'Save scene'}</Button>
            <Button icon="copy" onClick={() => save(true)} disabled={busy || !name.trim()} title="Keep the original and save this as a new scene">Save copy</Button>
            <Button variant="ghost" icon="plus" onClick={startNew}>New</Button>
          </div>
        </div>
      </PanelSection>

      <PanelSection title="Saved scenes" count={scenes.length}>
        {scenes.length > 3 && <SearchField label="Search saved scenes" placeholder="Search scenes…" value={search} onChange={event => setSearch(event.target.value)} />}
        {scenes.length === 0 && <EmptyState icon="map" art="scroll" title="No scenes yet">Name this scene above and save it. It will be waiting for you next session.</EmptyState>}
        {scenes.length > 0 && shown.length === 0 && <EmptyState icon="search">No scene matches “{search}”.</EmptyState>}

        <div className="scene-grid">
          {shown.map(scene => {
            const active = state.currentMapId === scene.id;
            return (
              <article key={scene.id} className={`scene-card${active ? ' is-active' : ''}`}>
                <button type="button" className="scene-card__art" onClick={() => !active && open(scene)} disabled={active || loadingId === scene.id}
                  aria-label={active ? `${scene.name} is open` : `Open ${scene.name}`}>
                  {scene.thumbnail ? <img src={scene.thumbnail} alt="" loading="lazy" /> : <span className="scene-card__blank"><Icon name="map" size={26} /></span>}
                  {active && <Badge tone="accent" icon="map-pin" className="scene-card__badge">On the table</Badge>}
                  {loadingId === scene.id && <span className="scene-card__loading"><Icon name="loader-circle" className="spin" /></span>}
                </button>
                <div className="scene-card__info">
                  <strong title={scene.name}>{scene.name}</strong>
                  <span className="scene-card__meta"><Icon name="users" size={12} />{scene.tokens?.length ?? 0}<span aria-hidden="true">·</span>{new Date(scene.savedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>
                </div>
                <IconButton icon="trash" label={`Delete ${scene.name}`} size="sm" variant="ghost" className="scene-card__delete" onClick={() => remove(scene)} />
              </article>
            );
          })}
        </div>
      </PanelSection>
    </div>
  );
}
