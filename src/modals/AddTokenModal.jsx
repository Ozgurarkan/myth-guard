import React, { useState, useEffect } from 'react';
import { useGM, nanoid } from '../store';
import { readFileAsDataURL, downscaleDataUrl } from '../utils';
import { dbSavePreset, dbListCategories } from '../db';
import { tokenKind } from '../combat.js';
import { Modal, Button, Input, Select, Field, Segmented, Swatches, Switch, Icon, Avatar, Badge, toast } from '../ui';
import { TOKEN_COLORS } from '../gm/palettes';
import ImageCropper from './ImageCropper';
import { getStage } from '../stageView';

const BLANK = { name: '', characterType: 'pc', maxHp: null, gridSize: 1, color: '#a58bff', borderWidth: 8, imageSrc: null, portraitSrc: null, portraitSource: null, showNumber: false, number: 1 };
const SIZES = [
  [0.5, 'Tiny — half a square'], [1, 'Small / Medium — 1 square'], [2, 'Large — 2 × 2'], [3, 'Huge — 3 × 3'], [4, 'Gargantuan — 4 × 4'],
];

export default function AddTokenModal() {
  const { state, dispatch } = useGM();
  const editing = state.editingToken;
  const [form, setForm] = useState(BLANK);
  const [saveToLibrary, setSaveToLibrary] = useState(false);
  const [category, setCategory] = useState('');
  const [categories, setCategories] = useState([]);
  const [pendingRaw, setPendingRaw] = useState(null);
  const [cropTarget, setCropTarget] = useState('token');
  const [busy, setBusy] = useState(false);

  useEffect(() => { dbListCategories().then(cats => { setCategories(cats); setCategory(cats[0]?.name ?? ''); }); }, []);

  // Fill the form from the token or preset being edited
  useEffect(() => {
    if (editing) {
      setForm({
        name: editing.name ?? '', characterType: tokenKind(editing), maxHp: editing.maxHp ?? null, gridSize: editing.gridSize ?? 1, color: editing.color ?? BLANK.color,
        borderWidth: editing.borderWidth ?? 8, imageSrc: editing.imageSrc ?? null,
        portraitSrc: editing.portraitSrc ?? editing.portraitSource ?? editing.imageSrc ?? null, portraitSource: editing.portraitSource ?? null,
        showNumber: editing.showNumber ?? false, number: editing.number ?? 1,
      });
      if (editing.category) setCategory(editing.category);
    } else setForm(BLANK);
    setSaveToLibrary(false); setPendingRaw(null); setCropTarget('token');
  }, [editing]);

  const set = (key, value) => setForm(current => ({ ...current, [key]: value }));
  const setMaxHp = text => { const number = Math.floor(Number(text)); set('maxHp', text !== '' && number >= 1 ? Math.min(number, 99999) : null); };
  const close = () => dispatch({ type: 'MODAL_TOKEN_HIDE' });
  const isEditing = !!(editing && editing.id);
  const isPresetEdit = !!state.editingPresetId;

  const pickImage = async event => {
    const file = event.target.files[0];
    event.target.value = '';
    if (!file) return;
    setBusy(true);
    try {
      // A phone photo can be 12 megapixels; nothing on the table needs more than ~1600 px.
      setPendingRaw(await downscaleDataUrl(await readFileAsDataURL(file), 1600));
      setCropTarget('token');
    } catch { toast('That image could not be opened.', { tone: 'danger' }); }
    finally { setBusy(false); }
  };

  const cropped = croppedSrc => {
    if (cropTarget === 'initiative') set('portraitSrc', croppedSrc);
    else { set('imageSrc', croppedSrc); set('portraitSrc', pendingRaw); set('portraitSource', pendingRaw); }
    setPendingRaw(null);
  };

  const recropPortrait = () => {
    const source = form.portraitSource || form.portraitSrc || form.imageSrc;
    if (!source) return;
    setCropTarget('initiative');
    setPendingRaw(source);
  };

  const submit = async event => {
    event.preventDefault();
    if (state.editingPresetId) {
      await dbSavePreset({ ...form, category, id: state.editingPresetId, savedAt: Date.now() });
      window.dispatchEvent(new CustomEvent('library-updated'));
      close();
      return;
    }
    if (isEditing) { dispatch({ type: 'TOKEN_UPDATE', token: { ...editing, ...form } }); return; }
    if (saveToLibrary) {
      await dbSavePreset({ ...form, category, savedAt: Date.now() });
      window.dispatchEvent(new CustomEvent('library-updated'));
    }
    // Drop the new token in the middle of what the GM is looking at.
    const canvas = document.querySelector('.canvas-area');
    const view = getStage();
    const cx = (-view.x + (canvas?.clientWidth ?? window.innerWidth) / 2) / view.scale;
    const cy = (-view.y + (canvas?.clientHeight ?? window.innerHeight) / 2) / view.scale;
    const snap = state.snapToGrid ? state.gridSize : 1;
    dispatch({ type: 'TOKEN_ADD', token: { id: nanoid(), x: Math.round(cx / snap) * snap, y: Math.round(cy / snap) * snap, ...form } });
  };

  if (pendingRaw) {
    return (
      <Modal title={cropTarget === 'initiative' ? 'Crop the initiative portrait' : 'Crop the token'} icon="scan-eye" width={420} onClose={() => setPendingRaw(null)}>
        <ImageCropper src={pendingRaw} onCrop={cropped} onCancel={() => setPendingRaw(null)} shape={cropTarget === 'initiative' ? 'portrait' : 'circle'} />
      </Modal>
    );
  }

  const sizeLabel = (SIZES.find(([cells]) => cells === form.gridSize)?.[1] ?? '').split(' — ')[0];
  const title = isEditing ? 'Edit token' : isPresetEdit ? 'Edit library preset' : 'Add a token';
  return (
    <Modal title={title} icon={isEditing || isPresetEdit ? 'pencil' : 'plus'} width={580} onClose={close}
      footer={<>
        <Button variant="ghost" onClick={close}>Cancel</Button>
        <Button variant="primary" icon="check" type="submit" form="token-form">{isEditing ? 'Save changes' : isPresetEdit ? 'Update preset' : 'Place token'}</Button>
      </>}>
      <form id="token-form" onSubmit={submit} className="dlg-token">
        <div className="dlg-token__top">
          <div className="dlg-preview" role="group" aria-label="Live token preview">
            <div className="dlg-preview__stage">
              <span className="dlg-preview__token" style={{ '--ring': form.color, '--bw': form.borderWidth }}>
                {form.imageSrc ? <img src={form.imageSrc} alt="Token preview" /> : <Avatar name={form.name || '?'} size={84} color={form.color} />}
                {form.showNumber && <span className="dlg-preview__num"><span className="sr-only">Number </span>{form.number}</span>}
              </span>
            </div>
            <div className="dlg-preview__caption">
              <span className="dlg-preview__name">{form.name.trim() || 'Unnamed'}</span>
              <span className="dlg-preview__meta">{sizeLabel} · {form.gridSize * state.feetPerCell} ft{form.maxHp ? ` · ${form.maxHp} HP` : ''}</span>
              <Badge tone={form.characterType === 'npc' ? 'danger' : 'cyan'} icon={form.characterType === 'npc' ? 'skull' : 'shield'} className="dlg-preview__kind">{form.characterType === 'npc' ? 'Creature' : 'Hero'}</Badge>
            </div>
          </div>

          <div className="dlg-token__fields">
            <Field label="Name" htmlFor="token-name">
              <Input id="token-name" value={form.name} placeholder="Aria, Goblin Boss, Innkeeper…" maxLength={60} data-autofocus onChange={event => set('name', event.target.value)} />
            </Field>

            <Field label="Who is it?" hint={form.characterType === 'npc' ? 'Players see a creature’s condition (Healthy, Wounded, Down…), never its exact hit points.' : 'Players see a hero’s exact hit points in the initiative bar.'}>
              <Segmented label="Hero or creature" value={form.characterType} onChange={value => set('characterType', value)}
                options={[{ value: 'pc', label: 'Hero (player character)', icon: 'shield' }, { value: 'npc', label: 'Creature / NPC', icon: 'skull' }]} />
            </Field>

            <Field label="Max hit points" htmlFor="token-maxhp" hint="Used automatically whenever this token joins a fight, so you never retype it. Leave empty if you don’t track it.">
              <Input id="token-maxhp" type="number" inputMode="numeric" min={1} max={99999} step={1} value={form.maxHp ?? ''} placeholder="—" style={{ width: 120 }}
                onChange={event => setMaxHp(event.target.value)} />
            </Field>
          </div>
        </div>

        <section className="dlg-group" aria-label="Appearance">
          <h3 className="dlg-group__title">Appearance</h3>
          <Field label="Picture">
            <div className="dlg-art">
              <label className={`btn btn--secondary btn--sm dlg-file${busy ? ' is-busy' : ''}`}><Icon name="upload" size={15} /><span className="btn__label">{busy ? 'Opening…' : form.imageSrc ? 'Change picture' : 'Upload a picture'}</span>
                <input type="file" accept="image/*" onChange={pickImage} disabled={busy} /></label>
              {form.imageSrc && <>
                <Button size="sm" variant="ghost" icon="scan-eye" onClick={recropPortrait}>Crop initiative portrait</Button>
                <Button size="sm" variant="ghost" icon="x" onClick={() => { set('imageSrc', null); set('portraitSrc', null); set('portraitSource', null); }}>Remove</Button>
              </>}
              {!form.imageSrc && <span className="field__hint">You will crop it into a circle next.</span>}
            </div>
          </Field>

          <Field label="Size">
            <Select value={form.gridSize} onChange={event => set('gridSize', Number(event.target.value))}
              options={SIZES.map(([cells, label]) => ({ value: cells, label: `${label} (${cells * state.feetPerCell} ft)` }))} />
          </Field>

          <div className="dlg-ring-grid">
            <Field label="Ring colour">
              <Swatches colors={TOKEN_COLORS} value={form.color} onChange={color => set('color', color)} label="Ring colour" />
              <label className="dlg-custom-color">
                <input type="color" value={/^#[0-9a-f]{6}$/i.test(form.color) ? form.color : '#a58bff'} onChange={event => set('color', event.target.value)} aria-label="Pick any colour" />
                <span>Any colour…</span>
              </label>
            </Field>
            <Field label={`Ring width — ${form.borderWidth}px`}>
              <input type="range" min={2} max={20} step={1} value={form.borderWidth} aria-label="Ring width" onChange={event => set('borderWidth', Number(event.target.value))} />
            </Field>
          </div>
        </section>

        <section className="dlg-group" aria-label="Options">
          <h3 className="dlg-group__title">Options</h3>
          <Switch checked={form.showNumber} onChange={value => set('showNumber', value)} label="Number badge" hint="Tell identical creatures apart: Goblin #1, #2, #3." />
          {form.showNumber && <Field label="Number"><Input type="number" min={0} max={99} value={form.number} style={{ width: 100 }} onChange={event => set('number', Number(event.target.value))} /></Field>}

          {(isPresetEdit || (!isEditing && saveToLibrary)) && categories.length > 0 && (
            <Field label="Library group"><Select value={category} onChange={event => setCategory(event.target.value)} options={categories.map(cat => ({ value: cat.name, label: cat.name === 'PC' ? 'Heroes' : cat.name === 'NPC' ? 'Creatures & folk' : cat.name }))} /></Field>
          )}
          {!isEditing && !isPresetEdit && <Switch checked={saveToLibrary} onChange={setSaveToLibrary} label="Keep in my token library" hint="Place it again in any scene with one click." />}
        </section>
      </form>
    </Modal>
  );
}
