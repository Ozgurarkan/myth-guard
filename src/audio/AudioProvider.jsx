// The GM's audio broadcaster lives for the whole session, not just while the
// Sound panel is open: closing the panel must never cut the music.
import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { createAudioBroadcaster } from './broadcastAudio.js';
import workletUrl from './pcm-processor.js?worker&url';

const AudioContextGM = createContext(null);

export function AudioProvider({ children }) {
  const controller = useRef(null);
  const [audio, setAudio] = useState({ playerVolume: 1, playerMuted: false, devices: [], active: false, connected: false, listeners: 0 });
  useEffect(() => {
    controller.current = createAudioBroadcaster({ workletUrl, onState: setAudio });
    return () => controller.current.dispose();
  }, []);
  return <AudioContextGM.Provider value={{ audio, controller }}>{children}</AudioContextGM.Provider>;
}

export const useAudio = () => useContext(AudioContextGM);
