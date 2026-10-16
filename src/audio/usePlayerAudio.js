// The player's side of the broadcast: plays whatever the GM sends to this device.
import { useCallback, useEffect, useRef, useState } from 'react';
import { createAudioReceiver } from './receiveAudio.js';

export function usePlayerAudio() {
  const receiver = useRef(null);
  const [state, setState] = useState({ active: false, enabled: false, needsResume: false, selected: false, connected: false });

  useEffect(() => {
    const instance = createAudioReceiver(setState);
    receiver.current = instance;
    // Browsers only start sound after a touch or key press; the first one anywhere on the page unlocks it.
    const unlock = () => { void instance.enable(); };
    const events = ['pointerdown', 'touchend', 'keydown'];
    for (const event of events) document.addEventListener(event, unlock, { capture: true, passive: true });
    unlock();
    return () => {
      for (const event of events) document.removeEventListener(event, unlock, true);
      instance.dispose();
    };
  }, []);

  const enable = useCallback(() => receiver.current?.enable(), []);
  return { state, enable };
}
