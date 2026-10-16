// Colour choices, named the way a table talks about them.

/** Spell areas: one colour per damage type, so a glance tells the table what is happening. Mirrors --dmg-* in src/styles/tokens.css. */
export const AREA_COLORS = [
  { label: 'Fire', value: '#e5533d' },
  { label: 'Cold', value: '#6fb4e8' },
  { label: 'Lightning', value: '#f3d44f' },
  { label: 'Acid', value: '#8bd24f' },
  { label: 'Poison', value: '#4fae7d' },
  { label: 'Necrotic', value: '#9d7bd4' },
  { label: 'Radiant', value: '#f3e7c0' },
  { label: 'Force / Thunder', value: '#e08ad0' },
  { label: 'Earth / Smoke', value: '#9c7a52' },
];

/** Marker colours: the "moonlit spell-library" accents. Saved markers keep whatever hex they were made with. */
export const MARKER_COLORS = [
  { label: 'Violet', value: '#a58bff' },
  { label: 'Cyan', value: '#4fd8ee' },
  { label: 'Aurora', value: '#4fe3a1' },
  { label: 'Rose', value: '#ff6f8e' },
  { label: 'Azure', value: '#6fb0ff' },
  { label: 'Amber', value: '#ffc15a' },
  { label: 'Moonlight', value: '#eef2ff' },
  { label: 'Slate', value: '#8591c0' },
];

/**
 * Token rings. The first eight are the original choices (tokens already placed keep their colour and still show as selected);
 * the rest widen the range so every hero and every kind of creature can have a colour of its own.
 * Each is bright enough to read on a dark map; the initiative list on players' screens uses the same colour.
 */
export const TOKEN_COLORS = [
  { label: 'Violet', value: '#a58bff' },
  { label: 'Cyan', value: '#3fc4dc' },
  { label: 'Aurora', value: '#3fd08c' },
  { label: 'Rose', value: '#ff5c80' },
  { label: 'Azure', value: '#5a9cf0' },
  { label: 'Amber', value: '#f5b040' },
  { label: 'Moonlight', value: '#dfe5ff' },
  { label: 'Slate', value: '#8591c0' },
  { label: 'Crimson', value: '#e0384f' },
  { label: 'Coral', value: '#ff7a6b' },
  { label: 'Orange', value: '#ff8a3d' },
  { label: 'Gold', value: '#f2c94c' },
  { label: 'Lemon', value: '#f6ee6a' },
  { label: 'Lime', value: '#a6e22e' },
  { label: 'Emerald', value: '#1fb870' },
  { label: 'Teal', value: '#20c4b0' },
  { label: 'Sky', value: '#5ec8ff' },
  { label: 'Cobalt', value: '#3b6dff' },
  { label: 'Indigo', value: '#6f7bff' },
  { label: 'Purple', value: '#b45cff' },
  { label: 'Magenta', value: '#e84bd0' },
  { label: 'Pink', value: '#ff9ecb' },
  { label: 'Sand', value: '#e8dcc0' },
  { label: 'Tan', value: '#c9a57a' },
  { label: 'Bronze', value: '#b8763a' },
  { label: 'Graphite', value: '#5b6478' },
];
