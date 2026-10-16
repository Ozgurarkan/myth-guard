import React from 'react';

/** The Realm Forge symbol: a forged crystal d20 cradled by a crescent moon, with a cyan spark. Decorative. */
export function LogoMark({ size = 40, className }) {
  return <img className={className} src="/brand/mark.svg" width={size} height={size} alt="" aria-hidden="true" draggable="false" />;
}

/** The mark inside its ring of runes: the emblem on the welcome card and the player gate. Decorative. */
export function LogoSeal({ size = 96, className }) {
  return <img className={className} src="/brand/seal.svg" width={size} height={size} alt="" aria-hidden="true" draggable="false" />;
}
