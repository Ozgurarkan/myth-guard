// Opens the players' screen in a new window, already joined, so the GM never has to type a table code on their own computer.
//   openPlayerView()               the normal player screen (what a phone shows)
//   openPlayerView({ tv: true })   the TV screen: big, read-only, made for casting to a television
// The invite secret is read from the GM-only /__realm/info and put in the address after the #, which browsers never send over the network.
export async function openPlayerView({ tv = false } = {}) {
  // open the window first, inside the click, so the browser's pop-up blocker lets it through
  const win = window.open('about:blank', '_blank');
  if (win) { try { win.opener = null; } catch { /* a locked-down browser: harmless */ } }
  let fragment = '';
  try {
    const response = await fetch('/__realm/info', { credentials: 'same-origin', cache: 'no-store' });
    if (response.ok) {
      const info = await response.json();
      const link = (info.addresses || []).map(entry => entry.joinUrl).find(Boolean);
      if (link) fragment = new URL(link).hash;
    }
  } catch { /* without it the player screen simply asks for the table code */ }
  const url = `${window.location.origin}/player.html${tv ? '?tv=1' : ''}${fragment}`;
  if (win) win.location.href = url; else window.location.href = url;
  return url;
}
