import React from 'react';
import { Button, IconButton, Input, Field, Segmented, Swatches, EmptyState, Icon } from '../../ui';
import { PanelSection } from './PanelParts';
import { useGM } from '../../store';
import { ftToCells, areaSizeLabel } from '../../utils';
import { AREA_COLORS } from '../palettes';

const SHAPES = [
  { value: 'areaCircle', icon: 'circle-dashed', label: 'Circle' },
  { value: 'areaRect', icon: 'square-dashed', label: 'Square' },
  { value: 'areaCone', icon: 'cone', label: 'Cone' },
];

/** Feet input with the same measure in grid squares underneath. */
function FeetField({ label, value, feetPerCell, presets = [], onChange }) {
  const cells = ftToCells(value, feetPerCell);
  return (
    <Field label={`${label} (ft)`} hint={`= ${cells} square${cells === 1 ? '' : 's'}`}>
      <Input type="number" min={1} step={feetPerCell} value={value} onChange={event => onChange(Math.max(1, Number(event.target.value) || 1))} />
      {presets.length > 0 && (
        <div className="preset-buttons">
          {presets.map(ft => <Button key={ft} size="sm" active={value === ft} onClick={() => onChange(ft)}>{ft}′</Button>)}
        </div>
      )}
    </Field>
  );
}

export function SpellsPanel() {
  const { state, dispatch } = useGM();
  const exact = state.areaSizeMode === 'exact';
  const shape = state.activeAreaType;
  const feet = state.feetPerCell;
  const prop = (key, value) => dispatch({ type: 'AREA_SET_PROP', key, value });

  return (
    <div>
      <PanelSection title="Cast a spell area">
      <Field label="Shape">
        <Segmented label="Shape" value={{ circle: 'areaCircle', rect: 'areaRect', cone: 'areaCone' }[shape]} options={SHAPES} onChange={tool => dispatch({ type: 'TOOL_SET', tool })} />
      </Field>
      <Field label="Sizing">
        <Segmented label="Sizing" value={exact ? 'exact' : 'drag'} onChange={value => prop('areaSizeMode', value)} options={[
          { value: 'drag', label: 'Drag on the map', title: 'The shape grows with your cursor' },
          { value: 'exact', label: 'Exact feet', title: 'Type the size, then click the map' },
        ]} />
      </Field>

      {exact && <>
        {shape === 'circle' && <FeetField label="Radius" value={state.areaRadiusFt} feetPerCell={feet} presets={[10, 15, 20, 30]} onChange={v => prop('areaRadiusFt', v)} />}
        {shape === 'rect' && <div className="field-row">
          <FeetField label="Width" value={state.areaWidthFt} feetPerCell={feet} onChange={v => prop('areaWidthFt', v)} />
          <FeetField label="Height" value={state.areaHeightFt} feetPerCell={feet} onChange={v => prop('areaHeightFt', v)} />
        </div>}
        {shape === 'cone' && <>
          <FeetField label="Length" value={state.areaConeLengthFt} feetPerCell={feet} presets={[15, 30, 45, 60]} onChange={v => prop('areaConeLengthFt', v)} />
          <Field label={`Spread — ${state.areaConeAngle}°`}>
            <input type="range" min={10} max={180} step={5} value={state.areaConeAngle} aria-label="Cone spread" onChange={event => prop('areaConeAngle', Number(event.target.value))} />
          </Field>
        </>}
        <p className="panel-note">Click the map to drop a shape of exactly this size{shape === 'cone' ? ' — hold and drag to aim the cone' : ''}.{state.snapToGrid ? ' It snaps to the grid.' : ''}</p>
      </>}

      <Field label="Damage type">
        <Swatches colors={AREA_COLORS} value={state.activeAreaColor} onChange={color => dispatch({ type: 'AREA_SET_COLOR', color })} label="Damage type colour" />
        <span className="field__hint">{AREA_COLORS.find(c => c.value === state.activeAreaColor)?.label ?? 'Custom colour'}</span>
      </Field>
      </PanelSection>

      <PanelSection title="Placed on the map" count={state.areaEffects.length}>
      {state.areaEffects.length === 0 && <EmptyState icon="wand-sparkles" title="No spell areas">Pick a shape, then drag on the map. Everyone sees the area as soon as you place it.</EmptyState>}
      <div className="rows">
        {state.areaEffects.map(effect => (
          <div key={effect.id} className={`row is-clickable effect-row${state.selectedId === effect.id ? ' is-selected' : ''}`} onClick={() => dispatch({ type: 'SELECT', id: effect.id })}>
            <span className="effect-dot" style={{ '--c': effect.color }}><Icon name={effect.type === 'cone' ? 'cone' : effect.type === 'rect' ? 'square-dashed' : 'circle-dashed'} size={16} /></span>
            <div className="row__main"><span className="row__title">{effect.type === 'rect' ? 'Square' : effect.type === 'cone' ? 'Cone' : 'Circle'}</span><span className="row__meta">{areaSizeLabel(effect, state.gridSize, state.feetPerCell)}</span></div>
            <IconButton icon="trash" size="sm" label="Delete spell area" onClick={event => { event.stopPropagation(); dispatch({ type: 'AREA_DELETE', id: effect.id }); }} />
          </div>
        ))}
      </div>
      </PanelSection>
    </div>
  );
}
