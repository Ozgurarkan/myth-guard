import React, { useMemo } from 'react';
import { encode } from 'uqr';

/** A scannable QR code drawn as one SVG path: dark indigo ink on pale moonlit vellum, with the quiet zone scanners need. */
export function QrCode({ value, label = 'QR code' }) {
  const { path, size } = useMemo(() => {
    const { data, size: modules } = encode(value, { ecc: 'M', border: 0 });
    let d = '';
    for (let y = 0; y < modules; y++) {
      for (let x = 0; x < modules; x++) {
        if (!data[y][x]) continue;
        let run = 1;
        while (x + run < modules && data[y][x + run]) run++;
        d += `M${x} ${y}h${run}v1h-${run}z`;
        x += run - 1;
      }
    }
    return { path: d, size: modules };
  }, [value]);
  const quiet = 3;
  return (
    <svg className="qr" viewBox={`${-quiet} ${-quiet} ${size + quiet * 2} ${size + quiet * 2}`} role="img" aria-label={label} shapeRendering="crispEdges">
      <rect x={-quiet} y={-quiet} width={size + quiet * 2} height={size + quiet * 2} fill="#e6eaff" />
      <path d={path} fill="#141a38" />
    </svg>
  );
}
