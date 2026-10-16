// Quests and NPCs: two small, searchable, GM-only notebooks.
import React, { useEffect, useState } from 'react';
import { Button, IconButton, Input, Select, Textarea, Field, Badge, Avatar, EmptyState, Icon, ask, toast } from '../../ui';
import { dbListLibrary, dbSaveLibrary, dbDeleteLibrary } from '../../db';
import { useGM, nanoid } from '../../store';
import { SearchField } from './PanelParts';
import { readFileAsDataURL, getImageSize } from '../../utils';

const freshQuest = () => ({ name: '', description: '', location: '', reward: '', notes: '', status: 'Active', npcIds: [] });
const freshNpc = () => ({ name: '', role: '', faction: '', location: '', notes: '', disposition: 'Neutral', imageSrc: null });
const QUEST_STATUSES = ['Planned', 'Active', 'Completed', 'Failed'];
const DISPOSITIONS = ['Friendly', 'Neutral', 'Hostile', 'Unknown'];
const TONES = { Planned: 'info', Active: 'accent', Completed: 'success', Failed: 'danger', Friendly: 'success', Neutral: 'neutral', Hostile: 'danger', Unknown: 'arcane' };

export function LibraryPanel({ kind }) {
  const { state, dispatch } = useGM();
  const npcMode = kind === 'npcs';
  const singular = npcMode ? 'NPC' : 'quest';
  const [records, setRecords] = useState([]);
  const [npcs, setNpcs] = useState([]);
  const [draft, setDraft] = useState(null);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('All');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const reload = async () => {
    const [entries, people] = await Promise.all([dbListLibrary(kind), npcMode ? Promise.resolve([]) : dbListLibrary('npcs')]);
    setRecords(entries); setNpcs(people);
  };
  useEffect(() => {
    let live = true;
    Promise.all([dbListLibrary(kind), npcMode ? Promise.resolve([]) : dbListLibrary('npcs')])
      .then(([entries, people]) => { if (live) { setRecords(entries); setNpcs(people); } })
      .catch(() => { if (live) setError('Could not load this library. Refresh to try again.'); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [kind, npcMode]);

  const set = (field, value) => setDraft(current => ({ ...current, [field]: value }));

  const save = async event => {
    event.preventDefault();
    if (!draft.name.trim() || busy) return;
    setBusy(true); setError('');
    try { await dbSaveLibrary(kind, { ...draft, name: draft.name.trim() }); await reload(); setDraft(null); toast(`${npcMode ? 'NPC' : 'Quest'} saved.`, { tone: 'success' }); }
    catch { setError('Could not save. Your changes are still here; try again.'); }
    finally { setBusy(false); }
  };

  const remove = async record => {
    if (!(await ask({ title: `Delete ${record.name}?`, message: npcMode ? 'Tokens already placed on the map stay where they are.' : 'This quest will be removed from your library.', confirmLabel: 'Delete', danger: true }))) return;
    setBusy(true);
    try { await dbDeleteLibrary(kind, record.id); await reload(); toast(`${npcMode ? 'NPC' : 'Quest'} deleted.`); }
    catch { setError('Could not delete this record. Try again.'); }
    finally { setBusy(false); }
  };

  const place = npc => {
    const canvas = document.querySelector('.canvas-area');
    const x = ((canvas?.clientWidth || 800) / 2 - state.stageX) / state.stageScale;
    const y = ((canvas?.clientHeight || 600) / 2 - state.stageY) / state.stageScale;
    const snap = state.snapToGrid ? state.gridSize : 1;
    dispatch({ type: 'TOKEN_ADD', token: { id: nanoid(), name: npc.name, imageSrc: npc.imageSrc, characterType: 'npc', npcId: npc.id,
      ownerId: null, gridSize: 1, borderWidth: 4, color: '#a58bff', visibleToPlayers: false,
      x: Math.round(x / snap) * snap, y: Math.round(y / snap) * snap } });
    toast(`${npc.name} is on the map, hidden. Reveal them in Tokens when the moment is right.`, { tone: 'success' });
  };

  const portrait = async event => {
    const file = event.target.files[0];
    if (!file) return;
    setBusy(true); setError('');
    try {
      if (file.size > 5 * 1024 * 1024) throw new Error();
      const src = await readFileAsDataURL(file);
      await getImageSize(src);
      set('imageSrc', src);
    } catch { setError('Choose a valid portrait image under 5 MB.'); }
    finally { setBusy(false); event.target.value = ''; }
  };

  const text = r => [r.name, r.location, r.role, r.faction, r.description, r.notes].filter(Boolean).join(' ').toLowerCase();
  const shown = records.filter(r => text(r).includes(search.toLowerCase()) && (filter === 'All' || (npcMode ? r.disposition : r.status) === filter));
  const choices = ['All', ...(npcMode ? DISPOSITIONS : QUEST_STATUSES)];

  if (draft) {
    return (
      <form className="library-form" onSubmit={save}>
        <h3 className="library-form__title">{draft.id ? 'Edit' : 'New'} {singular}</h3>
        {error && <p role="alert" className="form-error">{error}</p>}
        <Field label="Name" htmlFor="lib-name"><Input id="lib-name" required maxLength={120} value={draft.name} onChange={e => set('name', e.target.value)} data-autofocus /></Field>
        <Field label="Location"><Input value={draft.location} placeholder="Where can they be found?" onChange={e => set('location', e.target.value)} /></Field>
        {npcMode ? <>
          <div className="field-row">
            <Field label="Role"><Input placeholder="Innkeeper, rival…" value={draft.role} onChange={e => set('role', e.target.value)} /></Field>
            <Field label="Faction"><Input value={draft.faction} onChange={e => set('faction', e.target.value)} /></Field>
          </div>
          <Field label="Disposition"><Select value={draft.disposition} options={DISPOSITIONS} onChange={e => set('disposition', e.target.value)} /></Field>
          <Field label="Portrait">
            <div className="portrait-field">
              {draft.imageSrc ? <img className="portrait-field__img" src={draft.imageSrc} alt={`${draft.name || 'NPC'} portrait`} /> : <Avatar name={draft.name || '?'} size={72} />}
              <div className="portrait-field__actions">
                <label className="btn btn--secondary btn--sm panel-upload"><Icon name="upload" size={15} /><span className="btn__label">{draft.imageSrc ? 'Change' : 'Choose image'}</span>
                  <input className="visually-hidden-input" type="file" accept="image/*" disabled={busy} onChange={portrait} /></label>
                {draft.imageSrc && <Button size="sm" variant="ghost" onClick={() => set('imageSrc', null)}>Remove</Button>}
              </div>
            </div>
          </Field>
        </> : <>
          <Field label="Status"><Select value={draft.status} options={QUEST_STATUSES} onChange={e => set('status', e.target.value)} /></Field>
          <Field label="Objective"><Textarea rows={3} value={draft.description} placeholder="What must the party accomplish?" onChange={e => set('description', e.target.value)} /></Field>
          <Field label="Reward"><Input value={draft.reward} onChange={e => set('reward', e.target.value)} /></Field>
          <Field label="Linked NPCs">
            {npcs.length ? <div className="check-list">{npcs.map(n => (
              <label className="check" key={n.id}>
                <input type="checkbox" checked={draft.npcIds.includes(n.id)} onChange={e => set('npcIds', e.target.checked ? [...draft.npcIds, n.id] : draft.npcIds.filter(id => id !== n.id))} />
                <span>{n.name}</span>
              </label>))}</div> : <p className="field__hint">Create NPCs in the NPC library to link them here.</p>}
          </Field>
        </>}
        <Field label="Private notes" hint="Only you ever see these."><Textarea rows={4} value={draft.notes} onChange={e => set('notes', e.target.value)} /></Field>
        <div className="button-row">
          <Button type="submit" variant="primary" icon="save" disabled={busy}>{busy ? 'Saving…' : `Save ${singular}`}</Button>
          <Button variant="ghost" disabled={busy} onClick={() => { setDraft(null); setError(''); }}>Cancel</Button>
        </div>
      </form>
    );
  }

  return (
    <div>
      <div className="library-intro">
        <Badge tone="accent" icon="lock">Private to you</Badge>
        <span>Players never see this notebook.</span>
      </div>
      {error && <p role="alert" className="form-error">{error}</p>}
      <Button variant="primary" block icon="plus" onClick={() => setDraft(npcMode ? freshNpc() : freshQuest())}>New {singular}</Button>
      <div className="panel-gap" />
      <SearchField label={`Search ${npcMode ? 'NPCs' : 'quests'}`} placeholder={`Search ${npcMode ? 'NPCs' : 'quests'}…`} value={search} onChange={e => setSearch(e.target.value)} />
      <div className="chips" role="group" aria-label={npcMode ? 'Filter by disposition' : 'Filter by status'}>
        {choices.map(choice => {
          const count = choice === 'All' ? records.length : records.filter(r => (npcMode ? r.disposition : r.status) === choice).length;
          return <button key={choice} type="button" className={`chip${filter === choice ? ' is-active' : ''}`} aria-pressed={filter === choice} onClick={() => setFilter(choice)}>{choice}<span className="chip__count">{count}</span></button>;
        })}
      </div>
      <div className="panel-gap" />
      {loading && <p role="status" className="panel-note">Opening the library…</p>}
      {!loading && !shown.length && <EmptyState icon={npcMode ? 'drama' : 'scroll-text'} art={records.length ? undefined : 'lantern'} title={records.length ? 'Nothing matches' : `No ${npcMode ? 'NPCs' : 'quests'} yet`}>{records.length ? 'Try a different search or filter.' : `Create your first ${singular} to start your notebook.`}</EmptyState>}
      <div className="rows">
        {shown.map(record => (
          <article key={record.id} className="card record" data-tone={TONES[npcMode ? record.disposition : record.status]}>
            <header>
              {npcMode && <Avatar src={record.imageSrc} name={record.name} size={44} />}
              <div className="row__main"><h4>{record.name}</h4>{record.location && <span className="row__meta"><Icon name="map-pin" size={12} /> {record.location}</span>}</div>
              <Badge tone={TONES[npcMode ? record.disposition : record.status]}>{npcMode ? record.disposition : record.status}</Badge>
            </header>
            {npcMode && (record.role || record.faction) && <p className="record__line">{[record.role, record.faction].filter(Boolean).join(' · ')}</p>}
            {!npcMode && record.description && <p className="record__text">{record.description}</p>}
            {!npcMode && record.reward && <p className="record__line"><Icon name="gem" size={14} /> {record.reward}</p>}
            {!npcMode && record.npcIds?.length > 0 && <p className="record__line"><Icon name="drama" size={14} /> {npcs.filter(n => record.npcIds.includes(n.id)).map(n => n.name).join(', ')}</p>}
            {record.notes && <details className="record__notes"><summary>Private notes</summary><p>{record.notes}</p></details>}
            <footer>
              {npcMode && <Button size="sm" variant="primary" icon="plus" onClick={() => place(record)} title="Place a hidden token for this NPC on the map">Place token</Button>}
              <Button size="sm" icon="pencil" disabled={busy} onClick={() => setDraft({ ...(npcMode ? freshNpc() : freshQuest()), ...record })}>Edit</Button>
              <IconButton icon="trash" size="sm" label={`Delete ${record.name}`} disabled={busy} onClick={() => remove(record)} />
            </footer>
          </article>
        ))}
      </div>
    </div>
  );
}
