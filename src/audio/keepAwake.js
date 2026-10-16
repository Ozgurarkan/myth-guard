// Keeping a phone's screen on while sound plays (design 5.5).
//
// The Wake Lock API only exists in secure contexts, and players are on plain http://192.168.x.x. So: use it when it is there,
// otherwise play a hidden, muted, looping 16x16 video inline (the technique NoSleep.js uses). It stops the screen from
// auto-locking while the page is visible; it cannot prevent a manual lock. Must be started from a user gesture (the same tap
// that enables sound). Nothing here throws: every browser API is optional.
import { MP4_CLIP, WEBM_CLIP } from './keepAwakeClips.js';

export function createKeepAwake({ documentRef = globalThis.document, navigatorRef = globalThis.navigator, onChange } = {}) {
  let wanted = false;
  let lock = null;
  let video = null;
  let mode = 'off';
  const set = next => { if (next !== mode) { mode = next; onChange?.(mode); } };

  async function acquireLock() {
    try {
      lock = await navigatorRef.wakeLock.request('screen');
      lock.addEventListener?.('release', () => { lock = null; });
      set('wake-lock');
      return true;
    } catch { lock = null; return false; }
  }

  function startVideo() {
    if (video || !documentRef) return;
    try {
      video = documentRef.createElement('video');
      video.setAttribute('playsinline', '');
      video.setAttribute('muted', '');
      video.setAttribute('aria-hidden', 'true');
      video.muted = true;
      video.loop = true;
      video.playsInline = true;
      video.disableRemotePlayback = true;
      Object.assign(video.style, { position: 'fixed', left: '0', top: '0', width: '2px', height: '2px', opacity: '0.01', pointerEvents: 'none', zIndex: '-1' });
      const canWebm = video.canPlayType?.('video/webm; codecs="vp8"');
      video.src = canWebm ? WEBM_CLIP : MP4_CLIP;
      documentRef.body.appendChild(video);
      const played = video.play();
      set('video');
      played?.catch?.(() => { set('blocked'); });
    } catch { set('off'); }
  }

  function revive() {
    if (!wanted) return;
    if (navigatorRef?.wakeLock) { if (!lock) void acquireLock(); }
    else if (video && video.paused) video.play?.().catch?.(() => {});
  }
  const onVisible = () => { if (documentRef?.visibilityState === 'visible') revive(); };
  documentRef?.addEventListener?.('visibilitychange', onVisible);

  return {
    /** Call from a tap. Returns the mode that ended up in use: 'wake-lock' | 'video' | 'blocked' | 'off'. */
    async start() {
      wanted = true;
      if (navigatorRef?.wakeLock && await acquireLock()) return mode;
      startVideo();
      return mode;
    },
    stop() {
      wanted = false;
      try { lock?.release?.(); } catch { /* ignore */ }
      lock = null;
      if (video) { try { video.pause(); video.removeAttribute('src'); video.load?.(); video.remove(); } catch { /* ignore */ } video = null; }
      set('off');
    },
    /** Lock-screen / notification controls for a page that is playing media (best effort, harmless when missing). */
    setMediaSession(title = 'Myth Guard', artist = 'Game table') {
      try {
        const session = navigatorRef?.mediaSession;
        if (session && globalThis.MediaMetadata) session.metadata = new globalThis.MediaMetadata({ title, artist });
        if (session) for (const action of ['play', 'pause']) try { session.setActionHandler(action, () => {}); } catch { /* unsupported action */ }
      } catch { /* ignore */ }
    },
    get mode() { return mode; },
    dispose() { this.stop(); documentRef?.removeEventListener?.('visibilitychange', onVisible); },
  };
}
