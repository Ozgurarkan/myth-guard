// Cast a spell area: pick the shape, its size and its colour, then put it down on the map (press, drag, release), or wear a
// circle bound to one of your heroes, which follows that hero wherever it goes. Your own areas are listed so you can take them back.
import React, { useState } from 'react';
import { Icon, IconButton, Button } from '../ui';
import { PLAYER_AREA_COLORS } from '../areas';

const SHAPES = [
  { id: 'circle', label: 'Circle', icon: 'circle-dashed' },
  { id: 'rect', label: 'Square', icon: 'square-dashed' },
  { id: 'cone', label: 'Cone', icon: 'cone' },
];
/** Which field of the spell holds the size of each shape, and what it is called. */
export const SIZE_FIELD = { circle: { key: 'radiusFt', label: 'Radius' }, rect: { key: 'sideFt', label: 'Side' }, cone: { key: 'lengthFt', label: 'Length' } };
const COLOR_NAMES = ['Fire', 'Lightning', 'Acid', 'Cold', 'Necrotic', 'Force'];
const PRESETS = [10, 15, 20, 30, 60];
const MIN_FT = 5, MAX_FT = 120;
const SPREADS = [30, 60, 90];

const kindName = effect => (effect.type === 'rect' ? 'Square' : effect.type === 'cone' ? 'Cone' : 'Circle');

/**
 * `spell` is { shape, color, radiusFt, sideFt, lengthFt, angle }; `onChange(patch)` edits it. `heroes` are your hero tokens (for a
 * bound circle); `mine` your effects on the map; `describe(effect)` is the size label of one; `nameOf(tokenId)` a hero's name.
 */
export function SpellSheet({ spell, onChange, heroes, mine, describe, nameOf, onBind, onRemove, onClear, onClose }) {
  // Collapsed, only the title stays: the sheet covers the map you are aiming at, so it can be folded away while you place a spell.
  const [collapsed, setCollapsed] = useState(false);
  const size = SIZE_FIELD[spell.shape];
  const feet = spell[size.key];
  const setFeet = value => onChange({ [size.key]: Math.max(MIN_FT, Math.min(MAX_FT, Math.round(value / 5) * 5)) });
  return (
    <section className={`p-hero p-spell${collapsed ? ' is-collapsed' : ''}`} aria-label="Cast a spell area">
      <header className="p-hero__head">
        <strong><Icon name="wand-sparkles" size={18} /> Spell area</strong>
        <span className="p-spell__head-buttons">
          <IconButton icon={collapsed ? 'chevron-up' : 'chevron-down'} label={collapsed ? 'Show the spell options' : 'Fold the options away to see the map'} variant="ghost" size="sm" aria-expanded={!collapsed} onClick={() => setCollapsed(value => !value)} />
          <IconButton icon="x" label="Close" variant="ghost" size="sm" onClick={onClose} />
        </span>
      </header>
      {!collapsed && <>

      <div className="p-spell__shapes" role="radiogroup" aria-label="Shape">
        {SHAPES.map(shape => (
          <button key={shape.id} type="button" role="radio" aria-checked={spell.shape === shape.id} className={`p-spell__shape${spell.shape === shape.id ? ' is-active' : ''}`}
            onClick={() => onChange({ shape: shape.id })}>
            <Icon name={shape.icon} size={20} /><span>{shape.label}</span>
          </button>
        ))}
      </div>

      <div className="p-hero__field">
        <span className="p-hero__label">{size.label}</span>
        <div className="p-hero__stepper">
          <IconButton icon="minus" label={`Smaller ${size.label.toLowerCase()}`} variant="secondary" disabled={feet <= MIN_FT} onClick={() => setFeet(feet - 5)} />
          <output className="p-spell__feet" aria-live="polite">{feet} ft</output>
          <IconButton icon="plus" label={`Larger ${size.label.toLowerCase()}`} variant="secondary" disabled={feet >= MAX_FT} onClick={() => setFeet(feet + 5)} />
        </div>
        <div className="p-spell__presets">
          {PRESETS.map(preset => <button key={preset} type="button" className={`chip${feet === preset ? ' is-active' : ''}`} onClick={() => setFeet(preset)}>{preset}</button>)}
        </div>
      </div>

      {spell.shape === 'cone' && (
        <div className="p-hero__field">
          <span className="p-hero__label">Spread</span>
          <div className="p-spell__presets">
            {SPREADS.map(angle => <button key={angle} type="button" className={`chip${spell.angle === angle ? ' is-active' : ''}`} onClick={() => onChange({ angle })}>{angle}°</button>)}
          </div>
        </div>
      )}

      <div className="p-spell__colors" role="radiogroup" aria-label="Colour">
        {PLAYER_AREA_COLORS.map((color, index) => (
          <button key={color} type="button" role="radio" aria-checked={spell.color === color} aria-label={COLOR_NAMES[index]} title={COLOR_NAMES[index]}
            className={`p-spell__color${spell.color === color ? ' is-active' : ''}`} style={{ '--c': color }} onClick={() => onChange({ color })} />
        ))}
      </div>

      {spell.shape === 'circle' && heroes.length > 0 && (
        <div className="p-spell__bind">
          {heroes.map(hero => (
            <Button key={hero.id} variant="primary" icon="circle-dashed" onClick={() => onBind(hero)}>Circle around {hero.name || 'my hero'}</Button>
          ))}
        </div>
      )}

      {mine.length > 0 && (
        <div className="p-spell__mine">
          <header className="p-spell__mine-head"><span className="p-hero__label">Yours</span><button type="button" className="p-spell__clear" onClick={onClear}>Take all back</button></header>
          <ul className="p-spell__list">
            {mine.map(effect => (
              <li key={effect.id} className="p-spell__item" style={{ '--c': effect.color }}>
                <span className="p-spell__dot" aria-hidden="true" />
                <span className="p-spell__what">{kindName(effect)} · {describe(effect)}{effect.boundTo ? ` · ${nameOf(effect.boundTo)}` : ''}</span>
                <IconButton icon="x" label={`Take back this ${kindName(effect).toLowerCase()}`} variant="ghost" size="sm" onClick={() => onRemove(effect.id)} />
              </li>
            ))}
          </ul>
        </div>
      )}
      </>}
    </section>
  );
}
