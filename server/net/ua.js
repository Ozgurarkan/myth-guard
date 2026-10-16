// "Android · Chrome" style label for the GM's roster and the join request card. Display only, never trusted.

/** Same output as the old `deviceLabel` in identity.js for the same input; a few more modern browsers are recognised. */
export function deviceLabel(agent = '') {
  const text = typeof agent === 'string' ? agent.slice(0, 512) : '';
  const platform = /Android/i.test(text) ? 'Android' : /iPhone|iPad|iPod/i.test(text) ? 'iPhone / iPad'
    : /Windows/i.test(text) ? 'Windows' : /Macintosh/i.test(text) ? 'Mac' : /CrOS/i.test(text) ? 'Chromebook'
      : /Linux/i.test(text) ? 'Linux' : 'Player';
  const browser = /Edg(?:e|A|iOS)?\//.test(text) ? 'Edge' : /Firefox\/|FxiOS\//.test(text) ? 'Firefox'
    : /SamsungBrowser\//.test(text) ? 'Samsung Internet' : /OPR\/|Opera/.test(text) ? 'Opera'
      : /Chrome\/|CriOS\//.test(text) ? 'Chrome' : /Safari\//.test(text) ? 'Safari' : 'Browser';
  return `${platform} · ${browser}`;
}
