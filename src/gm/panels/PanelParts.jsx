// Small presentational parts shared by the GM side panels.
// Styles live in src/styles/panels.css.
import React, { useId } from 'react';
import { Icon, Input } from '../../ui';

/**
 * A titled group inside a panel. Reuses the `.section-head` look from components.css, but
 * wraps the heading and its content in a labelled <section> so spacing stays consistent
 * and assistive tech can jump between groups.
 * `card` puts the content on a quiet glass surface (used for settings forms).
 */
export function PanelSection({ title, count, action, card = false, className = '', children }) {
  const id = useId();
  return (
    <section className={`panel-section${className ? ` ${className}` : ''}`} aria-labelledby={id}>
      <div className="section-head">
        <h3 id={id}>{title}{count !== undefined && <span className="section-head__count">{count}</span>}</h3>
        {action && <div className="section-head__action">{action}</div>}
      </div>
      {card ? <div className="panel-card">{children}</div> : children}
    </section>
  );
}

/** A search box with a leading magnifier. `label` is the accessible name. */
export function SearchField({ label, placeholder, value, onChange }) {
  return (
    <div className="panel-search">
      <Icon name="search" size={16} />
      <Input type="search" placeholder={placeholder} aria-label={label} value={value} onChange={onChange} />
    </div>
  );
}
