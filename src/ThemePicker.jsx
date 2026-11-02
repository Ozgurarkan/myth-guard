// The five colour themes as swatch buttons. `compact` is only the round swatches (the player menu); otherwise each is a labelled tile.
import React from 'react';
import { THEMES, useTheme } from './theme';

export function ThemePicker({ compact = false }) {
  const [current, setTheme] = useTheme();
  return (
    <div className={`theme-picker${compact ? ' is-compact' : ''}`} role="radiogroup" aria-label="Colour theme">
      {THEMES.map(theme => (
        <button key={theme.id} type="button" role="radio" aria-checked={current === theme.id} aria-label={theme.label} title={theme.label}
          className={`theme-swatch${current === theme.id ? ' is-active' : ''}`} onClick={() => setTheme(theme.id)}
          style={{ '--sw-0': theme.swatch[0], '--sw-1': theme.swatch[1], '--sw-2': theme.swatch[2] }}>
          <span className="theme-swatch__chip" aria-hidden="true"><i /><i /></span>
          <span className="theme-swatch__label">{theme.label}</span>
        </button>
      ))}
    </div>
  );
}
