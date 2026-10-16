/**
 * ImagePicker — "Browse & show": pick a saved image to reveal to the players.
 * Anything added from the computer is kept in the library for next time.
 */
import React, { useState, useEffect, useCallback } from 'react';
import { useGM } from '../store';
import { dbListHandouts, dbGetHandout, dbDeleteHandout } from '../db';
import { LIBRARY_EVENT, notifyLibrary, saveHandoutFile } from '../handouts';
import { Modal, Button, IconButton, Input, Icon, Badge, EmptyState, toast } from '../ui';

export default function ImagePicker() {
  const { state, dispatch } = useGM();
  const [images, setImages] = useState([]);
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(() => { dbListHandouts().then(setImages).finally(() => setLoaded(true)); }, []);
  useEffect(() => {
    refresh();
    window.addEventListener(LIBRARY_EVENT, refresh);
    return () => window.removeEventListener(LIBRARY_EVENT, refresh);
  }, [refresh]);

  const close = () => dispatch({ type: 'MODAL_IMAGES_HIDE' });

  const reveal = async entry => {
    const full = await dbGetHandout(entry.id);
    if (!full) return;
    dispatch({ type: 'HANDOUT_SHOW', src: full.src, name: full.name, id: full.id });
    toast(`“${full.name}” is now on your players’ screens.`, { tone: 'success' });
    close();
  };

  /** Add files from disk — a single pick is revealed straight away. */
  const addFiles = async event => {
    const files = Array.from(event.target.files || []);
    event.target.value = '';
    if (!files.length) return;
    setBusy(true);
    try {
      let last = null;
      for (const file of files) last = await saveHandoutFile(file);
      notifyLibrary();
      if (files.length === 1 && last) {
        dispatch({ type: 'HANDOUT_SHOW', src: last.src, name: last.name, id: last.id });
        toast(`“${last.name}” is now on your players’ screens.`, { tone: 'success' });
        close();
      } else refresh();
    } catch { toast('One of those images could not be read.', { tone: 'danger' }); }
    finally { setBusy(false); }
  };

  const preview = async (event, entry) => {
    event.stopPropagation();
    const full = await dbGetHandout(entry.id);
    if (full) dispatch({ type: 'PREVIEW_SHOW', src: full.src, name: full.name });
  };

  const remove = async (event, entry) => {
    event.stopPropagation();
    await dbDeleteHandout(entry.id);
    notifyLibrary(); refresh();
    toast(`“${entry.name}” deleted.`);
  };

  const q = filter.trim().toLowerCase();
  const visible = q ? images.filter(image => image.name.toLowerCase().includes(q)) : images;

  return (
    <Modal title="Show an image to the players" icon="images" width={820} onClose={close}
      footer={<>
        <span className="dlg-hint">Click an image to put it on every player’s screen.</span>
        <Button variant="ghost" onClick={close}>Cancel</Button>
      </>}>
      <div className="dlg-picker__bar">
        {images.length > 4 && <Input type="search" placeholder="Search the library…" aria-label="Search the library" value={filter} onChange={event => setFilter(event.target.value)} />}
        <label className={`btn btn--primary dlg-file${busy ? ' is-busy' : ''}`}><Icon name="upload" size={17} /><span className="btn__label">{busy ? 'Saving…' : 'Add from computer'}</span>
          <input type="file" accept="image/*" multiple onChange={addFiles} disabled={busy} /></label>
      </div>
      {loaded && images.length === 0 && <EmptyState icon="images" title="Your library is empty">Use “Add from computer”. Images you add stay here, so next session you can reveal them in one click.</EmptyState>}
      {images.length > 0 && visible.length === 0 && <EmptyState icon="search">No image matches “{filter}”.</EmptyState>}
      <div className="dlg-picker__grid">
        {visible.map(entry => {
          const live = state.handoutId === entry.id;
          return (
            <div key={entry.id} className={`dlg-tile${live ? ' is-live' : ''}`}>
              <button type="button" className="dlg-tile__art" onClick={() => reveal(entry)} title={`Show “${entry.name}” to the players`} aria-label={`Show “${entry.name}” to the players`}>
                <img src={entry.thumbnail} alt="" />
                <span className="dlg-tile__show" aria-hidden="true"><Icon name="eye" size={15} /> Show to players</span>
                {live && <Badge tone="success" className="dlg-tile__badge">Live</Badge>}
              </button>
              <strong className="dlg-tile__name" title={entry.name}>{entry.name}</strong>
              <div className="dlg-tile__actions">
                <Button size="sm" onClick={event => preview(event, entry)} title="Look at it yourself first — players do not see this" icon="eye">Preview</Button>
                <IconButton icon="trash" size="sm" label="Delete from library" onClick={event => remove(event, entry)} />
              </div>
            </div>
          );
        })}
      </div>
    </Modal>
  );
}
