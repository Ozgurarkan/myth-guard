# Real-device checklist

What only real phones on the real Wi-Fi can verify (design section 8). About five minutes per phone. Tick a box only when you saw it happen. If the answer is **no**, do the "If no" line and write the result in the notes at the bottom.

Before you start, on the GM computer:

- [ ] `npm run build`, then `npm start`, GM screen open at `http://localhost:5173` (not through the LAN address: sound capture needs `localhost`).
- [ ] The GM computer is on Ethernet for the first run (Wi-Fi is test 12).
- [ ] `ENABLE-LAN.ps1` has been run once and the network profile is Private.
- [ ] Debug overlay: press Ctrl+Shift+D on the GM screen and on each phone. Note the numbers in the table at the bottom.
- [ ] `/__realm/diag` open in a second GM tab (GM only) to read per-device RTT, reconnects and audio counters.

Test devices: one iPhone (Safari), one Android phone (Chrome). Write model and OS version in the notes.

## A. Joining

- [ ] **A1 Join by QR code.** Scan the code in the invite dialog with the camera app; the page opens, asks for a name, and shows the map. *If no:* check that the link starts with `http://192.168...` and has `#join=`; if the camera app drops the part after `#`, ship the typed code as the main path and note it in the README.
- [ ] **A2 Join by typed table code.** Open `http://<ip>:5173/player.html`, type the 8 characters. *If no:* look at the error text on the phone and `/__realm/diag` rejects (`proof`, `ratelimit`); a router that rewrites the Host header or blocks the port is the usual cause.
- [ ] **A3 Reload and rejoin.** Pull to refresh, then close the tab and reopen it later from the home screen or history: no invite needed. *If no:* the device key was lost (private browsing, "prevent cross-site tracking" clearing storage); the UI must say "ask for the invite again"; if Safari clears it routinely, document it.
- [ ] **A4 Kick and rejoin.** GM presses Kick: the phone shows "You were removed from this table" and does not reconnect by itself. Rotate the invite, rescan: joins again as a new device. *If no:* file a defect against the join gate screens (3.9 item 8).
- [ ] **A5 Ask-first mode.** GM sets Ask first: the phone shows "Waiting for the GM"; GM presses Admit: the map appears. *If no:* defect against `WAIT` / `ADMITTED` handling in the player link.
- [ ] **A6 Locked table.** GM sets Locked: a new phone sees "The table is locked" with a Retry button; a phone that already joined still reconnects.

## B. Questions from design 8.1 (R1 to R10)

- [ ] **R1 WebRTC on iOS Safari from a plain `http://192.168.x.x` page.** Overlay or `/diag` shows audio mode `webrtc` for the iPhone. *If no:* the player falls back to the WebSocket path by itself (shows `ws`). Judge the fallback on the iPhone with test D; if it is not good enough, TLS mode (R8) becomes necessary for iPhones.
- [ ] **R2 Sound continues with the screen dimmed, and after a 2 minute lock, on both phones.** Leave the screen to dim for 5 minutes with sound playing (nothing audible lost), then lock for 2 minutes. *If no:* dimming must pass; for lock, document the limit, make sure the pill returns to "Tap to hear the music", and add the hint "turn off auto-lock" to the player UI.
- [ ] **R3 `jitterBufferTarget` exists on Safari and Android WebView** (`caps.jbt` is true in the overlay). *If no:* the WebRTC buffer is shallower than the old 750 ms; use the fallback path (deeper buffer) when the stall statistics are bad, or accept short dropouts after stalls longer than 300 ms. The policy module decides from measured concealment; record the numbers.
- [ ] **R4 Windows firewall lets inbound UDP reach the GM browser** (a phone connects over WebRTC, not only over the fallback). *If no:* add a program-scoped UDP rule for the browser to `ENABLE-LAN.ps1` behind a prompt; sound works on the fallback meanwhile.
- [ ] **R5 Candidate rewriting works on the phones' browsers** (ICE reaches `connected` within 6 s; the overlay shows `webrtc`, not `ws`). Tested only between two Edge pages so far. *If no:* sound uses "compatibility mode" (the WebSocket path); save the failing SDP from the overlay into the golden fixtures for `sdp.test.js` / `candidates.test.js`.
- [ ] **R6 Real Wi-Fi: how often does a stall longer than 0.8 s occur, and is the GM on Wi-Fi?** Run the table for 30 minutes with sound; read stalls and underruns per device from `/diag`. *If stalls longer than 0.8 s occur more than a few times per hour:* raise the buffer defaults (`rtcPolicy` target and the fallback `T`), and tell the GM to use Ethernet.
- [ ] **R7 Hidden-video keep-awake works on `http://` on iOS and Android** (screen does not auto-lock while sound plays and the page is visible, with auto-lock set to 30 seconds). *If no:* ask players to raise the auto-lock time; document it.
- [ ] **R8 Do the players want an opt-in HTTPS mode?** Ask them after the session. *If yes:* plan the self-signed `--tls` mode (not part of v3).
- [ ] **R9 GM tab throttled when occluded or minimised for ten minutes.** Play sound, put another window over the GM browser for 10 minutes, then minimise it for 10 minutes; listen on a phone. *If sound stops or stutters:* document "keep the GM window open (it can sit behind others)", and add a warning in the Sound panel from `document.visibilityState`.
- [ ] **R10 44.1 kHz output (and Bluetooth) does not click on the fallback path.** Pair the phone to a Bluetooth speaker, force the fallback (airplane mode off, WebRTC disabled in the overlay or an old browser), listen for clicks once per second. *If it clicks:* switch on the stateful JS resampler path by user agent.

## C. Sound while the network misbehaves

- [ ] **C1 Airplane mode for 5 seconds.** Sound comes back by itself within a few seconds; the map resumes without a full reload. *If no:* note the time to recover; check `/diag` reconnects.
- [ ] **C2 Walk out of range for 20 seconds, come back.** As C1; at most one audible hole.
- [ ] **C3 Reveal a 4 MB handout while sound plays** (on two phones at once). No dropout longer than 300 ms. *If no:* turn on asset egress pacing (`assetEgressKBps`) and re-test; record the router model.
- [ ] **C4 Two phones at once, one of them 8 m away behind a wall.** Neither affects the other's sound.
- [ ] **C5 GM wired versus GM on Wi-Fi.** Repeat C3 with the GM on Wi-Fi; note the difference.
- [ ] **C6 Tap to hear.** Fresh page: the pill says "Tap to hear the music"; after the tap it says "Sound on"; after a lock and unlock it asks again only if the sound really stopped.

## D. Fallback path on a phone

- [ ] **D1 Force the fallback** (GM presses the compatibility switch if present, or block UDP with the router's client isolation / the Windows firewall for 20 seconds). Sound continues within 8 seconds without any action.
- [ ] **D2 The fallback survives a 1 second stall** (airplane mode for 1 second): at most one short hole and the delay returns to about 1 second within 10 seconds.

## E. Network and router facts to write down

- [ ] Router model and firmware, Wi-Fi band and channel the phones used.
- [ ] Client isolation / AP isolation is off (phones can reach the GM at all).
- [ ] Multicast is not needed (the design does not depend on mDNS); note whether `.local` names resolved anyway.

## Notes (fill in)

| Item | iPhone / Safari | Android / Chrome | Notes |
|---|---|---|---|
| Model, OS, browser version | | | |
| Audio mode in the overlay (webrtc / ws) | | | |
| RTT p50 / p95 (overlay) | | | |
| Reconnects in 30 minutes | | | |
| Loss % and concealed % | | | |
| Jitter-buffer ms and underruns | | | |
| Longest audible hole | | | |
