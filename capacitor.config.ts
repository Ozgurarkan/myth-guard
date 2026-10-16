import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.mythguard.player',
  appName: 'Myth Guard Player',
  webDir: 'mobile/player/native-player',
  server: {
    // GMs host tables on their home Wi-Fi, so Android must permit HTTP to LAN addresses.
    cleartext: true,
  },
};

export default config;
