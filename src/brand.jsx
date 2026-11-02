import React, { useId, useMemo } from 'react';
import markSvg from './assets/brand/mark.svg?raw';
import sealSvg from './assets/brand/seal.svg?raw';
import { themedSvg } from './logoSvg';

/**
 * A brand SVG drawn inline, so that it is painted in the theme's colours (a picture loaded with <img> cannot read the page's CSS
 * variables). The box is `size` px unless the CSS around it (the header, the welcome card, the gate) gives it its own; decorative.
 */
function Logo({ svg, size, className }) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '');
  const html = useMemo(() => themedSvg(svg, uid), [svg, uid]);
  return <span className={`logo${className ? ` ${className}` : ''}`} style={{ '--logo-size': `${size}px` }} aria-hidden="true" dangerouslySetInnerHTML={{ __html: html }} />;
}

/** The Realm Forge symbol: a forged crystal d20 cradled by a crescent moon, with a spark. Painted in the theme's colours. Decorative. */
export function LogoMark({ size = 40, className }) {
  return <Logo svg={markSvg} size={size} className={className} />;
}

/** The mark inside its ring of runes: the emblem on the welcome card and the player gate. Painted in the theme's colours. Decorative. */
export function LogoSeal({ size = 96, className }) {
  return <Logo svg={sealSvg} size={size} className={className} />;
}
/** The death skull: on a dead token's portrait and in the combat list. Decorative. */
export function SkullMark({ size = 24, className }) {
  return <img className={className} src="/brand/skull.png" width={size} height={size} alt="" aria-hidden="true" draggable="false" />;
}
