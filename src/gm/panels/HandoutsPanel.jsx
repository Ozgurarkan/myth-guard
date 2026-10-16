import React, { useCallback, useEffect, useState } from 'react';
import { Button, IconButton, EmptyState, Icon, Badge, toast } from '../../ui';
import { PanelSection, SearchField } from './PanelParts';
import { useGM } from '../../store';
import { dbListHandouts, dbGetHandout, dbSaveHandout, dbDeleteHandout } from '../../db';
import { LIBRARY_EVENT, saveHandoutFile, downloadImage } from '../../handouts';

export function HandoutsPanel() {
  const { state, dispatch } = useGM();
  const [images, setImages] = useState([]);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState('');

  const refresh = useCallback(() => { dbListHandouts().then(setImages); }, []);
  useEffect(() => {
    refresh();
    window.addEventListener(LIBRARY_EVENT, refresh);
    return () => window.removeEventListener(LIBRARY_EVENT, refresh);
  }, [refresh]);

  const add = async event => {
    const files = Array.from(event.target.files || []);
    event.target.value = '';
    if (!files.length) return;
    setBusy(true);
    try { for (const file of files) await saveHandoutFile(file); refresh(); toast(files.length === 1 ? 'Image added to the library.' : `${files.length} images added.`, { tone: 'success' }); }
    catch { toast('One of those images could not be read.', { tone: 'danger' }); }
    finally { setBusy(false); }
  };

  const show = async entry => {
    const full = await dbGetHandout(entry.id);
    if (!full) return;
    dispatch({ type: 'HANDOUT_SHOW', src: full.src, name: full.name, id: full.id });
    toast(`“${full.name}” is now on your players’ screens.`, { tone: 'success' });
  };
  const hide = () => dispatch({ type: 'HANDOUT_CLEAR' });
  const preview = async entry => { const full = await dbGetHandout(entry.id); if (full) dispatch({ type: 'PREVIEW_SHOW', src: full.src, name: full.name }); };
  const save = async entry => { const full = await dbGetHandout(entry.id); if (full) downloadImage(full); };
  const rename = async entry => {
    const next = window.prompt('Image name', entry.name);
    if (next === null || !next.trim()) return;
    const full = await dbGetHandout(entry.id);
    if (!full) return;
    await dbSaveHandout({ ...full, name: next.trim() });
    refresh();
  };
  const remove = async entry => {
    await dbDeleteHandout(entry.id);
    if (state.handoutId === entry.id) hide();
    refresh();
    toast(`“${entry.name}” deleted.`);
  };

  const q = filter.trim().toLowerCase();
  const visible = q ? images.filter(image => image.name.toLowerCase().includes(q)) : images;

  return (
    <div>
      <PanelSection title="On the players’ screens">
        {state.handoutSrc ? (
          <div className="live-handout" role="status">
            <img src={state.handoutSrc} alt="" />
            <div className="row__main"><strong className="row__title">{state.handoutName || 'Handout'}</strong><Badge tone="success" icon="eye" className="live-handout__badge">Visible to everyone</Badge></div>
            <Button size="sm" icon="search" onClick={() => dispatch({ type: 'PREVIEW_SHOW', src: state.handoutSrc, name: state.handoutName })}>View</Button>
            <Button size="sm" variant="danger" onClick={hide}>Hide</Button>
          </div>
        ) : <p className="panel-note">Nothing is being shown. Pick an image below, preview it privately first, then reveal it to the table.</p>}
      </PanelSection>

      <PanelSection title="Image library" count={images.length}>
        <div className="button-row">
          <label className="btn btn--secondary panel-upload"><Icon name="upload" size={17} /><span className="btn__label">{busy ? 'Saving…' : 'Add images'}</span>
            <input className="visually-hidden-input" type="file" accept="image/*" multiple onChange={add} disabled={busy} aria-label="Add images to the library" /></label>
          <Button variant="primary" icon="images" onClick={() => dispatch({ type: 'MODAL_IMAGES_SHOW' })}>Browse &amp; show…</Button>
        </div>
        <div className="panel-gap" />
        {images.length > 3 && <SearchField label="Search images" placeholder="Search images…" value={filter} onChange={event => setFilter(event.target.value)} />}
        {images.length === 0 && <EmptyState icon="images" title="No handouts yet">Letters, maps, portraits, strange symbols. Add them once and reveal them in one click.</EmptyState>}
        {images.length > 0 && visible.length === 0 && <EmptyState icon="search">No image matches “{filter}”.</EmptyState>}

        <div className="handout-grid">
          {visible.map(entry => {
            const live = state.handoutId === entry.id;
            return (
              <article key={entry.id} className={`handout${live ? ' is-live' : ''}`}>
                <button type="button" className="handout__art" onClick={() => preview(entry)} title="Preview privately (players do not see this)" aria-label={`Preview ${entry.name}`}>
                  <img src={entry.thumbnail} alt="" loading="lazy" />
                  {live && <Badge tone="success" icon="eye" className="handout__badge">Live</Badge>}
                </button>
                <strong title={entry.name}>{entry.name}</strong>
                <div className="handout__actions">
                  <Button size="sm" variant={live ? 'secondary' : 'primary'} onClick={() => (live ? hide() : show(entry))}>{live ? 'Hide' : 'Reveal'}</Button>
                  <IconButton icon="download" size="sm" label="Save to disk" onClick={() => save(entry)} />
                  <IconButton icon="pencil" size="sm" label="Rename" onClick={() => rename(entry)} />
                  <IconButton icon="trash" size="sm" label="Delete" onClick={() => remove(entry)} />
                </div>
              </article>
            );
          })}
        </div>
      </PanelSection>
    </div>
  );
}
