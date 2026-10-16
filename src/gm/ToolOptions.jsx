// Options for whichever tool is active, floating over the map where the hand already is.
import React from 'react';
import { Icon, Button, IconButton, Input, Segmented, Swatches, ask, toast } from '../ui';
import { useGM } from '../store';
import { MARKER_TYPES } from '../markerTypes';
import { AREA_COLORS, MARKER_COLORS } from './palettes';

function Stepper({ label, value, min, max, onChange }) {
  return (
    <div className="stepper" role="group" aria-label={label}>
      <IconButton icon="minus" label={`Smaller ${label.toLowerCase()}`} size="sm" disabled={value <= min} onClick={() => onChange(Math.max(min, value - 1))} />
      <output className="stepper__value" aria-live="polite">{value}</output>
      <IconButton icon="plus" label={`Larger ${label.toLowerCase()}`} size="sm" disabled={value >= max} onClick={() => onChange(Math.min(max, value + 1))} />
    </div>
  );
}

function FogOptions() {
  const { state, dispatch } = useGM();
  const hiding = state.activeTool === 'fog';
  const cover = async () => {
    if (await ask({ title: 'Cover the whole map?', message: 'Every square will be hidden from your players until you reveal it again.', confirmLabel: 'Cover the map', danger: true })) {
      dispatch({ type: 'FOG_FILL' });
      toast('The whole map is fogged.');
    }
  };
  return <>
    <span className="tool-options__title"><Icon name={hiding ? 'cloud-fog' : 'eraser'} size={17} />{hiding ? 'Hide with fog' : 'Reveal the map'}</span>
    <span className="tool-options__group"><span className="tool-options__label">Brush</span>
      <Stepper label="Brush size" value={state.fogBrushSize} min={1} max={10} onChange={brushSize => dispatch({ type: 'FOG_SET', brushSize })} />
    </span>
    <span className="tool-options__group">
      <Button size="sm" icon="cloud-fog" onClick={cover}>Cover all</Button>
      <Button size="sm" icon="sun" onClick={() => { dispatch({ type: 'FOG_CLEAR' }); toast('The fog has lifted.'); }}>Clear all</Button>
    </span>
    <span className="tool-options__hint">Click and drag across the map</span>
  </>;
}

function AreaOptions() {
  const { state, dispatch } = useGM();
  const shape = state.activeAreaType;
  const exact = state.areaSizeMode === 'exact';
  const prop = (key, value) => dispatch({ type: 'AREA_SET_PROP', key, value });
  const num = (key, min = 5) => (
    <Input className="tool-options__num" type="number" min={min} step={state.feetPerCell} value={state[key]}
      aria-label={key.replace(/([A-Z])/g, ' $1').toLowerCase()} onChange={event => prop(key, Math.max(min, Number(event.target.value) || min))} />
  );
  return <>
    <span className="tool-options__title"><Icon name="wand-sparkles" size={17} />Spell area</span>
    <Segmented label="Shape" value={state.activeTool} onChange={tool => dispatch({ type: 'TOOL_SET', tool })} options={[
      { value: 'areaCircle', icon: 'circle-dashed', label: 'Circle' }, { value: 'areaRect', icon: 'square-dashed', label: 'Square' }, { value: 'areaCone', icon: 'cone', label: 'Cone' },
    ]} />
    <Segmented label="Sizing" value={exact ? 'exact' : 'drag'} onChange={value => prop('areaSizeMode', value)} options={[
      { value: 'drag', label: 'Drag', title: 'Drag on the map to size it freehand' }, { value: 'exact', label: 'Exact feet', title: 'Type the size, then click the map' },
    ]} />
    {exact && <span className="tool-options__group">
      {shape === 'circle' && <><span className="tool-options__label">Radius</span>{num('areaRadiusFt')}<span className="tool-options__unit">ft</span></>}
      {shape === 'rect' && <>{num('areaWidthFt')}<span className="tool-options__unit">×</span>{num('areaHeightFt')}<span className="tool-options__unit">ft</span></>}
      {shape === 'cone' && <><span className="tool-options__label">Length</span>{num('areaConeLengthFt')}<span className="tool-options__unit">ft</span></>}
    </span>}
    <Swatches colors={AREA_COLORS} value={state.activeAreaColor} onChange={color => dispatch({ type: 'AREA_SET_COLOR', color })} label="Damage type colour" />
  </>;
}

function MarkerOptions() {
  const { state, dispatch } = useGM();
  const prop = (key, value) => dispatch({ type: 'MARKER_SET_PROP', key, value });
  return <>
    <span className="tool-options__title"><Icon name="map-pin" size={17} />Marker</span>
    <Segmented label="Marker shape" value={state.activeMarkerType} onChange={value => prop('activeMarkerType', value)}
      options={MARKER_TYPES.map(type => ({ value: type.value, label: type.icon, title: type.label }))} />
    <Swatches colors={MARKER_COLORS} value={state.activeMarkerColor} onChange={color => prop('activeMarkerColor', color)} label="Marker colour" />
    <Input className="tool-options__text" placeholder="Label (optional)" aria-label="Marker label" value={state.activeMarkerLabel} onChange={event => prop('activeMarkerLabel', event.target.value)} />
    <span className="tool-options__hint">Click the map to place</span>
  </>;
}

export function ToolOptions() {
  const { state } = useGM();
  const tool = state.activeTool;
  let body = null;
  if (tool === 'fog' || tool === 'fogErase') body = <FogOptions />;
  else if (tool.startsWith('area')) body = <AreaOptions />;
  else if (tool === 'marker') body = <MarkerOptions />;
  if (!body) return null;
  return <div className="tool-options" role="toolbar" aria-label="Tool options">{body}</div>;
}
