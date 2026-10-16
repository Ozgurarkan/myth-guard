# Realm Forge - network layer rewrite: audit and design (Phase 0)

Status: design only. No source code was changed. Written 2026-10-13 from a read of all the code named in the brief, `npm test` (47 of 47 pass), and about thirty small experiments on this PC (scripts kept in the scratchpad, to be ported by WP6). Windows paths throughout.

Contents: 1 Summary and decisions - 2 Findings - 3 Threat model and security design - 4 Architecture and protocol spec - 5 Audio design - 6 Test and acceptance plan - 7 Work packages - 8 Risks and what cannot be verified without real devices.

## 1. Summary and decisions

### 1.1 In plain language

Realm Forge runs one program on the GM's computer. Phones join over the home Wi-Fi. That stays: no cloud, no relay, no tunnel.

What is wrong today, in order of how much it matters to you:

1. **Sound cuts out because of how the sound is delivered, not because of the sound itself.** Music goes to each phone over the same kind of connection that web pages use. That kind of connection must deliver every byte in order, so if the Wi-Fi hiccups for one second, everything behind the hiccup waits. The phone's player then does two bad things: it goes silent for about a second (it insists on re-filling a three-quarter-second buffer first), and it never catches up afterwards, so the music stays one to three seconds late for the rest of the evening. The same happens if the phone's screen is busy for more than a second (a big picture appearing, for example), because the sound is played by the same part of the browser that draws the screen. On phones whose speaker runs at 44.1 kHz instead of 48 kHz there is also a tiny click about once a second. I reproduced each of these with a test tone and measured it.
2. **Anyone on your Wi-Fi can join the table, and a bad web page on the GM's computer can take control of it.** There is no password or invite. A web page open in the GM's browser can trick it (a trick called DNS rebinding; I did it in a test) into acting as the GM, push its own scene to every phone and throw the real GM off.
3. **Nothing limits abuse.** One device can open hundreds of connections, flood the server with pings, or send huge messages. One test used 270 MB of memory.
4. **The map, tokens and handouts are efficient and the privacy filtering (hidden tokens, NPC hit points) is good.** Keep it. The server needs about half a millisecond to handle a scene change; a token move reaches all 8 players in about 6 ms. The speed is fine; what was missing is safety and sound.

### 1.2 Decisions

| # | Decision | Why (one line) |
|---|---|---|
| D1 | **Stay on plain HTTP/WS on the home network. No TLS in v3.** | A self-signed certificate puts a scary full-screen warning on every phone, and the IP changes with DHCP; it would cost more players than it protects. (3.3) |
| D2 | **Secure by invitation, not by encryption:** a secret in the QR code (never sent over the Wi-Fi again), per-phone keys, GM can Open / Ask first / Lock the table, Kick a device, Rotate the invite; strict Host and Origin checks; GM role needs loopback **and** a private cookie; size, rate and connection limits everywhere. (3, 4.3) | Stops strangers, other web pages and floods; honest about what stays readable to someone who can sniff the Wi-Fi. |
| D3 | **Keep the state sync design** (one filtered view, JSON patches with revisions, snapshot fallback), and add: patch history for cheap reconnects, action ids so a move is never lost or doubled, caps and validation per message type. (4.5-4.7) | Measured fast and small; no reason to change the format. |
| D4 | **Audio: WebRTC to each phone as the primary path; the existing ADPCM-over-WebSocket path, repaired, as an automatic per-listener fallback.** Opus-in-WASM over WebSocket is rejected. (5) | Measured: no dropouts at up to 10 % packet loss; with a deliberately deep buffer (800 ms) a full second of stall is inaudible; playout runs outside the phone's UI thread; works on a non-secure `http://` page; the GM PC handles 8 listeners at about 0.4 of a core. |
| D5 | **Server rewrites WebRTC candidate addresses** (the browsers hide their addresses behind random `.local` names, which depend on multicast that Wi-Fi often blocks). (5.3) | Removes the most likely reason WebRTC would silently fail on a home network. |
| D6 | **Small modules with injected clocks and fake sockets**, every module unit-tested in `npm test`; Edge-based acceptance scripts for audio and load; a real-device checklist for what cannot be automated. (4.8, 6) | Everything measurable is measured; everything else is named. |
| D7 | **Keep the UI-visible features and the guarantees of the 47 tests**; `src/broadcast.js` keeps its public API as a facade. UI changes needed by the security design are specified, not built (3.9). (4.10, 6.2) | The rewrite is behind the existing screens. |
| D8 | Three engineers, six work packages with disjoint file ownership; integration in six steps; old files are deleted only after their replacements pass. (7) | Parallel work without edit collisions. |

### 1.3 What you will notice

- The invite window shows a QR code, the address, a short table code, and three buttons (Open / Ask first / Locked), a Rotate button and a Kick button per device.
- A phone that is not invited sees a plain "Enter the table code" or "The table is locked" screen instead of connecting.
- Sound survives stalls of up to about a second without a gap, and recovers its timing by itself after longer ones.
- A debug overlay (Ctrl+Shift+D) and a status page show round-trip time, reconnects, and sound quality per player, so "why does Aria hear dropouts" can be answered.

### 1.4 What this will not do (said up front)

- It does not encrypt the Wi-Fi traffic. Someone who has your Wi-Fi password and captures traffic can read what players see. GM-only data is never sent to anyone.
- It does not hide the map under the fog from a player who opens developer tools (the image is shared whole).
- It cannot hide a Wi-Fi outage longer than the audio buffer (about 0.8-2 s). It makes shorter ones inaudible and longer ones recover quickly.
- It has not been tried on a real phone. iOS Safari behaviour is the largest unknown (section 8).
## 2. Findings

Method. All code listed in the brief was read, and `npm test` was run (47 of 47 pass on 2026-10-13). Claims below are tagged **[run]** (reproduced by an experiment on this PC), **[code]** (read in the source, line numbers given) or **[model]** (follows from a model, not measured). The experiment scripts are in the scratchpad (`sec1.mjs`, `sec2.mjs`, `sec3.mjs`, `perf1.mjs`, `perf3b.mjs`, `probe1.mjs`, `oldaudio3.mjs`, `poprepro.mjs`, `webrtc1.mjs`, `webrtc8.mjs`, `tcpproxy2.mjs`, `udpproxy.mjs`) and are ported into the harness by WP6. Experiments used ports 5286-5299 only; port 5173 was never touched. Test machine: Intel i7-13700H (20 logical CPUs), Windows 11, Node 26.5, Edge 155 headless, LAN address 10.60.25.83.

One correction worth recording: the first version of my TCP impairment proxy delivered some chunks out of order and made the old audio path look as if it popped after every stall. That was a bug in the proxy, not in the product. It was found by checking the sample-level waveform (a missing 59.6-sample phase step equals one lost 4096-sample packet at 440 Hz), fixed (strict FIFO), and all audio numbers below are from the fixed proxy.

### 2.1 Security (ranked)

| Rank | Finding | Evidence | Verified how |
|---|---|---|---|
| S1 **High** | **There is no join secret.** Anyone who can reach port 5173 gets a cookie, connects as a player and receives the full player view (map URL, tokens, handouts, combat), can read every image by URL, and can listen to the sound relay. | `sessionSync.js:260-277` (the upgrade handler authenticates nothing for `player` and `audio-player`); `realmMiddleware.js:17-19` (a cookie is handed to every first-time visitor) | **[run]** `sec1.mjs` E2: connection from the LAN address, no cookie, no secret -> accepted, `HELLO PLAYER_ID GM_STATUS STATE_FULL` received; audio listener accepted |
| S2 **High** | **DNS rebinding makes a web page the GM.** `isLocal()` only checks the TCP peer address and `sameOrigin()` only compares the `Origin` host with the `Host` header, both of which an attacker controls once `evil.example` resolves to 127.0.0.1. A malicious page open in the GM's browser can then connect with `role=gm`, publish scenes (including image URLs on the internet that every phone will fetch), read the roster, upload assets, and kick the real GM (a second GM takes over with close code 4001 and the real GM's transport deliberately never reconnects). The Vite dev server has the same hole: its own host check protects only Vite's routes, not the WebSocket upgrade or this middleware. | `identity.js:13-19`; `sessionSync.js:218-219,260-266`; `assetStore.js:94,128`; `realmMiddleware.js:22-35`; `sessionTransport.js:73` | **[run]** `sec1.mjs` E1: GM role accepted with Host `evil.test:5290` + matching Origin; injected `SCENE`; `/__realm/info` 200; asset `missing` 200. `sec3.mjs`: Vite dev server returns 403 for `evil.test` on its own files but accepts the GM WebSocket. A plain cross-site Origin (not rebinding) is refused with 403, as the existing test claims. |
| S3 **Medium** | **No limits before or after authentication.** 600 sockets from one address were all accepted and cost +270 MB RSS (about 450 KB each, mostly permessage-deflate state). The `PING` handler runs before the rate limiter and has no limit: 20,000 pings returned 19,622 pongs in 1.5 s. `maxPayload` is 16 MiB for every role and the 2 KB player limit is applied after the whole frame was received and decompressed (a 12 MB frame was buffered, 18 MB RSS). | `sessionSync.js:43-48` (maxPayload 16 MiB, deflate), `:168-169` (bucket applies only inside `onPlayerMessage`), `:188-201` (`answerPings`), `:233-234` (size check after receipt); no connection counting anywhere | **[run]** `sec1.mjs` E4, E5, E6 (a 17 MiB frame was closed 1009; 12 MiB was not) |
| S4 **Medium** | **Identity is an unsigned UUID cookie.** The server accepts any UUID-shaped cookie, derives `playerId = sha256(cookie)`, and keeps no record, so identities can be invented without limit (every cookie-less socket becomes a new roster entry), cannot be revoked, and a cookie captured from plain HTTP can be replayed. There is no kick. Flags: `HttpOnly; SameSite=Strict; Max-Age=1y`, no `Secure` (impossible on HTTP). | `identity.js:7-10`; `sessionSync.js:272`; `realmMiddleware.js:18` | **[run]** `sec1.mjs` E3: client-chosen cookie `0000...0001` accepted |
| S5 **Medium** | **Audio relay has no admission and an unbounded registry.** Any LAN device can open `role=audio-player`; `devices` (a Map keyed by a client-chosen id) is never pruned, and each registration makes the relay rebuild and send the whole device list to the GM (quadratic). | `audioRelay.js:85-91` (register), `:88` (`devices.set`), `:24-33` (`count()` sends everything), `sessionSync.js:264-266` | **[code]** and the audio-listener connection was accepted in `sec1.mjs` E2 |
| S6 **Medium** | **Information in snapshots and patches: the filtering is sound where it exists.** Hidden/fogged tokens, hidden markers and NPC hit points do not reach `STATE_FULL` or patches (`playerView.js:30-69`, `combat.js:73-92` whitelist the fields), hidden token art is never uploaded (`broadcast.js:40`), and the six tests in `playerView.test.js` pass. Weak spots: (a) `areaEffects` is passed through whole (`playerView.js:61`), so any field added later leaks; (b) the **map image is shared whole, so fog is only an overlay** - a player with developer tools can see the map beneath the fog (the README promises protection for tokens, markers, notes and NPC hit points, not for the map); (c) a handout stays fetchable by anyone who saw its URL after the GM hides it. | files cited | **[code]** + `perf1.mjs` built the projection on a 30-token scene (leak test on named secrets only; a generic canary test is specified in 3.8) |
| S7 **Low-Medium** | **Plain HTTP/WS.** Anyone with the Wi-Fi password and a capture can read the public view and steal the cookie. Not fixable cheaply with TLS (3.3). | n/a | analysis |
| S8 **Low** | **Static serving is safe against traversal; headers are thin.** URLs are looked up in a precomputed Map, so `/../package.json`, `/%2e%2e/`, `/..%2f`, `/%00`, `//etc/passwd` all gave 404/400. Only `nosniff` and `no-referrer` are sent: no CSP, no frame protection, no CORP; `.webmanifest` is served as `application/octet-stream`. In `START-DEV` mode the Vite dev server serves the whole project folder (`/package.json`, `/server/sessionSync.js`, `/.backup-pre-network-rewrite/package.json` all returned 200 to a normal Host) to every LAN device. | `serve.js:16-21,66-76`; `vite.config.js:8-10` (`host: '0.0.0.0'`) | **[run]** `sec2.mjs`, `sec3.mjs` |
| S9 **Low** | **Asset store.** Reads are open to anyone with the 256-bit hash (fine as a capability, but unrevocable); eviction can drop an image the live scene references while the GM link believes it is uploaded (so phones get 404s mid-session); uploads up to 48 MiB are buffered in memory; image dimensions are not checked (a decompression bomb would hang a phone). Upload is correctly restricted to the local address and Origin (except under S2). | `assetStore.js:28,50-55,64-76,127-135`; `assetPublisher.js:65-72` | **[code]** |
| S10 **Low** | **Firewall helper opens the port on the Public profile too.** | `ENABLE-LAN.ps1:10-13` (`-Profile Any`) | **[code]** |
| S11 **Info** | **Move validation is thin for game integrity**: the destination of a move is clamped to the map but not checked against fog, speed or snapping (not a network issue; recorded for the GM-rules owner). | `sessionSync.js:122-138` | **[code]** |
| S12 **Info** | `PING` and `REQUEST_FULL_STATE` from players: a player can request a full snapshot as often as the 30/s bucket allows (about 44 KB each, 8 players x 30/s = 10 MB/s of work for the GM PC and the Wi-Fi). | `sessionSync.js:174-175` | **[code]** |

What was checked and found fine: GM and asset-upload endpoints do refuse non-loopback peers and foreign Origins (apart from S2); the asset store verifies the hash and sniffs magic bytes and never serves SVG; the response to a malformed percent-escape is a 400, not a crash; `ws` sets `TCP_NODELAY`; Node's default HTTP timeouts (headers 60 s, request 300 s) apply but there is no `maxConnections` and no per-IP view.

### 2.2 Performance

Measured on the target scene: 4096 x 4096 map, 5,000 fog cells, 30 tokens (`perf1.mjs`, `perf3b.mjs`).

| Quantity | Result |
|---|---|
| GM `SCENE` message | 63.8 KB JSON; `JSON.stringify` 34 microseconds |
| Server work per GM publish (parse + `projectForPlayers` + `diffState`) | 175 + 241 + 40-340 microseconds = **0.50 ms** |
| `STATE_FULL` | **44.6 KB** raw, **11.9 KB** deflate level 3 (what `ws` sends), 3.6 KB brotli; bitset base64 of the fog alone would be 1.1 KB |
| Patches | token move 287 B; 40-cell fog stroke 341 B |
| First publish to 8 players | 7-12 ms until all hold `STATE_FULL` |
| Token move, player sends -> all 8 players hold the patch (300 moves, one process, loopback) | p50 **3.0 ms**, p95 **5.8 ms**, p99 7.9 ms, max 16 ms |
| GM scene change -> patch at 8 players | p50 8.5 ms, p95 11.6 ms |
| Memory per connected player | 450-510 KB with deflate on (both ends in one process; roughly half is the server): permessage-deflate contexts |
| GM-side cost | `assetPublisher.js:49-50` builds the cache key `kind|src` from the whole data URL on every flush: **3.6 ms per flush** for a 6 MB map plus 30 portraits of 150 KB, i.e. about 9 % of the GM main thread while dragging at the 40 ms throttle. `flush` itself sends the whole scene (64 KB) up to 25 times a second over loopback (1.5 MB/s), harmless. |

Conclusions:
1. **The hub is not the bottleneck.** The sync design (projection + base-revision patches + snapshot fallback) is sound and small; keep it (4.7). A binary format would not change any number that matters.
2. Real risks are elsewhere: (a) no limits (S3); (b) memory per socket from compression contexts (raise per-socket cost only 8 times today, but 600 sockets cost 270 MB; the caps fix it); (c) the **Wi-Fi hop**: first load per phone = 250 KB app + map (up to 4096 px WebP, estimated 1.5-4 MB) + token art; 8 phones joining together move about 15-40 MB in a burst, which on a busy 2.4 GHz network takes 10-20 s and fills the router queue (bufferbloat), delaying everything else on the same Wi-Fi including sound. Estimated, not measured on a router. Mitigations in the design: smaller default map (3072 px), asset egress pacing while sound plays (4.9), GM on Ethernet.
3. Backpressure: `BACKLOG_STOP`/`RESUME` with a later full snapshot (`sessionSync.js:27-28,105,113-119`) is right; it lacks a time limit and does not resume from patches. Fixed by 4.5.
4. Heartbeats are fine (4 s client ping, 15 s server ping) and reconnect back-off with jitter is good (`sessionTransport.js:76-90`). A reconnect storm of 8 phones costs 8 x 12 KB snapshots: negligible; with patch history even less.
5. Worst case for 8 players on a router: state traffic is a few KB per second; the audio stream is the only continuous load: today 8 x 0.38 Mbit/s = **3.0 Mbit/s** TCP from the GM PC (each packet crosses the air twice if the GM is on Wi-Fi); WebRTC at 96 kbit/s per player is **0.77 Mbit/s** (measured 285 kbit/s total for 8 with a synthetic source because the encoder is VBR).

### 2.3 Sound cut-offs: root causes, ranked

How the old pipeline works: the GM's AudioWorklet cuts 4096-frame packets (85 ms) and ADPCM-encodes them (`pcm-processor.js:6-22`); the GM page sends them over a WebSocket to the server (`broadcastAudio.js:90`); the relay forwards them to every selected, listening socket (`audioRelay.js:55-66`); each phone decodes on the **main thread** in the WebSocket handler and schedules one `AudioBufferSourceNode` per packet (`receiveAudio.js:51-66`) through `PlaybackTimeline` (`playbackTimeline.js:9-25`): start 0.75 s after the first packet, never shrink, grow by 0.15 s up to 1.5 s on every underrun, correct clock drift with `playbackRate` 1.005/0.995, drop packets only when more than 3 s are queued.

Measured with a sine wave sent through the real server and the real player page (headless Edge, AudioWorklet tap that sees every output sample), with a strict-FIFO TCP proxy in between (`oldaudio3.mjs`, 30 s per profile, 48 kHz context unless stated). A **dropout** is digital silence >= 10 ms.

| Profile | Dropouts | Silence | Latency start -> end | Notes |
|---|---|---|---|---|
| clean | 0 | 0 | 764 -> 764 ms | |
| jitter 5 + 0-40 ms | 0 | 0 | 784 -> 785 | |
| TCP loss 1 % / 3 % / 6 % (14 / 29 / 60 recovery stalls of 300 ms+) | 0 / 0 / 0 | 0 | unchanged | the 0.75 s buffer absorbs ordinary retransmission stalls |
| hold 300 ms / 700 ms | 0 / 0 | 0 | unchanged | |
| **hold 1000 ms** | **1** | **902 ms** | **770 -> 1760** | one second of stall costs 0.9 s of silence *and* +1 s of delay for the rest of the session |
| **hold 3000 ms** | **1** | **902 ms** | **772 -> 3812** | 3 s late from then on; 11 packets were thrown away later |
| **mixed Wi-Fi** (jitter, stalls 250-700 ms, one 1300 ms stall) | **1** | **901 ms** | **797 -> 2165** | |
| **player main thread frozen 500 / 1200 / 2500 ms** (busy loop in the page) | 0 / **1** / **1** | 0 / **1315** / **2627 ms** | 776 -> 774 / **2035** / **3343** | |
| AudioContext at 44.1 kHz, clean network | 0 | 0 | | **18 discontinuities in 15 s** (one-sample drops to zero at peaks, jump 0.5) |
| AudioContext at 32 kHz (`poprepro.mjs`) | 0 | 0 | | 28 discontinuities in 12 s; 48 kHz and 96 kHz contexts: 0 |
| `playbackRate` flipping 1.005/0.995 every packet, 48 kHz | | | | **0 discontinuities** (so the drift trick is not what clicks) |

Ranking, most likely first (likelihood on a real Wi-Fi is judged from the mechanism; the effects were measured, the frequency of the triggers on the user's network was not):

1. **Any stall longer than the buffer becomes a ~1 second hole and then permanently delays the sound (high likelihood).** Cause: TCP head-of-line blocking (one lost or delayed segment holds back everything behind it), a low-rate stream that cannot use fast retransmit (about 35 segments a second), and the playout policy. After an underrun the timeline waits for a fresh `target` of silence-then-sound (`playbackTimeline.js:9-16`), keeps the old backlog instead of skipping to live (the TCP burst arrives and is played in full), and shrinks its delay only by a 0.5 % speed change (`:21`), which takes minutes. Triggers on a home network: phone Wi-Fi power-save and doze, roaming between access points, channel changes, 2.4 GHz interference, router bufferbloat when 8 phones download a map or handout, a GM PC on Wi-Fi competing with itself. **Evidence: the table above.** Stalls shorter than 0.75 s are invisible; the first one longer is audible and sticky.
2. **The phone's UI thread starves the player (high on cheap phones).** Decoding and scheduling happen in the WebSocket handler on the same thread that runs React and Konva (`receiveAudio.js:51-66`). A freeze of 1.2 s (a 4096 px image decode, a big fog redraw, GC, a background tab waking) produced a 1.3 s hole and +1.3 s of permanent delay; 500 ms was harmless. The symptom would be "sound cuts when something changes on the map or when a handout opens". **Evidence: the jank rows.** AudioWorklet cannot be used to move this off the main thread because it does not exist on the phones' `http://` origin (section 3.5). WebRTC removes the problem (decode and jitter buffer run in the browser's native audio stack).
3. **Phone output not at 48 kHz (medium, device-dependent).** `new AudioContext({ latencyHint: 'interactive' })` (`receiveAudio.js:73`) adopts the device rate, while packets are 48 kHz buffers. At 44.1 or 32 kHz every packet boundary is slightly off a whole sample and drops a sample: 18 clicks per 15 s at 44.1 kHz, in a perfectly clean network. Many Bluetooth routes, older iPhones and some laptops run at 44.1 kHz. **Evidence: measured; Safari not tested.** Cheap fix (pin the context to 48 kHz or resample statefully).
4. **Large downloads share the same Wi-Fi (medium, model).** A map or handout reveal sends megabytes to every phone at once with no pacing; on cheap routers this inflates delay to seconds, which feeds cause 1. Not measured on a router.
5. **The relay lets a congested listener fall 10 seconds behind (code).** `MAX_BACKLOG = 512 KB` (`audioRelay.js:6,64`) is about 116 packets, which is 9.9 s of audio at 4.4 KB per packet. After a long stall the phone receives a burst of old sound, and the receiver then drops the *newest* packets when more than 3 s are queued (`playbackTimeline.js:19`; 11 packets were lost in the 3 s hold test), so the sound jumps. No sequence numbers exist in the packet (`pcm.js:84-117`), so nobody can detect the loss, measure jitter, or skip stale audio.
6. **iOS/Android suspend and lock (medium, device behaviour, not measured).** `onBinary` silently drops packets while the context is not `running` (`receiveAudio.js:52`); iOS moves the context to `suspended`/`interrupted` on lock or when another app takes audio and needs a user gesture to resume; the wake-lock API does not exist on `http://` (section 3.5), so Android and iOS auto-lock the screen after their normal timeout. Screen *dimming* alone is harmless; screen *lock* ends the sound until the player taps again. The UI already shows "Tap to hear the music" (`PlayerApp.jsx:50-56`).
7. **GM side (low-medium).** Capture, worklet and send are fine in principle (`broadcastAudio.js:51-106`). Risks: the GM tab must stay alive (a hidden or frozen GM tab stops capture; not tested); worklet-to-main-thread-to-socket hops add jitter that the receiver's buffer absorbs; sending is on the same main thread as the GM's React/Konva work.
8. **Not a cause:** ADPCM quality (clean: error < 0.004 of full scale on a 440 Hz sine), packet independence (good design), `TCP_NODELAY`, ordinary packet loss on TCP up to 6 % (absorbed by the buffer), the drift-correction `playbackRate` (0 discontinuities).

Verified behaviour on a non-secure origin: the player never uses `AudioWorklet`; `context.audioWorklet` is `undefined` on `http://10.60.25.83` (probe) and the old player still scheduled all packets and played (`oldaudio.mjs` ran on that origin). On such an origin `getDisplayMedia`, WebCodecs and `crypto.subtle` are also absent, which constrains the design (3.5).

Also found: `scripts/check-audio-browser.mjs` cannot pass any more - it looks for 'Stop Audio', 'Mute Player Audio' and '1 player device listening', none of which exist in the UI (`SoundPanel.jsx:17,24`); it also only checks *scheduled* gaps, not what comes out of the speakers.
## 3. Threat model and security design

### 3.1 What we protect, and from whom

Protected, in order of importance: (1) the GM's control of the table (nobody but the GM publishes scenes, uploads images, or becomes GM); (2) GM-only information (hidden tokens, exact NPC hit points, notes) never leaves the GM's computer in any message; (3) the table's availability during a session; (4) the privacy of what players see (maps and handouts are for the people invited, not everyone on the Wi-Fi); (5) the players' devices (the app must not make a phone fetch arbitrary URLs or load attacker content).

| Attacker | Capability | Realistic? |
|---|---|---|
| A. Guest on the Wi-Fi | can reach `GM-IP:5173`, can scan ports, can sniff if they know the Wi-Fi password and capture the WPA handshake | yes (the brief's main case) |
| B. Compromised IoT device / other phone on the LAN | can reach the port, scripted, no sniffing | yes |
| C. Malicious web page open in the GM's browser (ad, link from chat) | can make the GM's browser send requests to `localhost:5173` and, with DNS rebinding, to be treated as same-origin | yes, and the most dangerous (owns the GM role) |
| D. Malicious page open in a player's phone | can reach `GM-IP:5173` from the phone; cannot read cookies of other sites | possible |
| E. Another local user/process on the GM PC | already inside the trust boundary | out of scope (documented) |
| F. Person with the Wi-Fi password who can capture and decrypt others' traffic or ARP-spoof | passive eavesdropping, active MITM | rare; see 3.3 |

### 3.2 Findings versus controls (each control has a test in 6.3)

| # | Today (section 2.1 id) | New control |
|---|---|---|
| 1 | Anyone who reaches the port joins and sees everything (S1) | Invite secret in the QR link fragment, short code fallback, per-device key, admit/ask/locked modes, kick, rotate (4.3) |
| 2 | DNS rebinding makes a web page the GM (S2) | Strict Host allowlist (IP literal, `localhost`, own hostname) on **every** HTTP request and upgrade; Origin must equal Host and be allowed; GM needs loopback **and** the `rf-gm` HttpOnly SameSite=Strict cookie; `Origin` is required on browser upgrades |
| 3 | Cross-site WebSocket hijack: blocked today by Origin==Host for non-rebinding origins | kept and strengthened (Origin now required, plus the proof) |
| 4 | Unbounded sockets, unthrottled `PING`, 12 MB frames accepted (S4) | per-IP and global socket caps, pre-upgrade authentication, per-role `maxPayload`, per-type size and rate caps, strikes and bans (4.6) |
| 5 | Unsigned UUID cookie identity, replay by sniffing, no revocation (S5) | Server-issued signed cookie for images only; WebSocket identity proved by HMAC with a key that never crosses the wire again; revocable per device |
| 6 | Audio relay open to any LAN device, unbounded device map (S6) | audio signalling only on the authenticated control socket; the fallback audio socket uses the same upgrade authentication; listener registry bounded by the device registry |
| 7 | Asset store readable by anyone with a hash; eviction can break the live scene (S12) | cookie-gated reads, pinning, quotas, dimension limits (4.9) |
| 8 | Information leakage | Allowlist projection for every collection (not only tokens and markers), an automated "canary" test that plants a unique secret in every GM-only field and greps every byte of every frame (3.8) |
| 9 | No CSP / frame / CORP headers; dev server serves the project folder to the LAN (S9) | security headers on every response (3.7); `START-DEV.bat` binds to localhost unless `--lan` |
| 10 | Firewall rule applies to Public profile (S11) | `ENABLE-LAN.ps1` uses `-Profile Private` and prints a warning if the connection is Public |

### 3.3 TLS on a home LAN: the honest cost

What TLS would give: confidentiality and integrity on the Wi-Fi hop, and a secure context on phones. What it costs here:

- **Self-signed certificate (per IP):** every phone shows a full-page warning ("Your connection is not private" on Chrome, "This Connection Is Not Private" on Safari). The player must tap Advanced, then Proceed or Visit this website, and on iOS confirm again. The exception is kept per origin for a limited time and is lost when Safari clears state; WebSocket connections to the same origin then work. The certificate must contain the GM computer's current IP; DHCP changes the IP, which changes the certificate and the warning. A QR code cannot carry trust (browsers cannot be told to trust a fingerprint). For a casual game night this is the single most likely reason a player gives up. It also teaches players to click through certificate warnings.
- **Local certificate authority** (install a root certificate on every phone): iOS needs a profile download plus a manual trust switch in Settings, Android needs a user-CA install and shows a persistent "network may be monitored" notice; five minutes per phone, and a leaked CA key lets anyone impersonate any site to that phone. Not acceptable for guests.
- **A real domain with a public certificate** (the "Plex trick"): needs an internet service and a published private key or a DNS service. Contradicts "nothing leaves the home".

**Decision: plain HTTP/WS by default; defence in depth without TLS; TLS is not required for any player feature (3.4).** What remains unprotected, said plainly: a person who has the Wi-Fi password and actively captures traffic can read what players see (maps, visible tokens, handouts; GM-only data is never sent), and an attacker who can actively man-in-the-middle the Wi-Fi can alter it. With WPA2/WPA3 an outsider cannot do either; a guest who has the password can. An optional `--tls` mode (self-signed certificate with the fingerprint shown in the GM dialog) is deliberately **not** built in v3; it is listed in section 8 as a later add-on for people who accept the warning.

### 3.4 Is "join secret + signed cookies + replay-safe messages" the right trade-off?

- **Join secret: yes, essential.** Stops everything in rows 1, 4 (when combined with caps) and 6. Delivered by the QR code, which is the one out-of-band channel a home table has.
- **Signed cookies: yes, but only for what a cookie can do.** The cookie identifies a device to `<img>` requests (which cannot send custom headers) and is HMAC-signed by the server so it cannot be forged or minted by a stranger. It is not trusted for any action.
- **Replay-safe messages: do the cheap half.** Per-message MACs on plain HTTP would protect against an active attacker only if the key were secret from them, and the key is established over the same open network; we avoid the trap by never sending the key (it is derived from `S`, which travels by camera, not Wi-Fi) and by using a **one-time server nonce in every connection proof**, so a sniffed handshake cannot be replayed. Individual messages are not MAC'd: that would add CPU on cheap phones, complexity and a false sense of confidentiality, and a replayed move or end-turn is already harmless because the server rechecks every rule against current state and de-duplicates by action id (`aid`). Message-level encryption is out of scope.
- **Net effect:** a stranger on the LAN cannot join, cannot become GM, cannot read assets, cannot flood the GM's PC; a person who can sniff the Wi-Fi can still read the public view, but cannot join later, cannot impersonate a player by replaying a captured connection, and cannot learn the invite secret from the traffic (unless the typed short code was used within its freshness window, see 3.6).

### 3.5 Secure context: what is available where

Verified in headless Edge 155 on this PC (probe `http://10.60.25.83:5295/` versus `http://localhost:5295/`):

| API | Player phone (`http://192.168.x.x`, not secure) | GM (`http://localhost`, secure) |
|---|---|---|
| `AudioContext`, `createBufferSource`, `createScriptProcessor` | yes | yes |
| `AudioWorklet` (`audioContext.audioWorklet`) | **no** (property is `undefined`) | yes |
| `AudioDecoder` / `AudioEncoder` (WebCodecs) | **no** | yes |
| `RTCPeerConnection`, `RTCRtpReceiver.jitterBufferTarget` | **yes** (connection tested, section 5) | yes |
| `navigator.mediaDevices` / `getDisplayMedia` / `getUserMedia` | **no** | yes |
| `crypto.subtle`, `crypto.randomUUID` | **no** (`crypto.getRandomValues` yes) | yes |
| `navigator.wakeLock`, service workers, clipboard API | **no** | yes |
| `WebAssembly` | yes | yes |

Consequences for the design: players need nothing that is secure-context only. The current player audio path already avoids `AudioWorklet` (it schedules `AudioBufferSourceNode`s on the main thread), which is why it works on `http://192.168.x.x`; the new primary path (WebRTC into an `<audio>` element) and the fallback path (same scheduling idea with a proper scheduler) also work there. The GM must use `http://localhost:5173` (the README already says so); opening the GM screen through the LAN IP disables screen-audio capture, and the launcher should say so. HMAC on phones must not use `crypto.subtle` (4.3). Keeping the phone screen awake cannot use the Wake Lock API on plain HTTP; the audio package uses the hidden-video technique (5.7).

### 3.6 Join and invite design details

- The invite dialog shows: the QR code of `http://<ip>:5173/player.html#join=<S>`, the address and the 8-character code, three buttons (Lock the table / Ask before admitting / Open), "Rotate invite" and the live device list with Kick. The default is `open` (anyone holding the invite secret is admitted, up to the device cap); a GM who wants more control presses Ask first or Locked.
- **Short code freshness:** the code is accepted only from the moment the invite dialog is open until 10 minutes after the dialog closes (or until rotation). Wrong codes count as failed proofs: 5 per IP per minute, then a 5-minute ban for that IP; globally 30 per minute, after which the table auto-locks and the GM sees "Someone is guessing the code. The table is locked." This bounds online guessing of a 40-bit code to a negligible probability; it does not protect against someone who recorded the typed-code handshake and works offline during the freshness window. That is the price of typing instead of scanning, and the QR path has no such limit.
- **Rejoining:** a phone that already holds `dk` needs nothing: reload, wake from sleep, switch tab, server restart. A phone that lost its storage (private mode, cleared data) is a new device and needs the invite again. Private-browsing tabs therefore join per session; the UI says so.
- **Device cap:** 16 admitted devices, 4 pending; a 17th is refused with "The table is full" (GM can raise the cap in `table.json`).
- **Names** are display labels only: never identity, never trusted.

### 3.7 HTTP hardening list

- Host allowlist on every request; wrong Host: `421 Misdirected Request` with an empty body.
- Static files: keep the precomputed Map lookup (verified immune to traversal: `/../package.json`, `/%2e%2e/`, `/..%2f`, `/%00` all 404/400 in section 2.1). Add `.webmanifest` to the MIME table (currently served as `application/octet-stream`).
- Headers on every response: `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY` (and `frame-ancestors 'none'`), `Cross-Origin-Resource-Policy: same-origin`, `Permissions-Policy: camera=(), microphone=(), geolocation=(), display-capture=(self)` (the GM page needs display capture; the player page does not, so the player page gets `display-capture=()`), `Cache-Control` as today.
- **CSP**, delivered as `Content-Security-Policy-Report-Only` first, enforced after the browser check passes: `default-src 'self'; script-src 'self' 'sha256-<hash of the one inline script in player.html, computed at server start>'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob: mediastream:; connect-src 'self' ws://$host wss://$host; worker-src 'self' blob:; frame-src 'self' blob:; object-src blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`. (`frame-src`/`object-src blob:` exist because character-sheet PDFs are shown from blob URLs; verify against `SheetsPanel`/`SheetViewer` before enforcing.)
- HTTP server limits listed in 4.4. `SameSite=Strict; HttpOnly` cookies, `Max-Age` one year (devices) / session (GM).
- `ENABLE-LAN.ps1`: `-Profile Private`; refuses with a message when the active profile is Public; no UDP rule is added (WebRTC media flows after the GM's own outbound connectivity checks create the return path; if a real home test shows the Windows firewall blocking it, the script gains a per-program UDP rule for the browser used by the GM, behind a prompt).
- `START-DEV.bat`: Vite dev server binds `127.0.0.1` unless started with `--lan` (the dev server serves the entire project folder, including `server/`, `package.json` and the `.backup-*` folders, to anyone on the LAN today: verified, section 2.1).

### 3.8 Information-flow rules for GM-only data

1. Everything a player can ever receive is produced by `projectForPlayers` (allowlist per collection; unknown fields dropped). `areaEffects` is added to the allowlist; `markers`, `tokens`, `combat` already are.
2. A frame to a player is only ever built from the **projected** state, a patch of projected states, or a message in the player catalogue (4.6). The hub has no code path that serialises the raw scene toward a player; the raw scene object lives only inside `stateSync.js` and `actions.js`.
3. Hidden tokens' art is never uploaded (already true in `buildScene`) and assets are readable only by admitted devices.
4. **Canary test** (6.3): a scene in which every GM-only field of every collection holds a unique marker string (`CANARY-<field>`) and a fogged/hidden token and NPC hit points, run through: first snapshot, a patch after each kind of edit, reveal then hide, a reconnect snapshot, a resumed patch sequence, a MAP_PING, and the roster. The test captures **every byte** sent to a player socket and asserts none contains `CANARY`, a hidden token's id or name, or an NPC's numeric hit points.
5. Known design limit, to be said in the README: fog of war is an overlay. The map image itself is shared whole, so a player who opens the browser's developer tools can look at the map beneath the fog (the README already promises protection for tokens, markers, notes and NPC hit points only). Real fog protection needs tiled, per-player masked images and is outside this rewrite; it is listed in section 8.

### 3.9 UI changes the security design needs (specification only; the UI team owns the work)

GM side:
1. **Invite dialog** (`src/gm/SessionDialog.jsx`): add the 8-character table code next to the address, the QR of the new `#join=` link, a three-way control **Open / Ask first / Locked**, **Rotate invite** (confirm dialog: "Old QR codes stop working. Players already at the table stay."), and a note "Open this screen from http://localhost:5173 to share PC sound" when the GM page is not on localhost.
2. **At the table** list (same dialog and `TablePanel`): per device a **Kick** button (confirm), **Rename**, "online/offline", RTT, and a small audio status chip (WebRTC / fallback / off). Offline devices stay listed (they can return) with **Forget** to remove them.
3. **Join request toast/card** in `Ask first` mode: "Thorin (iPhone / Safari, 192.168.1.42) wants to join" with **Admit** and **Deny**; auto-deny after 5 minutes.
4. **Header pill** turns amber with a count when requests are pending and shows a lock icon when the table is locked.
5. **Debug overlay** toggle (`Ctrl+Shift+D`) (4.12).
6. **Sound panel:** per-player rows show the audio mode and quality chip; text changes to "devices listening" is kept; an error line when the GM page is not a secure context.

Player side:
7. **Join gate** (`src/player/JoinGate.jsx`): when there is no `#join=` fragment and the device is not yet a member, show a single field "Table code" (auto-uppercase, 8 characters, no ambiguous letters) above the name field; otherwise only the name as today.
8. Screens for **Waiting for the GM to let you in**, **The table is locked** (with a Retry button), **You were removed from this table** (no auto-reconnect), **This table is full**, **This page is out of date - Reload** (close 4004).
9. The existing **connection chip** gains the tooltip text "Connection: 23 ms, 0 reconnects" and, with the debug overlay on, the extra counters.
10. The **"Tap to hear the music" pill** stays; after the first tap it becomes "Sound on" with a small quality dot (green/amber/red from loss and concealed percentage). A one-time notice explains that the screen is kept awake while sound is on.

### 3.10 Residual risks (accepted, listed so nobody is surprised)

Passive reading of the public view by someone who can decrypt the Wi-Fi; an active MITM on a network where the attacker knows the Wi-Fi password; shoulder-surfing of the typed code; another local OS user on the GM PC; a player who screenshots the map; a player who inspects the map beneath fog (3.8, point 5); a stolen unlocked phone of an admitted player (the GM can Kick it).
## 4. Architecture and protocol spec

This section is the contract the work packages in section 7 are built against. Where it says MUST, a test in section 6 enforces it.

### 4.1 Shape of the system

```
 GM browser (http://localhost:5173, secure context)          Phones / tablets (http://192.168.x.y:5173, NOT secure)
 +------------------------------------------+                 +----------------------------------------+
 | App.jsx, store.jsx (the scene lives here) |                 | PlayerApp.jsx                          |
 | src/net/gmLink      -- SCENE ----------+  |                 | src/net/playerLink                     |
 | src/audio/rtcSender -- per-player PCs  |  |                 | src/audio/rtcReceiver  (<audio>)       |
 +----------------------------------------+--+                 | src/audio/wsReceiver   (fallback)      |
          loopback WebSocket (GM role)    |                    +-----------------^----------------------+
                                          v                                      | WebSocket (player role)
 +-----------------------------------------------------------------------------+ | + WebRTC UDP (audio, direct GM<->phone)
 | GM computer: ONE Node process (server/serve.js)                              |-+
 |  http.js -> hostGuard -> ipLimiter -> [static | assets | join | hello | info | status]
 |  hub.js  -> session.js (one per socket) -> validate.js -> stateSync / actions / roster / audioSignal
 |  tableStore.js (table.json: server secret, invite, device registry)  status.js (metrics, log ring)
 +-----------------------------------------------------------------------------+
```

Decisions that shape everything else:

1. One authenticated WebSocket per browser window for control and state (`/__realm/ws`). No unauthenticated WebSocket is ever created: authentication happens inside the HTTP upgrade (4.3), so a stranger costs one rejected HTTP request, not a socket with zlib buffers.
2. Audio does not share that socket. Primary: WebRTC (GM page to each phone, UDP, signalled over the control socket). Fallback: a separate binary WebSocket (`/__realm/audio`) so audio and state never block each other.
3. The GM's browser still owns the scene (as today). The server holds the player-facing copy and answers every join, reconnect and resync without bothering the GM (this behaviour is covered by tests today and stays).
4. State sync keeps the current idea and format: one server-side projection of the scene, `diffState` patches with a base revision, full snapshot as the fallback. New: a patch history so a phone that blinks for two seconds gets two small patches instead of a snapshot, and idempotent action ids so a move sent just before a drop is neither lost nor applied twice.
5. Everything is small modules with injected clocks and fake sockets, so `npm test` covers them without a browser.

### 4.2 Constants shared by server and clients (`src/net/protocol.js`, owned by WP1)

```js
export const PROTOCOL_VERSION = 3;                  // v2 is the current code; v3 clients and servers refuse each other with close 4004
export const PATHS = {
  ws: '/__realm/ws',            // control + state (query: role=player|gm)
  audioWs: '/__realm/audio',    // fallback audio, binary frames only (query: role=player|gm)
  hello: '/__realm/hello',      // POST: get a one-time nonce
  join: '/__realm/join',        // POST: first-time admission
  info: '/__realm/info',        // GET (GM only): addresses, invite link, code, mode, counts
  status: '/__realm/status',    // GET (loopback): { app, version } only - used by the launcher to detect a running server
  diag: '/__realm/diag',        // GET (GM only): full metrics JSON;  /__realm/diag/log -> last 500 log lines
  assets: '/__realm/assets/',   // GET <sha256> | PUT <sha256> | POST missing
};
export const CLOSE = {          // WebSocket close codes (4000-4999 are application codes)
  REPLACED: 4001,    // another GM window took over (this window must NOT auto-reconnect)
  KICKED: 4002,      // GM removed this device (do not auto-reconnect; show "removed" screen)
  NOT_ADMITTED: 4003,// table locked, or admission denied
  TOO_OLD: 4004,     // protocol mismatch: reload the page (do not auto-reconnect)
  ABUSE: 4008,       // rate/size limits exceeded repeatedly (client backs off 30 s)
  SLOW: 4009,        // could not drain its queue for 10 s; reconnect and resume
  SHUTDOWN: 4010,    // server stopping; reconnect with backoff
  AUTH: 4011,        // proof invalid or nonce stale (client fetches a new nonce and retries once)
};
export const LIMITS = {                              // see 4.7 for the per-type table
  maxSocketsTotal: 48, maxSocketsPerIp: 8, maxAdmittedDevices: 16, maxPendingDevices: 4,
  playerMaxPayload: 16 * 1024, gmMaxPayload: 8 * 1024 * 1024, audioMaxPayload: 16 * 1024,
  helloPerIpPerMin: 60, joinPerIpPerMin: 12, failedProofsBeforeBan: 5, banMs: 5 * 60 * 1000,
  heartbeatMs: 4000, silenceMs: 12000, serverPingMs: 15000, serverDeadMs: 30000,
  patchHistory: 64, backlogStopBytes: 256 * 1024, backlogResumeBytes: 64 * 1024, slowCloseMs: 10000,
};
```

### 4.3 Identity, invite and admission (what makes it "secure")

Terms: `S` = invite secret (16 random bytes, shown only in the QR link fragment); `C` = table code (8 characters, alphabet `ABCDEFGHJKMNPQRSTUVWXYZ23456789`, shown beside the QR); `device` = 16 random bytes generated by the phone and kept in `localStorage`; `dk` = 32-byte per-device key, derived during join and kept in `localStorage` and in `table.json`; `serverSecret` = 32 random bytes in `table.json`, never sent anywhere.

HMAC is HMAC-SHA256. Phones are not in a secure context, so `crypto.subtle` does not exist there (verified, section 2); the shared module `src/net/hmac.js` uses `@noble/hashes` (pure JS, bundled at build time) on both sides and is tested against `node:crypto`.

**Invite link:** `http://<lan-ip>:5173/player.html#join=<S as base64url>`. The part after `#` is never sent to the server, never appears in logs or Referer. The page reads it, stores it in `sessionStorage`, and removes it from the address bar with `history.replaceState`.

**First join** (`POST /__realm/join`, JSON, <= 512 bytes, public but rate-limited):

```
client -> { v:3, device, name, nonce:<16 random bytes hex>, how:'link'|'code',
            proof: HMAC(key, "rf3-join\0" + device + "\0" + nonce) }       key = S  (how:'link')   or   key = "code:" + normalized C  (how:'code')
server  -> checks: Host allowed; per-IP join limit; table not locked; proof valid for the current invite; device count < max
server  <- 200 { status:'admitted'|'pending', srv:<16 random bytes hex>,
                 srvProof: HMAC(key, "rf3-srv\0" + device + "\0" + nonce + "\0" + srv) }
           + Set-Cookie: rf-d=<device>.<HMAC(serverSecret,"cookie\0"+device) first 16 bytes hex>; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000
           errors: 403 {error:'bad-proof'|'locked'|'full'|'banned'} (generic body, same timing), 429 rate limit
client  -> verifies srvProof (this proves the table knows S, so a stranger's access point or a rogue server cannot harvest the device key)
both    -> dk = HMAC(key, "rf3-dk\0" + device + "\0" + nonce + "\0" + srv)
```

Why this shape: after join, `S` and `dk` never travel on the network again; a sniffer sees nonces and MACs only. The QR code is an out-of-band channel (the phone camera reads it from the GM's screen), which plain HTTP cannot otherwise provide. Typing the short code is the weaker path (40 bits): it is protected against guessing by rate limits and against a passive sniffer only while the code is fresh (the code auto-rotates 10 minutes after first use and on any lock/unlock). Section 3.6 states this plainly.

**Every connection** (reconnects, new tabs, after a server restart because `table.json` persists):

```
1. client POST /__realm/hello { device }              -> { nonce:<16 bytes hex>, ttl:15 }     (one-time, 15 s, server keeps <= 256 live nonces)
2. client opens  new WebSocket(url + '?role=player', ['rf3', 'auth.' + device + '.' + nonce + '.' + proof])
                 proof = HMAC(dk, "rf3-ws\0" + device + "\0" + nonce + "\0" + role)
3. server (HTTP upgrade handler, before any WebSocket exists):
     Host allowed? Origin == Host and allowed (REQUIRED for browsers; missing Origin is refused)? per-IP socket cap? total cap?
     nonce live and unused (consume it)? device known and not revoked? proof matches (constant-time)?
     role=gm additionally: remote address is loopback AND cookie rf-gm valid AND Host is localhost/127.0.0.1/[::1]
     -> else 'HTTP/1.1 4xx' with no body, counted in metrics, strikes against the IP.
   selects subprotocol 'rf3' (the auth.* token is not echoed).
4. server -> HELLO; client -> RESUME; server sends state (4.5)
```

The GM page gets its credential differently: the first `GET /` or `/index.html` from a loopback address with an allowed Host sets `rf-gm=<32 random bytes hex>` (HttpOnly, SameSite=Strict). The GM socket must present that cookie. The key lives only in server memory (regenerated per server start), so a restart simply makes the GM page reload once.

**Admission modes** (GM chooses; stored in `table.json`):

| mode | new device with a valid invite | known device |
|---|---|---|
| `open` (default) | admitted at once | reconnects |
| `ask` | `pending`: the phone shows "Waiting for the GM", the GM sees a request (name, device label, address) and taps Admit or Deny | reconnects |
| `locked` | refused (`403 locked`; phone shows "The table is locked") | reconnects |

Other GM actions (all via GM-socket commands, section 4.6): **Kick** (device revoked: `dk` deleted, sockets closed 4002, cannot rejoin with the same device id; the person can rejoin only with a new device id and a valid invite, so rotate first), **Rotate invite** (new `S` and `C`; old QR codes die; admitted devices are unaffected), **Lock/Unlock**, **Rename** (display name).

`playerId` (the id other players see in `ownerId`, pings and the roster) is `hex(HMAC(serverSecret,"pid\0"+device))` first 12 bytes: stable across reconnects and restarts, not derivable from anything a stranger can see.

### 4.4 HTTP surface

| Route | Who | Notes |
|---|---|---|
| `GET /`, `/index.html` | loopback + allowed Host: GM app and sets `rf-gm`. Others: 302 to `/player.html` | as today |
| `GET /player.html`, `/assets/*`, other static | anyone with an allowed Host | precomputed in-memory map (as today); adds CSP and security headers (3.7) |
| `POST /__realm/hello`, `POST /__realm/join` | anyone with an allowed Host | per-IP limits; bodies <= 512 B; JSON only |
| `GET /__realm/assets/<sha256>` | admitted device cookie `rf-d` valid and not revoked, or GM | `Cache-Control: private, max-age=31536000, immutable`; ETag; `Cross-Origin-Resource-Policy: same-origin`; `Content-Security-Policy: default-src 'none'; sandbox`; per-IP 404 limiter |
| `PUT /__realm/assets/<sha256>`, `POST /__realm/assets/missing` | GM only (loopback + `rf-gm` + Origin + `X-RF: 1` header) | quotas in 4.9 |
| `GET /__realm/info` | GM only | addresses, `joinUrl` per address (with `#join=S`), `code`, mode, locked, device list, image counts |
| `GET /__realm/status` | loopback | `{ app:'realm-forge', version:3 }` (unchanged shape; the launcher depends on it) |
| `GET /__realm/diag`, `/__realm/diag/log` | GM only | 4.12 |
| anything else under `/__realm/` | 404 | |
| `/session-sync` (v2 WebSocket path) | answers `426` with the text "Realm Forge was updated. Reload this page." so a phone with a cached v2 page fails visibly, not silently | WP3 |

The HTTP server is created with `headersTimeout 10 s`, `requestTimeout 30 s`, `keepAliveTimeout 5 s`, `maxHeaderSize 8 KB`, `maxConnections 200`, and `socket.setKeepAlive(true, 10000)` on accepted sockets.

### 4.5 Control WebSocket: lifecycle, resume, sequence numbers

All frames are JSON text unless stated; binary frames on the control socket are a protocol error (close 1003). Envelope: `{ "type": "<NAME>", ... }` (same `type` field as today).

```
client                                   server
  |<-------------- HELLO {v:3, role, playerId, name, rev, server:{id,started}, limits:{maxScene,...}}
  |--- RESUME {rev:<last applied rev|null>, aids:[<unacked action ids>]} -->|     (server waits <= 2 s for it, then behaves as rev:null)
  |<-------------- GM_STATUS {connected}
  |<-------------- STATE_FULL {rev, state}                          if rev:null, or rev older than the patch history, or > 16 patches behind
  |<-------------- STATE_PATCH {rev, base, patch} x n              otherwise: the missing patches, in order (pre-serialised strings)
  |<-------------- ACK {aid, ok, reason?} for each aid the server already processed (idempotent replay: never applied twice)
  |--- PING {t, rtt, loss?, rec?} every 4 s ------------------>|<- PONG {t, s:<server ms>}
```

- `rev` is a server counter that increases by one for every change of the player view (as today: no change, no new rev).
- Patch history: the last 64 patches (`{rev, text}`) per table, kept as strings. A client that is exactly current gets nothing; one that is behind gets patches; otherwise a snapshot. Backlog policy as today: past `backlogStopBytes` queued the socket is marked stale and gets one snapshot after it drains below `backlogResumeBytes`; if it cannot drain for `slowCloseMs` it is closed with 4009 (the client reconnects and resumes).
- Actions that change the table (`PLAYER_TOKEN_MOVE`, `PLAYER_END_TURN`) carry `aid` (client counter, monotonic per device, persisted in `sessionStorage`). The server keeps the last 64 `{aid -> result}` per device. The client keeps unacked actions for 5 s and re-sends them in `RESUME.aids` after a reconnect; after 5 s it drops them and shows the rollback it already has ("move did not reach the table"). Result messages: `ACK {aid, ok:true}` or `ACK {aid, ok:false, reason}` where reason is one of `blocked|paused|away|not-your-turn|rate|invalid`. The facade in `src/broadcast.js` converts `ACK` to the existing `onMoveRejected({id, reason})` / `onTurnRejected({reason})` callbacks so no UI code changes.
- Ephemeral messages (`MAP_PING`) have no sequence and no replay: a ping lost in a reconnect is simply lost. `GM_STATUS`, roster and audio status are re-sent in full at every HELLO.
- Heartbeat: client `PING` every `heartbeatMs`, abandon the socket after `silenceMs` without any frame; server `ws.ping()` every `serverPingMs`, terminate after `serverDeadMs` without a pong or any frame. Reconnect backoff: 0.5 s x 2^n capped at 6 s, jitter +-30 %, immediate attempt on `online`, `pageshow` and `visibilitychange` (as today). Never auto-reconnect after 4001, 4002, 4004; 4003 shows the lock screen and retries every 15 s.
- Several windows on one device: allowed (up to 3 sockets per device); the roster collapses them; actions are accepted from any of them.

### 4.6 Message catalogue with caps (bytes are of the received frame after decompression; the hub drops AND counts anything outside these)

| type | dir | max bytes | rate limit | notes |
|---|---|---|---|---|
| `PING {t, rtt?, loss?, rec?}` | P/G -> S | 96 | 5 burst, 1/s sustained | answered with `PONG`; excess dropped silently, counted |
| `RESUME {rev, aids}` | P/G -> S | 512 | once per socket | |
| `RESYNC` / `REQUEST_FULL_STATE` | P -> S | 64 | 3 burst, 1 per 2 s | at most one STATE_FULL per 2 s per socket |
| `PLAYER_NAME {name}` | P -> S | 256 | 1 per 2 s | control chars stripped, 40 chars |
| `PLAYER_TOKEN_MOVE {aid, id, x, y}` | P -> S | 192 | 30/s burst 40 (as today) | owner, visibility, fog, movement-allowed and GM-away checks as today |
| `PLAYER_PING {x, y}` | P -> S | 128 | one per 700 ms (as today) | clamped to the map; relayed as `MAP_PING` |
| `PLAYER_END_TURN {aid, tokenId}` | P -> S | 160 | duplicates within 1.5 s ignored (as today) | |
| `AUDIO_LISTEN {enabled, caps}` | P -> S | 256 | 1/s | caps = `{rtc:boolean, jbt:boolean}` |
| `AUDIO_ANSWER {sid, sdp}` | P -> S | 12288 | 3/s | server sanitises and rewrites candidates (5.4) |
| `AUDIO_STATS {sid, ...}` | P -> S | 512 | 1 per 4 s | fed to the GM and `/diag` |
| `SCENE {scene}` | G -> S | 8 MiB (config) | 60/s | coalesced: only the newest queued scene is processed |
| `AUDIO_OFFER {to, sid, sdp}` | G -> S | 12288 | 10/s | |
| `AUDIO_CONTROLS {volume, muted}`, `AUDIO_STATUS {active}`, `AUDIO_SELECT {settings[]}`, `AUDIO_FALLBACK {to, sid, reason}`, `AUDIO_STOP {to?, sid?}` | G -> S | 64 KiB for SELECT, 512 otherwise | 20/s | |
| `TABLE_CMD {op, device?, mode?, name?}` | G -> S | 512 | 10/s | ops: `kick admit deny lock unlock rotate mode rename` |
| server -> player | | | | `HELLO STATE_FULL STATE_PATCH GM_STATUS MAP_PING ACK PONG AUDIO_OFFER AUDIO_CONTROLS AUDIO_STATUS AUDIO_FALLBACK AUDIO_STOP KICKED TABLE_LOCKED WAIT ADMITTED DENIED` |
| server -> GM | | | | `HELLO REQUEST_FULL_STATE PLAYER_ROSTER {players:[{id,name,device,rtt,loss,online,admitted,audio}]} JOIN_REQUEST TABLE {mode,locked,code} PLAYER_TOKEN_MOVE PLAYER_END_TURN MAP_PING AUDIO_LISTENER AUDIO_ANSWER AUDIO_STATS` |

`ws` `maxPayload` is set per role (player 16 KiB, GM 8 MiB) by using two `WebSocketServer` instances chosen at upgrade. `perMessageDeflate`: `{ threshold: 1024, serverNoContextTakeover: true, clientNoContextTakeover: true, zlibDeflateOptions: { level: 3, memLevel: 7 }, concurrencyLimit: 2 }`, enabled only for the GM-to-player snapshot path (players' own messages are tiny and are not compressed: send `compress:false` for patches under 1 KiB).

Violation handling (`session.js`): a frame that is oversized, malformed, of unknown type, wrong direction, or over its rate limit is dropped and adds a strike. Ten strikes in 10 s close the socket with 4008 and ban the IP for 30 s. Nothing a client sends can throw: every handler runs inside `try/catch` that increments `metrics.handlerErrors` and drops the frame.

### 4.7 State sync format (kept, with reasons)

- **Server-side projection** (`projectForPlayers`, unchanged logic, moved behind an allowlist): hidden/fogged tokens, hidden markers, NPC hit points, GM-only fields never reach a player (3.8). `areaEffects` gets an allowlist too (`id,type,x,y,color,opacity,radius,width,height,angle,length,rotation` - exact list taken from `canvas/shared.jsx` at implementation time).
- **One projection for everyone today, per-class tomorrow.** `stateSync.js` takes `project(scene, viewClass)`; today there is a single class `players`. If a future feature needs per-player secrets, each distinct class costs one projection and one diff per publish (not per player). Fan-out is a plain string send per socket.
- **Format:** JSON snapshot + JSON patches `{set, coll, sets, del}` with `rev`/`base`. Measured on the target scene (4096x4096 map, 5,000 fog cells, 30 tokens): snapshot 44.6 KB raw, 11.9 KB with deflate level 3; token move patch 287 B; 40-cell fog stroke 341 B; whole hub work per GM publish 0.5 ms (section 2.2). A binary format would save at most a few KB on the one-off snapshot and cost debuggability and test simplicity; rejected. One optional change: snapshots send `fogCells` unchanged (strings `"col,row"`); if the acceptance snapshot budget is missed on a real router, WP3 may switch the snapshot only to a base64 bitset (`fog: {cols, rows, bits}` = 1.1 KB for 82x82) behind a capability flag. It is not required for v3.
- **GM -> server** keeps sending the complete scene (<= 25/s while dragging, 64 KB each, loopback only). The server coalesces: if a newer `SCENE` arrives while one is being processed, the older is discarded. This is the only place where the GM's cost is O(scene) per change; it measured 34 microseconds to stringify, so no GM-side diffing is introduced. The GM asset-key cost (3.6 ms per flush with a 6 MB data URL, section 2.2) is fixed in `assetPublisher.js` by keying on a `WeakMap`/short digest instead of the whole data URL.
- **Optimistic player moves:** unchanged. The server applies an accepted move to its own copy and publishes at once; the GM's next scene must agree, and if the GM window rejects the move it re-publishes (existing `schedule(0)` path).
- A sampled integrity check: every 50th revision the server includes `sum` (32-bit FNV-1a of the projected state JSON) in `STATE_PATCH`; a client whose own recomputation differs sends `RESYNC` and records `metrics.divergence++`. Used by the stress test and the debug overlay.

### 4.8 Server module map (each file exports one factory; each takes its collaborators and a clock as arguments)

| File | Exports | Depends on | What it does |
|---|---|---|---|
| `server/net/limits.js` | `LIMITS`, `TYPE_CAPS` re-exported from `src/net/protocol.js` | | single source of numbers |
| `server/net/clock.js` | `createClock()`, `createFakeClock()` | | `now()`, `setTimeout`, `setInterval` that tests can drive |
| `server/net/lan.js` | `lanAddresses()`, `subnetOf(ip)` | `node:os` | moved from `identity.js` |
| `server/net/hostGuard.js` | `createHostGuard({ getAddresses, hostname })` -> `{ hostAllowed(h), originAllowed(origin, host, {required}), isLoopback(addr) }` | `lan.js` | allowed Host = IP literal, `localhost`, this machine's hostname and `hostname.local`; anything else (DNS-rebinding names) refused |
| `server/net/ipLimiter.js` | `createIpLimiter(clock)` -> `{ openSocket(ip)->bool, closeSocket(ip), hit(ip, bucket)->bool, strike(ip, n), banned(ip) }`; `createBucket({capacity, perSec}, clock)` | clock | per-IP socket caps, rate buckets, bans |
| `server/net/crypto.js` | `hmac(key, ...parts)`, `randomHex(n)`, `safeEqual(a, b)`, `deriveDk(...)`, `joinProof(...)`, `srvProof(...)`, `wsProof(...)` | `src/net/hmac.js` | the only place proofs are computed (also imported by client code for symmetry) |
| `server/net/tableStore.js` | `createTableStore({ file, clock })` -> `{ load(), save(), data }` | `node:fs` | `table.json` next to the server (`.realm-data/`, git-ignored); atomic write (tmp + rename); loaded at start; corrupt file -> new table + warning |
| `server/net/devices.js` | `createDevices(store, hostGuard, clock)` -> `{ admit(), find(), revoke(), rename(), list(), playerIdOf() }` | tableStore | device registry, caps, statuses `pending|admitted|revoked` |
| `server/net/invite.js` | `createInvite(store, clock)` -> `{ current(), rotate(), verify(how, device, nonce, proof) }` | crypto | secret + code, code expiry |
| `server/net/handshake.js` | `createHandshake({ devices, invite, nonces, limiter, hostGuard, clock })` -> `{ hello(req), join(req), authenticateUpgrade(req) }` | the above | pure request->result logic (no sockets), fully unit-testable |
| `server/net/validate.js` | `validateFrame(role, text, bytes)` -> `{ ok, msg }` or `{ ok:false, code }` | `src/net/protocol.js` | JSON parse with size cap first, then type whitelist, then field checks (finite numbers, string lengths, ids matching `/^[\w-]{1,64}$/`) |
| `server/net/session.js` | `createSession({ socket, role, device, limits, clock, metrics })` | | rate bucket, strikes, backlog/stale policy, `send(text)`, byte/message counters, RTT |
| `server/net/stateSync.js` | `createStateSync({ project, diff, clock })` -> `{ setScene(scene), view, rev, attach(session, resumeRev), detach(session), publish... }` | `playerView.js`, `syncPatch.js` | projection, patch history, resume, fan-out, stale/unstick |
| `server/net/actions.js` | `moveToken(scene, device, msg, ctx)`, `endTurn(...)`, `mapPing(...)` -> `{ ack, toGm?, mutate? }` | `ownership.js` | pure rules: easy to unit-test; no sockets |
| `server/net/roster.js` | `createRoster(...)` | | merges sessions per device, RTT min, debounced `PLAYER_ROSTER` |
| `server/net/assets.js` | `createAssetStore({ maxBytes, maxAsset, pin })` | `node:crypto` | content-addressed store with pinning and quotas (4.9) |
| `server/net/http.js` | `createHttpRouter({ site, assets, handshake, status, hostGuard, limiter, hub })` | | routes in 4.4, security headers |
| `server/net/hub.js` | `createHub({ ... })` -> `{ attach(httpServer), close() }` | all above | upgrade handler, session wiring, GM slot, routing table, graceful shutdown |
| `server/net/audioSignal.js` | `createAudioSignal({ hub, devices, lan })` (WP5) | `candidates.js` | WebRTC signalling relay, listener registry, fallback decisions |
| `server/net/audioRelay.js` | `createAudioRelay(...)` (WP5) | `src/audio/pcm.js` | fallback binary relay with bounded per-listener queues (5.5) |
| `server/net/candidates.js` | `rewriteSdp(sdp, { address, role })`, `sanitizeSdp(sdp)` (WP5) | | pure SDP functions |
| `server/net/status.js` | `createMetrics(clock)` -> `{ inc(), observe(), gauge(), snapshot(), log(line), logTail() }` | | 4.12 |
| `server/net/realm.js` | `createRealm(options)` -> `{ middleware, attach, close, ... }` | everything | replaces `createRealm`/`attachSessionSync`/`sessionSyncPlugin` of `sessionSync.js`; the Vite plugin calls this |
| `server/serve.js` | `startProductionServer({ port, root, host })` | `realm.js` | static map (as today) + `realm`; same signature |

### 4.9 Asset store (access control and quotas)

- Read: admitted device cookie (or GM). Write: GM only. Hash must match the bytes; type sniffed from magic bytes (PNG, JPEG, GIF, WebP, AVIF; SVG never); additionally the header dimensions are parsed and an image whose longer side exceeds 16,384 px or area 100 MP is refused (a decompression bomb would crash a phone).
- Quotas: 24 MiB per asset (was 48), 256 MiB total (was 512), 40 uploads per minute, `POST missing` with <= 500 hashes. Over quota -> `507` with a body the GM UI shows as a toast ("Table image memory is full - remove old scenes or restart the table").
- **Pinning:** `hub` passes `pin()` = every `/__realm/assets/<hash>` string found in the current scene. A pinned asset is never evicted; eviction is LRU over unpinned assets only. If pinned assets alone exceed the quota the upload is refused instead of silently breaking the scene (today, an evicted-but-referenced image becomes a 404 on every phone while the GM's `uploaded` set says it exists - `assetStore.js:50-55` + `assetPublisher.js:65`).
- Scenes list their assets, so a server restart (which empties the store) is repaired by the existing "forgetUploads on reconnect" path in the GM link.
- Optional traffic shaping (WP2, behind `limits.assetEgressKBps`, default off): when audio is live, large asset responses are written in 64 KB chunks paced to a configurable total rate so a map reveal cannot saturate the router queue (section 2.3, cause 4).

### 4.10 Client libraries

`src/net/connection.js` (WP4) replaces `sessionTransport.js`:

```js
createConnection({ role, url, device, WebSocketClass, fetchImpl, clock, onOpen, onMessage, onStatus, onLatency, onClose, resume })
  -> { send(obj, { aid }), sendRaw(text), close(), nudge(), get open(), get latency(), get stats() }
```
Handles: hello + proof + subprotocol, heartbeat/silence detection, backoff with jitter, wake handling, RESUME with pending action ids, close-code policy (4.5), and per-connection stats `{ rtt:{last,p50,p95}, reconnects, sinceMs, bytesIn, bytesOut, patches, fulls }` for the overlay. Takes `clock`, `WebSocketClass` and `fetchImpl` so the same tests that run against the real hub also run against a fake socket.

`src/net/joinClient.js`: `joinWithLink(hash)`, `joinWithCode(code)`, `ensureJoined()`; reads and writes `src/net/deviceStore.js` (`device`, `dk`, `name`, `aidCounter`).

`src/net/gmLink.js` / `playerLink.js` hold the logic now in `broadcast.js`, and `src/broadcast.js` stays as a thin facade that re-exports the existing public API unchanged: `SCENE_KEYS`, `buildScene`, `createGMLink`, `createPlayerLink`, `broadcastState`, `subscribeGM`, `subscribePlayer`, `sendPlayerTokenMove`, `sendPlayerPing`, `sendPlayerEndTurn`, `setPlayerName`, `getPlayerName`. New optional handlers are added (never removed): GM `onJoinRequest`, `onTable`, `onAudio`; player `onKicked`, `onLocked`, `onWaiting`, `onNetStats`. `App.jsx` and `PlayerApp.jsx` keep working unmodified until the small UI changes in 3.9 are made.

### 4.11 How pings, end-turn and token moves fit

They are three ordinary message types in 4.6, validated and rate-limited by `validate.js`/`session.js`, executed by the pure functions in `actions.js` against the server's copy of the scene, and (for moves and end-turn) forwarded to the GM with the original `playerId`. Ping stays ephemeral and goes to everyone including the GM. The behaviours pinned by today's tests are kept exactly: owner-only moves, paused/fog/hidden/away refusals, clamp to map, 700 ms ping cooldown, off-map pings pulled back, NaN dropped, end-turn only for the active hero, double tap counts once, away GM refuses.

### 4.12 Observability

- `GET /__realm/diag` (GM only) returns one JSON object: `{ app, version, protocol, uptimeS, rev, gm:{connected,since}, table:{mode,locked,devices:n}, sockets:{player,gm,audio,pending}, devices:[{id,name,ip,label,online,rtt:{last,p50,p95},backlogBytes,stale,reconnects,lastSeenMs,msgsIn,msgsOut,bytesIn,bytesOut,strikes,audio:{mode:'webrtc'|'ws'|'off',state,rttMs,lossPct,concealedPct,jitterBufferMs,underruns}}], rejects:{host,origin,proof,nonce,ratelimit,ip-cap,oversize,malformed,unknown-type,banned}, assets:{count,bytes,pinned,evicted}, counters:{...}, memory:{rssMB,heapMB} }`.
- `/__realm/diag/log`: last 500 lines (connect, auth failure, kick, stale/slow, resync, divergence, audio fallback), in a ring buffer.
- Debug overlay (UI spec, 3.9): both GM and player windows toggle it with `Ctrl+Shift+D` (or `?debug=1`); shows RTT p50/p95, reconnect count, last close code, rev, patches/fulls received, and for audio: mode, loss %, concealed %, jitter-buffer ms, underruns. Players also send their audio counters to the server (`AUDIO_STATS`) so the GM can see "why does Aria hear dropouts" without touching her phone.
- The existing launcher status probe (`/__realm/status` -> `{app:'realm-forge'}`) is unchanged.

### 4.13 Graceful degradation

| Situation | Behaviour |
|---|---|
| Slow phone | patches skipped, one snapshot when it drains; closed with 4009 after 10 s stuck; other players never wait |
| GM window closed | players keep their view; moves/end-turn refused with `away`; the roster, pings and audio status continue; GM returns -> `REQUEST_FULL_STATE` |
| Second GM window | takes over; the old one is closed 4001 and does not reconnect (as today); an attacker cannot do this any more (needs `rf-gm` + loopback + Host) |
| Server restart | `table.json` keeps devices and invite, so phones reconnect on their own; the scene is re-published by the GM page; assets are re-uploaded by `forgetUploads` |
| WebRTC fails | automatic fallback to the audio WebSocket per listener (5.5) |
| Table full or locked | clear screen on the phone (3.9) instead of a spinner |
| Disk not writable | table runs in memory, `/diag` shows `persist:false`; players must rejoin after a restart |
## 5. Audio design

### 5.1 Decision

**Primary: WebRTC (candidate a).** The GM page sends the captured audio to each listening phone over its own `RTCPeerConnection`; the control WebSocket is used only for signalling; no STUN or TURN server (`iceServers: []`, host candidates only). The browser supplies Opus, FEC, loss concealment, an adaptive jitter buffer (NetEQ) and clock-drift handling, all outside the page's main thread.
**Fallback: the existing ADPCM-over-WebSocket path, hardened (candidate c)**, used per listener automatically when WebRTC is unavailable or fails.
**Rejected: Opus compressed with a WASM decoder over WebSocket (candidate b).**

Why, by evidence (all rows measured on this PC in headless Edge 155; section 5.6 has the method):

| Question | Old path (ADPCM/WebSocket) | WebRTC / Opus |
|---|---|---|
| Ordinary loss and jitter (1-10 % loss, 80 ms jitter) | fine up to 6 % *only because* 0.75 s of delay hides the retransmission stalls | **0 dropouts** at 1 %, 5 %, 10 % iid loss, 5 % burst loss (mean burst 80 ms) and 80 ms jitter; concealed 1-5 % of samples, delay 30-55 ms |
| One stall of 1.0 s | 0.9 s hole, then +1 s delay for good | default buffer: 2 holes of ~0.5 s; **with `jitterBufferTarget` 800 ms: 0 dropouts**; latency comes back by itself (NetEQ time-compresses 1.7-2.9 s of audio) |
| Mixed Wi-Fi with one 1.3 s stall | 0.9 s hole, latency 0.8 -> 2.2 s | default: one 530 ms hole; **800 ms target: one 59-65 ms hole** (two runs) |
| 3 s outage | 0.9 s hole, latency +3 s, packets dropped | default 2.5 s hole; 2 s target: 1.7 s hole - an outage longer than the buffer cannot be hidden by anyone |
| Phone UI thread frozen 1.2 s | 1.3 s hole, +1.3 s delay | not on the page's thread; unaffected |
| Phone sound card at 44.1 kHz | clicks about once per second | the browser handles rates natively |
| Bandwidth per listener | 380 kbit/s over TCP | 96 kbit/s over UDP |
| Works on a non-secure `http://` origin | yes (no worklet used) | **yes**: two pages on `http://10.60.25.83` connected and played, 457 packets, 0 lost |
| GM cost for 8 listeners | one encoder, 8 TCP sends | 8 Opus senders in one page: all 8 connected; GM renderer 19 % of one core, network service 11 %, audio service 8 % (i7-13700H) - about 0.4 of a core in total, 285 kbit/s with a synthetic source |

Why not (b): its only advantage over ADPCM is bandwidth (about 64-128 kbit/s against 380), which is not the problem on a home LAN. It would still ride TCP, so head-of-line blocking and the 1 s holes remain; it needs a WASM Opus decoder (about 150-250 KB per phone, plus a loader that must work without the Web Worker/AudioWorklet that phones lack), still needs a jitter buffer and concealment written by us, and needs WebCodecs on the GM (fine) but nothing on the phone to make it better than the browser's NetEQ. All the work of (b) is a subset of the work of the fallback in (c).

Honest limits: WebRTC does not make stalls longer than its buffer disappear; the improvement comes from (1) a loss costing 20 ms of concealment instead of a 300 ms+ TCP stall, (2) a buffer we can set deliberately large for music (800 ms default; latency does not matter for background sound), (3) recovery of the delay after a stall, and (4) playout that no longer depends on the phone's main thread. What is **not** proven here: Safari/iOS and Android Chrome behaviour, and real Wi-Fi (section 8).

### 5.2 Primary path: components

**GM page (`src/audio/rtcSender.js`)**
```
getDisplayMedia({ audio:{ echoCancellation:false, noiseSuppression:false, autoGainControl:false }, video:{ frameRate:1 }, ... })   // unchanged UX; video track disabled
 -> AudioContext({ sampleRate: 48000 }) -> MediaStreamAudioSourceNode -> GainNode (volume/mute from the GM controls)
 -> MediaStreamAudioDestinationNode -> track (contentHint = 'music')
 -> one RTCPeerConnection per listening device: pc.addTrack(track); non-trickle offer (wait for ICE gathering complete, host candidates only)
```
- The volume and mute controls act on the GainNode, so they work identically on iOS (where `HTMLMediaElement.volume` is read-only) and everywhere else; muting also sets `track.enabled = false` when every player is muted.
- Offer SDP is munged for Opus exactly as tested: `a=fmtp:<pt> minptime=10;useinbandfec=1;stereo=1;sprop-stereo=1;maxaveragebitrate=96000` (configurable 64-160 kbit/s). `src/net/sdp.js` does it and has golden-file tests.
- The fallback encoder (AudioWorklet from `pcm-processor.js`) is created only while at least one listener is on the fallback path.
- `RTCPeerConnection` state per device is tracked in `rtcPolicy.js` (pure): connection time limit 6 s, `disconnected` for more than 8 s, ICE restart once, then fallback.

**Player (`src/audio/rtcReceiver.js`)**
```
pc = new RTCPeerConnection({ iceServers: [] });  pc.ontrack -> <audio autoplay playsinline> (hidden).srcObject
receiver.jitterBufferTarget = target (feature-detected)      // target from rtcPolicy: starts 800 ms
poll getStats every 2 s: jitterBufferDelay/jitterBufferEmittedCount, concealedSamples, silentConcealedSamples, packetsLost, totalSamplesReceived
-> rtcPolicy.next(stats): target = min(2000, max(target, 1.3 * longest silent concealment seen)), decays 50 ms per minute to a floor of 500 ms
-> every 4 s send AUDIO_STATS {sid, mode, lossPct, concealedPct, jitterBufferMs, underruns}
```
`audio.play()` is called from the same tap that already unlocks audio ("Tap to hear the music"); the existing pill and `usePlayerAudio` state shape (`active, enabled, needsResume, selected, connected`) stay.

**Signalling (control WebSocket; server module `audioSignal.js`)**
```
player  AUDIO_LISTEN {enabled:true, caps:{rtc, jbt}}                       -> server -> GM  AUDIO_LISTENER {device, ready, caps}
GM      (device selected and broadcast active) AUDIO_OFFER {to, sid, sdp}  -> server rewrites candidates (5.3) -> player AUDIO_OFFER {sid, sdp}
player  AUDIO_ANSWER {sid, sdp}                                            -> server sanitises + rewrites           -> GM AUDIO_ANSWER {from, sid, sdp}
GM      pc.setRemoteDescription; state -> connected; policy decides fallback -> AUDIO_FALLBACK {to, sid, reason}
```
No trickle ICE is needed: with `iceServers: []` the host candidates are gathered instantly (measured: connected 200-215 ms after the answer).

### 5.3 The mDNS problem and how it is solved

Measured: both Edge pages reported their host candidates as random `*.local` names (mDNS obfuscation), not IP addresses. Resolving them requires multicast DNS to work between the two devices; Wi-Fi access points commonly filter or throttle multicast, iOS/Android resolution of a Windows PC's temporary name is unverified, and a failure shows up as "audio never starts" with no error. The design therefore does not depend on mDNS: **the server rewrites every host candidate.**

- Player -> GM (answer): each `a=candidate ... <name>.local <port> typ host` has its address replaced with the **player's own IP as the server sees it** on the authenticated control socket (`::ffff:` prefix removed); port and the rest are kept; every candidate that is not `typ host` and every `tcp` candidate is removed; `a=end-of-candidates` is kept.
- GM -> player (offer): the address is replaced with the GM computer's LAN address **on the same subnet as that player** (netmask match from `os.networkInterfaces()`; first LAN address if none matches).
- The sanitiser (`candidates.js`) also enforces: SDP <= 12 KiB, `v=0` first, exactly one `m=audio`, no other media, no more than 8 candidates, no public or loopback addresses from a player (the rewrite makes this moot, the check is a belt and braces), and drops any `a=sctpmap`/`m=application` (data channel) and `m=video` sections.
- Proven in the experiment: with the names replaced by `127.0.0.1` plus relay ports, ICE connected in 200-215 ms in every run (`webrtc1.mjs` does exactly this rewrite).
- Side effect: a player can only ever make the GM's browser send UDP to the player's own address.
- The GM does not need to grant microphone permission to get real IPs (the alternative that would also work in Chrome, but pops a permission prompt and does not exist on the phones).

If a phone is IPv6-only or dual-stack and the browser gathers an IPv6 host candidate, the rewrite puts the IPv4 address on a candidate that is really IPv6: that candidate pair simply fails and the IPv4 pair wins. If both fail, the fallback starts after 6 s.

Firewall: the GM's browser sends its connectivity checks outbound first (it has the player's candidate from the answer), which creates the return path on a stateful Windows firewall; incoming UDP to the browser then flows from the phone's address. This is the normal behaviour for WebRTC behind a desktop firewall and is **expected, not proven** here (no real phone). If a home test shows otherwise, `ENABLE-LAN.ps1` gets a program-scoped UDP rule behind a prompt, and in the meantime the fallback keeps sound working.

### 5.4 Fallback path: hardened WebSocket audio

Used for a listener when: its browser has no `RTCPeerConnection`; ICE does not reach `connected` within 6 s; `failed`; `disconnected` for more than 8 s after one ICE restart; or the player reports more than 3 s of silent concealment in 30 s (the fallback buffer is deeper than WebRTC's in the worst case). While on the fallback the GM tries WebRTC again every 60 s and promotes after 10 s of health.

**Wire format `RFA3`** (binary frames on `/__realm/audio`, never mixed with JSON on that socket): `magic(4) seq(u32) ts(u32 samples@48k of first frame) rate(u32) channels(u8) flags(u8) frames(u16)` + per-channel ADPCM state + data. `RFA2`/`NCGA` still decode for one release. Packets stay independent (a lost packet never corrupts the next), 4096 frames (85 ms) as today.

**Relay (`server/net/audioRelay.js`)**: authenticated like the control socket; per-listener queue of at most 8 packets (about 680 ms) **and** 64 KB of unsent bytes; on overflow the **oldest** packets are dropped (skip to live) and a `skipped` counter is sent in the next packet's flags; the queue is drained with the `send` callback so a frozen phone cannot grow memory; the GM is never blocked by a listener. The registry is bounded by the device registry (S5).

**Player playout (`src/audio/playout.js`, pure, driven by a clock argument so it is tested with a fake clock; `wsReceiver.js` wires it to a real `AudioContext`)**
- `AudioContext({ sampleRate: 48000 })`, so the browser resamples the final mix continuously (0 discontinuities measured at 48 and 96 kHz contexts; 44.1 and 32 kHz contexts clicked). If the constructor option is rejected, `playout.js` resamples to the context rate with a stateful interpolator that carries the fractional position across packets.
- Packets are placed by `seq`; duplicates and late packets are dropped; a gap in `seq` is covered with a 5 ms cross-faded repeat of the previous tail, never a click.
- Target delay `T` starts at 900 ms. It is the **only** state: after an underrun `T` grows to 1.5 x the gap that was missed (cap 2.5 s) and then decays by 10 % every 10 s of clean play (floor 500 ms). There is no ratchet.
- Underrun: 5 ms fade-out, wait until `T / 2` is buffered, 5 ms fade-in (the old code waited for the full `T`, and kept the backlog).
- Overflow (burst after a stall): when more than `T + 400 ms` is buffered, drop whole packets from the **oldest** end, with a 5 ms cross-fade at the join, until the buffer is back at `T`. Latency therefore returns to `T` as soon as the burst has arrived.
- Clock drift (GM capture clock versus phone clock): handled by the same overflow/underrun rules with hysteresis, never by `playbackRate`; drift of 100 ppm moves the buffer by 8.5 ms per 85 s, so a 10 ms slip happens about once per ten minutes.
- Decode and scheduling still run on the main thread (no worklet on `http://`): protected by the larger `T` and by scheduling the next 2 packets ahead; the measured weakness (UI freeze > T) is the reason WebRTC is primary.
- Exposes counters for the overlay: buffered ms, `T`, underruns, skipped packets, late packets.

### 5.5 Keeping sound alive on phones (screen dim, lock, background)

- **Dimming** does nothing to the page. **Locking** (power button or auto-lock) suspends or throttles pages on both platforms.
- `src/audio/keepAwake.js`, started by the same tap that enables sound: `navigator.wakeLock.request('screen')` when it exists (not on `http://`), otherwise the standard hidden-video technique: a 2x2 px, muted, looping, inline `<video>` with a tiny bundled clip (MP4 for iOS, WebM elsewhere, a few KB as data URLs built at build time). It keeps the screen from auto-locking while the page stays visible; nothing prevents a manual lock. The player UI says "Screen stays on while sound is playing".
- `navigator.mediaSession` metadata is set when the API exists, because a page with a playing media element and metadata is treated as a media app (more likely to survive backgrounding).
- On `visibilitychange`, `pageshow` and `online`: resume the `<audio>` element and the `AudioContext`, ICE-restart a `disconnected` connection, and re-run the policy.
- **Expected, to be confirmed on real devices** (section 8): iOS keeps WebRTC audio playing through an `<audio>` element with the page in the foreground and dimmed; behaviour after lock or app switch is not known to me and is on the device checklist. The design degrades visibly: the pill returns to "Tap to hear the music".

### 5.6 How this was measured (so the harness can reproduce it)

- **Source:** the GM sends a continuous 440 Hz sine at amplitude 0.5 (a Node client for the old path, an `OscillatorNode` for WebRTC).
- **Tap:** an AudioWorklet node in the receiving page sees every output sample (the page is served from `localhost` for the measurement only so that a worklet is allowed; the receiver code does not use it). It reports digital silence of at least 0.4 ms (and the dropouts counted above are >= 10 ms) and any jump greater than 0.12 between neighbouring samples (the sine's own largest step is 0.03). A 59.6-sample phase step equals one missing 4096-sample packet at 440 Hz, which is how the proxy bug was found.
- **Old path network:** a TCP proxy between the phone page and the server, strict FIFO, with delay, jitter, stalls, and a loss model in which each 1460-byte segment lost costs a 300 ms retransmission timeout (doubled when the retransmission is lost too).
- **WebRTC network:** a UDP relay: each side is told the relay's port instead of the other side's candidate, so all media passes through it. Impairments: independent loss, Gilbert-Elliott burst loss, delay and jitter (reordering allowed), blackouts with or without queueing.
- **Receiver truth for WebRTC:** `getStats()` inbound-rtp (`packetsLost`, `concealedSamples`, `silentConcealedSamples`, `jitterBufferDelay / jitterBufferEmittedCount`, `removedSamplesForAcceleration`) plus the tap.
- **Results table** (WebRTC, 30 s per profile, 96 kbit/s; "dropouts" from the tap):

| Profile | jitterBufferTarget | Dropouts (>= 10 ms) | Concealed | Avg jitter-buffer delay |
|---|---|---|---|---|
| clean | default | 0 | 0 % | 30 ms |
| loss 1 % / 5 % / 10 % | default | 0 / 0 / 0 | 1.2 / 5.1 / 1.3 % | 47 / 33 / 54 ms |
| burst loss 5 % (mean burst 4) | default | 0 (4 tiny discontinuities) | 5.3 % | 28 ms |
| jitter 5 + 0-80 ms | default | 0 | 0 % | 54 ms |
| hold 300 ms | default | 0 | 2.8 % | 102 ms |
| hold 700 ms | default | 3 x 210-230 ms | 7.4 % | 126 ms |
| hold 1000 ms | default | 2 x ~520 ms | 7.2 % | 145 ms |
| hold 1000 ms | **800 ms** | **0** | 2.0 % | 725 ms |
| blackout 400 ms (drop, no queue) | default | 0 | 4.4 % | 26 ms |
| mixed Wi-Fi | default / 400 / **800** / 800 | 1 x 530 / 1 x 415 / **1 x 59** / 1 x 65 ms | 7.7 / 4.1 / 3.4 / 2.8 % | 373 / 499 / 752 / 740 ms |
| hold 3000 ms | default / 2000 | 1 x 2530 / 1 x 1710 ms | 11 / 8 % | 530 / 1738 ms |
| two pages on `http://10.60.25.83` (non-secure), 12 s | 800 | 0 (tap unavailable; stats: 457 packets, 0 lost) | 0 % | 571 ms |

### 5.7 Tests for audio (what runs where)

`npm test` (pure, fast): `playout.test.js` (fake clock; properties: output timeline has no gap or overlap when packets arrive in bursts of 1-20 after stalls of 0-3 s; underrun recovers without growing `T` beyond 1.5 x the gap; latency returns to `T` within one burst; reordered/duplicated/late packets are ignored; `seq` wrap; 100,000 random arrivals never produce a click in the rendered output (rendered by a simple mixer model and checked with the sine analyser)); `jitter.test.js`; `rtcPolicy.test.js` (canned `getStats` sequences -> target and fallback decisions); `sdp.test.js` and `candidates.test.js` (golden SDPs captured from Edge now and from Safari and Android Chrome during the device checklist); `audioRelay.test.js` (bounded queues, skip-to-live, frozen listener); `audioSignal.test.js` (message flow with fake sessions); `pcm.test.js`.

`npm run accept` (Edge): `accept-audio-rtc.mjs` and `accept-audio-ws.mjs` run the profiles of 6.5 with the tap, plus the forced-rate runs (32, 44.1, 48, 96 kHz) and the 8-listener CPU run; the 8-listener run asserts all 8 connections reach `connected`.

### 5.8 Cannot be tested without real devices

Safari/iOS `RTCPeerConnection` on an `http://` origin (the constructor exists in Chromium on non-secure origins; Safari is unknown to me), `jitterBufferTarget` support in Safari and Android WebView, `<audio>` playback after screen lock and app switch, wake-lock fallback video on each OS, the Windows firewall for inbound UDP, multicast behaviour of the user's router, 44.1 kHz and Bluetooth routing in Safari. Each has a line in `docs/real-device-checklist.md`.

### 5.9 Audio acceptance criteria

Measured with the tap (dropout = silence >= 10 ms; discontinuity = jump > 0.12), 60 s per profile unless stated.

| Path | Profile | Pass if |
|---|---|---|
| WebRTC, `jitterBufferTarget` 800 ms | `clean`, `good`, `busy`, `bad`, `jitter80`, `stall300`, `stall700`, `stall1000`, `drop400` | 0 dropouts; discontinuities <= 1 per minute; concealed <= 8 % on `bad` |
| WebRTC | `wifi` (contains a 1.3 s stall) | <= 1 dropout, <= 300 ms; average delay <= 1.0 s |
| WebRTC | `roam` (3 s) | <= 1 dropout, <= 2.5 s; delay back to <= target + 300 ms within 15 s |
| Fallback | `clean`, `good`, `busy`, `bad`, `jitter80`, `stall300`, `stall700`, `stall1000` | 0 dropouts at `T` >= 900 ms; delay back to <= `T` + 150 ms within 10 s after a stall (today: +1 to +3 s forever) |
| Fallback | `wifi`, `roam` | <= 1 dropout of <= stall length; delay back to `T` + 150 ms within 15 s |
| Fallback | player main thread frozen 1.2 s | 0 dropouts when `T` >= 1.3 s, otherwise <= 1 dropout and recovery as above |
| Fallback | AudioContext forced to 32, 44.1, 48, 96 kHz, clean network, 120 s | 0 discontinuities, 0 dropouts |
| Both | start of broadcast to first sound on the phone | <= 2.5 s WebRTC, <= `T` + 300 ms fallback |
| Both | GM CPU with 8 listeners (WebRTC) | GM renderer <= 35 % of one core on this PC; all 8 `connected` |
| Both | ICE failure | forced by blocking UDP in the relay: fallback audible within 8 s, no GM or UI action |
## 6. Test and acceptance plan

### 6.1 What can and cannot be tested on this PC

| Can be tested here (automated, repeatable) | Cannot be tested here (needs the home Wi-Fi and real phones) |
|---|---|
| Every protocol rule, limit, handshake and security control, over real loopback sockets and with fake sockets and clocks | Real Wi-Fi behaviour: power-save, roaming, 2.4 GHz contention, router bufferbloat, multicast filtering, client isolation |
| Latency, snapshot size, memory and CPU of the server hub for 16 devices | iOS Safari and Android Chrome behaviour: `RTCPeerConnection` on `http://` origins, autoplay and "interrupted" audio states, background and lock-screen audio, `jitterBufferTarget` support, screen keep-awake tricks |
| Stalls, jitter, delay and TCP-style loss on the WebSocket path (TCP proxy with FIFO delivery) | Whether the Windows firewall on the GM's PC lets UDP media through for the browser actually used (stateful return path is expected to work; not proven) |
| UDP loss, burst loss, jitter, blackouts on the WebRTC path (UDP relay between two headless Edge pages) with real `getStats()` | Phones' audio hardware rates, Bluetooth headsets, speaker routing |
| Continuity of the delivered sound: a sample-accurate AudioWorklet tap detects holes (digital silence >= 10 ms inside a steady sine) and discontinuities (a jump > 0.12 between neighbouring samples) | Whether a listener finds a given artefact audible |
| Non-48 kHz output devices (the page is run with an `AudioContext` forced to 44.1/32/96 kHz) | Safari's handling of the same cases (Chromium behaviour is not Safari behaviour) |
| `npm test` coverage of every module | Anything involving the real GM capturing real PC audio (`getDisplayMedia` needs a human click and a real screen; the harness substitutes an oscillator) |

Rule for this document and the packages: a claim about phones is written as "expected, to be confirmed on a real device" and appears in the checklist `docs/real-device-checklist.md` with a pass/fail line.

### 6.2 `npm test`: what covers what

`npm test` runs `node --test` (all `test/**.js`). Target: all modules below covered, whole suite under 60 seconds, no browser, no network beyond loopback.

| Module / guarantee | Test file(s) | Replaces / keeps |
|---|---|---|
| protocol constants, caps, auth-protocol parsing | `protocol.test.js` | new |
| HMAC, proofs | `hmac.test.js` | new |
| Host allowlist, Origin rules | `hostGuard.test.js` | new (replaces the single "relay rejects cross-origin" test) |
| rate buckets, per-IP caps, bans | `ipLimiter.test.js` | new |
| table store persistence | `tableStore.test.js` | new |
| device registry, invite, handshake, admission modes, kick/rotate | `devices.test.js`, `invite.test.js`, `handshake.test.js` | new |
| HTTP router, static headers, traversal, GM-only endpoints | `http.test.js`, `security.http.test.js` | replaces "status and join endpoints are only for this computer" |
| asset store: sniffing, hash check, LRU, pinning, quotas, HTTP caching | `assets.test.js` | replaces `assetStore.test.js` (3 tests keep their assertions) |
| frame validation, type caps | `validate.test.js` | new |
| session: buckets, strikes, backlog/stale/slow close | `session.test.js` | new (replaces "congested player stays connected" for state) |
| state sync: projection, patches, history, resume, unstick | `stateSync.test.js`, `hub.state.test.js` | replaces sessionSync tests 1 (filtered scene), 2 (late join / reconnect), 3 (GM closes) |
| actions: moves, ping, end-turn rules | `actions.test.js` (pure), `hub.actions.test.js` (sockets) | replaces sessionSync tests 4, 5, 10, 11 |
| roster and latency | `roster.test.js` | replaces sessionSync tests 6 and 8 |
| connection: silent socket abandoned, backoff, close-code policy, latency | `connection.test.js` | replaces sessionSync test 7 |
| GM/player links, `buildScene`, facade | `gmLink.test.js`, `playerLink.test.js`, `facade.test.js` | keeps all behaviour of `broadcast.js` |
| PCM and ADPCM codecs | `pcm.test.js` | the five codec tests of `audio.test.js`, moved unchanged, plus the sequence header |
| fallback relay: opt-in, late join, reconnect, players cannot broadcast, bounded queues | `audioRelay.test.js` | replaces the two relay tests of `audio.test.js` |
| playout scheduler and jitter estimator (fake clock) | `playout.test.js`, `jitter.test.js` | replaces `playbackTimeline.test.js` (its two guarantees are kept as the first two tests) |
| SDP sanitiser/rewriter, audio signalling | `sdp.test.js`, `candidates.test.js`, `audioSignal.test.js`, `rtcPolicy.test.js` | new |
| no GM-only byte in any frame | `canary.test.js` | extends `playerView.test.js` (kept) |
| diff/patch, view projection, ownership, combat | `syncPatch.test.js`, `playerView.test.js`, `ownership.test.js`, `combat.test.js` | kept as they are |
| the harness itself | `harness.test.js` | new |

The 47 existing tests are accounted for: 11 sessionSync + 7 audio + 4 assetStore + 2 playbackTimeline are replaced by the rows above with the same guarantees (nothing is dropped without an equivalent); 6 playerView + 8 syncPatch + 1 ownership + 8 combat stay.

### 6.3 Security tests (target: at least 50 automated checks)

Each is an individual `test()` with the ID shown in its name so the list can be audited.

A. Admission and identity
1. A1 join with no proof -> 403 generic body.
2. A2 join with a wrong proof -> 403, strike recorded, same body and timing class as an unknown device.
3. A3 join with the correct link proof -> admitted; `srvProof` verifies.
4. A4 the client refuses a server whose `srvProof` is wrong (rogue server).
5. A5 table code works; five wrong codes from one IP -> that IP banned for 5 minutes (fake clock), others unaffected.
6. A6 global wrong-code flood -> table auto-locks and the GM is told.
7. A7 `locked`: new device refused, known device reconnects.
8. A8 `ask`: pending device gets `WAIT` and no state; Admit -> `ADMITTED` + state; Deny -> closed 4003.
9. A9 Kick: sockets closed 4002, key deleted, reconnect refused (`AUTH`), cookie no longer opens assets.
10. A10 Rotate: old link and code fail; admitted devices keep working.
11. A11 device cap (17th refused), pending cap (5th refused).
12. A12 a captured WebSocket handshake replayed -> refused (nonce used).
13. A13 nonce expires after 15 s (fake clock).
14. A14 a player proof cannot open the GM role.
15. A15 a WebSocket upgrade without the `auth.*` subprotocol -> refused before a socket exists.
16. A16 `table.json` survives a restart (device reconnects without the invite); a corrupt file yields a fresh table and a log line, not a crash.
17. A17 cookie with a bad MAC rejected; cookie flags are exactly `HttpOnly; SameSite=Strict; Path=/`.

B. GM role
18. B1 GM upgrade from a non-loopback address -> refused.
19. B2 GM upgrade with Host `evil.test` and a matching Origin (the DNS-rebinding case that works today) -> refused.
20. B3 GM upgrade without the `rf-gm` cookie -> refused.
21. B4 GM upgrade with a foreign Origin, and with no Origin -> refused.
22. B5 asset `PUT`, `POST missing`, `/__realm/info`, `/__realm/diag` from a LAN address or a rebinding Host -> refused (403/421).
23. B6 a second GM window replaces the first with 4001, and the first does not reconnect.
24. B7 a player cannot send `SCENE` or `TABLE_CMD` (dropped + strike), and the table is unchanged.

C. Host and Origin
25. C1 any request (static, API, upgrade) with Host not in the allowlist -> 421.
26. C2 IP literal, `localhost`, the machine hostname, `hostname.local` accepted.
27. C3 player upgrade with a foreign Origin -> refused.

D. Limits and robustness
28. D1 per-IP socket cap (9th refused); global cap.
29. D2 oversize frame (player 17 KB; GM over its cap) -> closed 1009, server alive, memory flat.
30. D3 malformed JSON, binary frame on the control socket, unknown type, wrong direction, NaN/Infinity/huge numbers, 10,000-deep nesting, `__proto__`/`constructor`/`prototype` keys, giant strings -> dropped, counted, server alive.
31. D4 `PING` flood of 10,000 frames -> at most the allowed number of `PONG`s; strikes -> 4008 and a 30 s ban.
32. D5 move/ping/end-turn floods respect their per-type limits (rules identical to today's tests).
33. D6 a header that never completes is closed by `headersTimeout` (short test timeout); a body over 512 B to `/join` -> 413.
34. D7 100,000 random frames (seeded fuzz) never throw; `metrics.handlerErrors` stays 0.
35. D8 600 sockets from one IP -> only the cap is admitted and server memory stays under the budget (today: all 600 accepted, +270 MB).

E. Static and assets
36. E1 traversal variants (`/../`, `%2e%2e`, `..%2f`, `%00`, `//etc/passwd`, backslashes) -> 404/400.
37. E2 security headers present on HTML, JS, assets and 404s; CSP present (report-only until enforced).
38. E3 asset `GET`: no cookie 403, revoked device 403, valid 200 with immutable caching, 304 on ETag; 20 misses per IP per minute -> throttled.
39. E4 asset `PUT`: hash mismatch 400, SVG/HTML 415, oversize 413, quota 507, decompression-bomb dimensions 415; GM-only.
40. E5 pinned assets are never evicted; unpinned LRU eviction works; over-quota with everything pinned -> 507 (not silent breakage).
41. E6 `.webmanifest` served with the correct type.

F. Information
42. F1 canary: first snapshot, every kind of patch, reveal then hide, reconnect snapshot, resumed patch sequence, `MAP_PING`, roster - no GM-only byte in any player frame.
43. F2 NPC numeric hit points never appear in any player frame; PC hit points do (as documented).
44. F3 hidden token art is never uploaded; hidden token ids/names never appear.
45. F4 `areaEffects` unknown fields are dropped.
46. F5 patches never reintroduce a field that the projection removed (property test over random scenes).

G. Audio and signalling
47. G1 `AUDIO_ANSWER` with an oversize or malformed SDP, extra media lines, or public/foreign candidates -> sanitised or refused; the GM only ever receives a candidate whose address is the answering player's own IP.
48. G2 the fallback audio socket needs the same upgrade authentication; an unselected listener receives no frames.
49. G3 the listener registry is bounded by the device registry (2,000 fake registrations do not grow memory or flood the GM).
50. G4 relay queue per listener is bounded in bytes and time; a frozen listener never makes the GM or other listeners wait.

H. Crypto
51. H1 proofs match an independent `node:crypto` implementation; comparison is constant-time (no early return on the first differing byte).

### 6.4 Acceptance criteria (measured, with today's baseline measured on this PC)

Numbers marked "baseline" were measured for this document with the scripts named in section 2; the criteria add margin so a real regression fails and normal variation does not. Test machine: Intel i7-13700H (20 logical CPUs), Windows 11, Node 26.5, Edge 155, loopback, 8 clients in the same process unless stated.

**State sync and server (`npm run accept` -> `scripts/accept-net.mjs`)**

| # | Criterion | Baseline today | Pass if |
|---|---|---|---|
| N1 | Token-move round trip (player sends move, all 8 players hold the patch), 300 moves | p50 3.0 ms, p95 5.8, p99 7.9, max 16 | p95 <= 10 ms, p99 <= 25 ms; with 16 players p95 <= 20 ms |
| N2 | GM scene change -> patch at 8 players | p50 8.5, p95 11.6 ms | p95 <= 20 ms |
| N3 | Scene 4096x4096, 5,000 fog cells, 30 tokens: `STATE_FULL` | 44.6 KB raw, 11.9 KB deflate-3, 7-12 ms to 8 players | raw <= 50 KB, on the wire <= 14 KB, build+serialise <= 2 ms, all 8 players hold it <= 25 ms |
| N4 | Hub work per GM scene publish (parse + project + diff) | 0.50 ms | <= 1.5 ms |
| N5 | Patch sizes: one token move; 40-cell fog stroke | 287 B; 341 B | <= 400 B; <= 500 B |
| N6 | Memory per connected player (compression on) | 450-510 KB (both ends in-process, so about half is the server) | <= 250 KB per player on the server; 8 players idle heap <= 40 MB; after 10,000 patches and 1,000 reconnects RSS grows <= 5 % |
| N7 | Max players tested | 8 | 16 devices + GM; 8 devices reconnecting within 1 s are all in sync (same `rev` and `sum`) within 3 s |
| N8 | Resume: a client 10 revisions behind | gets a full snapshot | gets 10 patches totalling < 5 KB |
| N9 | Connect cost: hello + proof + upgrade on loopback | n/a | <= 50 ms |
| N10 | Soak 30 min: 8 simulated players moving at 2 Hz, GM publishing at 5 Hz, 3 % of sockets churning per minute | n/a | no uncaught exception, no handler error, memory flat, `divergence` = 0 |
| N11 | A slow client (reads nothing for 15 s) | marked stale | other 7 players' N1 p95 unchanged; the slow one is closed with 4009 and resumes with patches or a snapshot |
| N12 | All of 6.3 passes | only a handful hold today (non-rebinding cross-origin refusal, local-only GM role and asset upload, traversal safety, projection of hidden data) | 51 / 51 |

**Audio (`scripts/accept-audio-rtc.mjs`, `scripts/accept-audio-ws.mjs`)**: defined in 5.9 with the impairment profiles of 5.6. A "dropout" is digital silence >= 10 ms inside the steady test sine; a "discontinuity" is a sample-to-sample jump > 0.12 (the sine's own maximum step is 0.03).

**Static checks**: no `console.error`/page error in `scripts/check-player-browser.mjs` (updated), `--block-app` still shows the reload screen, `npm run build` passes, `npm test` passes, `check-eol` passes.

### 6.5 Impairment profiles (shared by the TCP proxy and the UDP relay, `test-support/profiles.js`)

| Name | Meaning | WebSocket (TCP) model | WebRTC (UDP) model |
|---|---|---|---|
| `clean` | loopback | none | none |
| `good` | healthy home Wi-Fi | 3 ms + 0-10 ms jitter, 0.5 % segment loss (300 ms RTO) | 3 ms + 0-10 ms, 0.5 % loss |
| `busy` | several phones active | 8 + 0-25 ms, 3 % segment loss | 8 + 0-25 ms, 3 % loss |
| `bad` | weak signal | 15 + 0-60 ms, 6 % segment loss | 15 + 0-60 ms, Gilbert-Elliott 5 % average loss, mean burst 4 packets (80 ms) |
| `jitter80` | bufferbloat-like | 5 + 0-80 ms | 5 + 0-80 ms |
| `stall300` / `stall700` / `stall1000` | queueing stall (delivery held, then released as a burst) | hold 300 / 700 / 1000 ms every 10-15 s | blackout with hold, same lengths |
| `drop400` | blackout without queueing (UDP only) | n/a | drop 400 ms every 10 s |
| `roam` | one outage | hold 3000 ms once | blackout 3000 ms once |
| `wifi` | mixed real-life | 4 + 0-25 ms, stalls 250-700 ms every 9-15 s, one 1300 ms stall | same, plus 0.4 % burst-start probability |

Both proxies keep strict FIFO delivery for TCP (the first version of the proxy reordered chunks and produced phantom glitches; see 5.6) and allow reordering for UDP.

### 6.6 What the real-device checklist covers (`docs/real-device-checklist.md`, section 8 lists the open questions)

Five minutes per phone: join by QR and by typed code; kick and rejoin; tap to hear; leave the screen to dim and (separately) lock for 2 minutes; switch to another app and back; toggle airplane mode for 5 s; walk out of range for 20 s; reveal a 4 MB handout while sound is playing; two phones at once; GM wired versus GM on Wi-Fi; read the numbers from the debug overlay and `/__realm/diag` and note them.
## 7. Work packages

Three engineers, six packages. Each package owns its files exclusively; the only cross-package edits are the interfaces listed per package and the "shared files" table in 7.8. Nothing is edited in place in the old files until step 5 of the integration order (7.9): the new code lives beside the old and is switched on by one line.

**Rules for every engineer**

- Line endings: preserve them. The tree is mixed (7.10). Before editing an existing file, check its style with `node scripts/check-eol.mjs <file>` (WP6 adds it) and keep it; new files are LF.
- `npm test` must stay green at every merge. A new module ships with its `test/<module>.test.js` in the same change.
- No new dependency except `@noble/hashes` (WP1). Everything bundled at build time; nothing loaded from the internet.
- Test helpers go in `test-support/`, never in `test/`: `node --test` executes **every** `.js` file under any directory named `test` (verified), so a helper placed there would run as a test.
- Ports for experiments: 5290-5299 only. Never touch port 5173 or the running server.

### 7.1 WP1 - Contract and crypto (Engineer 1, first, about half a day, then frozen)

Goal: make section 4.2/4.3/4.6 executable so the other packages can compile against it.

Owns (new): `src/net/protocol.js`, `src/net/hmac.js`, `test/protocol.test.js`, `test/hmac.test.js`. Edits: `package.json` (+ `@noble/hashes`, scripts `check:browser`, `accept`, `check:eol`).

Exports (the interface everyone relies on):

```js
// src/net/protocol.js
export const PROTOCOL_VERSION, PATHS, CLOSE, LIMITS            // 4.2
export const PLAYER_TYPES, GM_TYPES, SERVER_TO_PLAYER, SERVER_TO_GM   // frozen Sets of message type names (4.6)
export const TYPE_CAPS    // { PING:{ max:96, burst:5, perSec:1 }, PLAYER_TOKEN_MOVE:{ max:192, burst:40, perSec:30 }, ... } one entry per type in 4.6
export const SUBPROTOCOL = 'rf3'
export const authProtocol = (device, nonce, proof) => `auth.${device}.${nonce}.${proof}`
export const parseAuthProtocol = header => ({ device, nonce, proof } | null)
export const cleanName = (value, limit = 40) => string
export const isId = value => /^[\w-]{1,64}$/.test(value)
export const fnv1a = text => number                              // for the optional `sum`
// src/net/hmac.js  (pure JS, works without crypto.subtle; identical output in Node and browsers)
export const hmac = (key, ...parts) => hexString       // key and parts are strings (UTF-8) or Uint8Array; parts are joined with \0
export const randomHex = bytes => hexString            // crypto.getRandomValues (exists on non-secure origins)
export const safeEqualHex = (a, b) => boolean          // constant-time
export const joinProof, srvProof, wsProof, deriveDk, normalizeCode   // the exact formulas of 4.3, one place only
```

Tests: HMAC against `node:crypto` for 1,000 random inputs; known vectors (RFC 4231); `parseAuthProtocol` rejects overlong or non-hex pieces; `normalizeCode` ignores case, dashes, spaces and maps ambiguous letters (O->0 is NOT done: the alphabet simply excludes them); proofs are different for different roles/devices/nonces.

### 7.2 WP2 - Server access control, HTTP, assets (Engineer 1)

Goal: sections 3 and 4.3/4.4/4.9: nobody gets a socket or a byte without passing the guards; the GM cannot be impersonated; assets are access-controlled.

Owns (new): `server/net/clock.js`, `lan.js`, `hostGuard.js`, `ipLimiter.js`, `crypto.js`, `tableStore.js`, `devices.js`, `invite.js`, `handshake.js`, `assets.js`, `http.js`, `status.js`, `access.js` (composition of the above) and tests `test/{hostGuard,ipLimiter,tableStore,devices,invite,handshake,assets,http,status}.test.js`, `test/security.http.test.js`.
Replaces (at step 5): `server/serve.js` (same exported `startProductionServer({port, root, host})`), `server/realmMiddleware.js` (deleted), `server/identity.js` (deleted; `lanAddresses` -> `lan.js`, `deviceLabel` -> `server/net/ua.js`), `server/assetStore.js` (deleted -> `server/net/assets.js`; `sniffImage` keeps its name and tests).
Edits: `server/devLauncher.js` (`isAppRunning` unchanged; `startDevServer` binds 127.0.0.1 unless `--lan`), `vite.config.js` (plugin import), `scripts/start.mjs`/`scripts/dev.mjs` (flags only), `ENABLE-LAN.ps1`, `START-DEV.bat`.

Interface it exposes (WP3 and WP5 consume it):

```js
createAccess({ dataDir, clock, hostGuard?, limiter?, metrics, projectAssetsPinned: () => Set<hash> })  // server/net/access.js
 -> {
   router(req, res, next),                         // all HTTP routes of 4.4 (Connect-style, also used by the Vite plugin)
   authenticateUpgrade(req) -> { ok:true, role, device, playerId, name, ip, label, pending:boolean }
                              | { ok:false, status, reason },      // WP3 calls this inside the 'upgrade' event; no ws exists before it returns ok
   socketOpened(ip) -> boolean, socketClosed(ip),                  // per-IP / total caps
   strike(ip, n?), banned(ip),
   table: { mode(), setMode(m), locked(), lock(), unlock(), rotate(), kick(device), admit(device), deny(device), rename(device, name),
            list(), invite() -> { urlFor(address), code }, on('change'|'joinRequest', fn) },
   assets,                                          // store with has/get/put/pin
   metrics,                                         // WP2 owns status.js; everyone calls metrics.inc/observe/gauge/log
 }
```

Tests (minimum): everything in 6.3 groups A (admission), B (GM), C (Host/Origin), D (limits that live in HTTP), E (static/asset), plus `table.json` persistence/corruption. The fake clock drives nonce expiry, bans, code freshness.

### 7.3 WP3 - Hub and state sync (Engineer 2)

Goal: sections 4.5-4.7, 4.11, 4.13: sessions, validation, state fan-out with resume, actions, roster, GM slot, graceful shutdown.

Owns (new): `server/net/validate.js`, `session.js`, `stateSync.js`, `actions.js`, `roster.js`, `hub.js`, `realm.js`; tests `test/{validate,session,stateSync,actions,roster}.test.js`, `test/hub.state.test.js`, `test/hub.actions.test.js`, `test/hub.limits.test.js`, `test/canary.test.js`.
Replaces (step 5): `server/sessionSync.js` (deleted; exports `createRealm`, `attachSessionSync`, `sessionSyncPlugin`, `PROTOCOL` move to `server/net/realm.js` with the same names so `vite.config.js` and the old tests' imports keep working until they are replaced).
Keeps unchanged: `src/playerView.js` (+ areaEffects allowlist and canary), `src/syncPatch.js`, `src/ownership.js`, `src/combat.js`.

Interface it exposes (WP5 plugs audio in with it):

```js
createHub({ access, metrics, clock, extensions: [] }) -> {
  attach(httpServer),                         // installs the 'upgrade' handler for PATHS.ws and PATHS.audioWs
  close(),
  sessions: { byDevice(device) -> Session[], gm() -> Session|null, players() -> Session[] },
  sendTo(device, obj), sendGm(obj),           // JSON, respects backlog policy
  extend({ playerTypes: { NAME: (session, msg) => void }, gmTypes: { ... }, onSessionOpen(session), onSessionClose(session), onGmChange(connected) }),
  upgradeAudio(handler),                      // WP5 registers how /__realm/audio sockets are served: handler(ws, authResult)
}
createRealm(options) -> { middleware, attach, close, hub, access }       // used by serve.js and the Vite plugin
```

`Session` (public fields WP5 reads): `{ device, playerId, name, ip, label, role, rtt, send(text), sendJson(obj), bufferedAmount, close(code, reason) }`.

Tests: each rule in 4.6; patch history/resume (client N revs behind gets N patches; older than 64 gets a snapshot); idempotent replay of `aid`; backlog/stale/unstick with a fake socket and clock; GM replace; GM away; every behaviour pinned by the eleven old `sessionSync.test.js` tests, rewritten over real sockets (map in 6.2); canary test; 100k-frame fuzz that must not throw.

### 7.4 WP4 - Client connection and links (Engineer 2)

Goal: sections 4.5, 4.10: the browser side of the protocol, with the existing `broadcast.js` API preserved.

Owns (new): `src/net/connection.js`, `joinClient.js`, `deviceStore.js`, `gmLink.js`, `playerLink.js`, `netStats.js`; tests `test/{connection,joinClient,deviceStore,gmLink,playerLink,facade}.test.js` (fake socket + fake clock + in-process hub for the last three).
Replaces: `src/broadcast.js` (becomes the facade; same exports), `src/sessionTransport.js` (deleted at step 5; `createSessionTransport` stays available as a deprecated re-export until WP5 stops using it), `src/assetPublisher.js` (edit: key cache by digest instead of the whole data URL; map `507` and `413` to a readable error; no other change).
Not owned, specified in 3.9: `src/PlayerApp.jsx`, `src/player/JoinGate.jsx`, `src/App.jsx`, `src/gm/SessionDialog.jsx`, `src/gm/panels/TablePanel.jsx`. WP4 documents the new optional handler props (`onKicked`, `onLocked`, `onWaiting`, `onNetStats`, `onJoinRequest`, `onTable`) and ships them tested; the UI owner wires them. Until then the old UI keeps working.

Tests (minimum): hello->proof->subprotocol construction; reconnect backoff and jitter bounds with the fake clock; no reconnect after 4001/4002/4004; 4011 retries once with a fresh nonce; resume with pending `aid`s; silence detection; latency stats; `buildScene` and hidden-token art exactly as today; GM link coalescing; `Player` link rev/base handling; the facade passes the old behaviours.

### 7.5 WP5 - Audio (Engineer 3)

Goal: section 5: WebRTC primary, hardened WebSocket fallback, no cut-offs.

Owns (new): `src/audio/rtcSender.js`, `rtcReceiver.js`, `wsSender.js`, `wsReceiver.js`, `playout.js` (pure scheduler), `jitter.js` (pure estimator), `keepAwake.js`, `src/net/sdp.js` (pure SDP helpers shared with the server), `server/net/audioSignal.js`, `server/net/audioRelay.js`, `server/net/candidates.js`; tests `test/{sdp,candidates,playout,jitter,rtcPolicy,audioRelay,audioSignal,pcm}.test.js`.
Replaces: `src/audio/broadcastAudio.js` and `receiveAudio.js` (rewritten, **same factory names and state shapes** `createAudioBroadcaster({ workletUrl, onState })`, `createAudioReceiver(onState)` so `AudioProvider.jsx`, `usePlayerAudio.js`, `SoundPanel.jsx`, `PlayerApp.jsx` keep working), `src/audio/playbackTimeline.js` (deleted -> `playout.js`), `src/audio/deviceIdentity.js` (deleted; device ids come from `src/net/deviceStore.js`), `server/audioRelay.js` (deleted -> `server/net/audioRelay.js`), `scripts/check-audio-browser.mjs` (rewritten; the current one asserts strings that no longer exist in the UI: 'Stop Audio', 'Mute Player Audio', '1 player device listening').
Keeps: `src/audio/pcm.js` (ADPCM; adds a sequence/timestamp header `RFA3`, `RFA2` still decodes for one release), `pcm-processor.js` (adds the counter), `AudioProvider.jsx`, `usePlayerAudio.js` (unchanged signatures).

Interface: consumes `hub.extend` and `hub.upgradeAudio` (WP3), `access.table`, `metrics` (WP2), `deviceStore` (WP4). Exposes `createAudioSignal({ hub, access, metrics, clock, lan })` -> `{ listeners(), onGmAudioState() }` and the client factories above.

Tests: 5.8 lists them. The pure modules (`playout`, `jitter`, `sdp`, `candidates`, `rtcPolicy`) run in `npm test`; the Edge-driven loopback (`scripts/accept-audio-rtc.mjs`, `scripts/accept-audio-ws.mjs`) run in `npm run accept`.

### 7.6 WP6 - Test harness, acceptance, observability, docs (Engineer 3, from day 1, in parallel with WP5)

Goal: sections 6 and 4.12; make every promise measurable.

Owns (new): `test-support/{fakeClock,fakeSocket,tcpImpair,udpImpair,profiles,cdp,signal,table,sineAnalysis}.js`, `scripts/accept-net.mjs` (latency/size/memory/soak), `scripts/accept-security.mjs` (fuzz), `scripts/accept-audio-ws.mjs`, `scripts/accept-audio-rtc.mjs`, `scripts/check-player-browser.mjs` (update to the new join flow), `scripts/check-eol.mjs`, `docs/real-device-checklist.md`, `test/harness.test.js` (the harness itself is tested: the TCP proxy is FIFO and never reorders; the UDP relay's loss rate matches its setting within 1 %; the sine analyser finds a planted 12 ms hole and a planted phase jump), README "How the networking works" rewrite at the end.
Starting material (already written and used for this design, in the scratchpad `C:\Users\K0tal\AppData\Local\Temp\claude\c--Users-K0tal-OneDrive-Desktop-Games-Cyberpunk-RED-APP\b1dcbe79-22de-4595-9592-4522a56d050a\scratchpad\`): `cdp.mjs`, `tcpproxy2.mjs`, `udpproxy.mjs`, `oldaudio3.mjs`, `webrtc1.mjs`, `webrtc8.mjs`, `poprepro.mjs`, `sec1.mjs`, `perf3b.mjs`. Port them; keep the FIFO fix in `tcpImpair.js` (the first version of the proxy reordered chunks and produced phantom audio glitches; see 5.6).

### 7.7 Assignment

| Engineer | Packages | Works mostly in |
|---|---|---|
| 1 | WP1 then WP2 | `src/net/{protocol,hmac}.js`, `server/net/{access,http,assets,...}.js`, `server/serve.js` |
| 2 | WP3 then WP4 | `server/net/{hub,stateSync,...}.js`, `src/net/{connection,gmLink,playerLink}.js`, `src/broadcast.js` |
| 3 | WP6 (days 1-3) in parallel with WP5 | `test-support/`, `src/audio/`, `server/net/audio*.js` |

### 7.8 Shared files and who owns them

| File | Owner | Others may |
|---|---|---|
| `src/net/protocol.js` | WP1 | read; propose changes in writing (all three engineers sign off; version stays 3 during development) |
| `package.json`, `package-lock.json` | WP1 | ask for script/dependency additions |
| `vite.config.js` | WP2 | nothing |
| `server/net/hub.js`, `realm.js` | WP3 | WP5 and WP2 use only `extend`, `upgradeAudio`, `createRealm` options |
| `server/net/status.js` (metrics) | WP2 | everyone calls it |
| `src/net/deviceStore.js` | WP4 | WP5 reads `device()` |
| `src/audio/AudioProvider.jsx`, `usePlayerAudio.js` | WP5 | UI owner may restyle, not change signatures |
| `src/assetPublisher.js` | WP4 | |
| `src/PlayerApp.jsx`, `JoinGate.jsx`, `App.jsx`, `SessionDialog.jsx`, `TablePanel.jsx`, `SoundPanel.jsx` | UI owner (not in these packages) | WP4/WP5 supply props and tested handlers; 3.9 is the change list |
| `test-support/*` | WP6 | others add helpers by asking WP6 or in a file they own with a distinct name |
| `README.md` | WP6 (end) | |

### 7.9 Order of integration

0. **WP1** lands (protocol constants, HMAC). Everyone rebases. About half a day.
1. In parallel: WP2, WP3, WP4 (unit level, fake sockets), WP5 pure modules (`playout`, `jitter`, `sdp`, `candidates`) and WP6 harness. Each package's unit tests are green on their own.
2. **M1 - server core:** WP2 + WP3 together behind a switch (`REALM_NET=3 npm start`, default still old). `test/hub.*`, `test/security.*`, `test/canary.test.js` green. Old tests still green because the old files are untouched.
3. **M2 - clients:** WP4 against the real hub in `test/*link.test.js`; the rewritten equivalents of the 11 old sync tests green; `scripts/check-player-browser.mjs` passes against the new server.
4. **M3 - audio:** WP5 plugged in through `hub.extend`; `accept-audio-rtc` and `accept-audio-ws` pass the profiles of 6.5.
5. **Switch:** one change flips `vite.config.js` and `server/serve.js` to the new realm; the old files are deleted (list in 7.11); the old tests that tested them are deleted because their equivalents exist (mapping in 6.2); `npm test` green; UI owner applies 3.9; README rewritten.
6. **Acceptance:** `npm run accept` (about 10 minutes) meets every number in 6.4; real-device checklist (section 8) run once on an iPhone and an Android phone on the home Wi-Fi.

### 7.10 Line endings (as measured on 2026-10-13 by reading the bytes)

The brief said the files use CRLF; the tree is actually mixed. **Preserve whatever each file has.** CRLF (30): `scripts/check-audio-browser.mjs`, `scripts/dev.mjs`, `server/assetStore.js`, `src/App.jsx`, `src/assetPublisher.js`, `src/audio/receiveAudio.js`, `src/canvas/MapStage.jsx`, `src/gm/{CanvasOverlays,ContextMenu,Keyboard,Sidebar,StatusBar,Toolbar,ToolOptions,workspace}.jsx`, `src/gm/panels/SpellsPanel.jsx`, `src/gm/sceneActions.js`, `src/modals/{AddTokenModal,ImageCropper,ImagePicker,ImageViewer}.jsx`, `src/player/{InitiativeBar,JoinGate,PlayerMap}.jsx`, `src/PlayerApp.jsx`, `src/styles/dialogs.css`, `src/ui.jsx`, `test/assetStore.test.js`, `test/audio.test.js`, `vite.config.js`. Mixed (convert nothing, edit carefully): `src/gm/Header.jsx`, `test/sessionSync.test.js`. Everything else, including `server/{sessionSync,audioRelay,identity,realmMiddleware,serve,devLauncher}.js`, `src/{broadcast,sessionTransport,syncPatch,playerView,ownership}.js`, `src/audio/{broadcastAudio,pcm,pcm-processor,playbackTimeline,usePlayerAudio,deviceIdentity}.js`, `START.bat`, `README.md`, `package.json`, is LF. A file that is replaced wholesale by a new file takes the new file's style (LF). Editors and the Edit tool can silently normalise line endings; `scripts/check-eol.mjs` (WP6) prints the style of each file and fails if a file listed above changed style.

### 7.11 What is deleted (and when)

At step 5, after the replacement is green:

| Deleted | Replaced by |
|---|---|
| `server/sessionSync.js` | `server/net/{hub,session,stateSync,actions,roster,validate,realm}.js` |
| `server/realmMiddleware.js` | `server/net/{http,access}.js` |
| `server/identity.js` | `server/net/{lan,ua,hostGuard}.js`, `crypto.js` |
| `server/assetStore.js` | `server/net/assets.js` |
| `server/audioRelay.js` | `server/net/{audioSignal,audioRelay,candidates}.js` |
| `src/sessionTransport.js` | `src/net/connection.js` |
| `src/audio/playbackTimeline.js` | `src/audio/playout.js` |
| `src/audio/deviceIdentity.js` | `src/net/deviceStore.js` |
| `test/sessionSync.test.js`, `test/audio.test.js` (the relay parts), `test/assetStore.test.js`, `test/playbackTimeline.test.js` | the equivalents in 6.2 (the PCM/ADPCM tests move to `test/pcm.test.js` unchanged) |
| `scripts/check-audio-browser.mjs` (stale) | `scripts/accept-audio-*.mjs` |

Kept: `src/syncPatch.js`, `src/playerView.js`, `src/ownership.js`, `src/combat.js`, `src/audio/pcm.js`, `pcm-processor.js`, `AudioProvider.jsx`, `usePlayerAudio.js`, `src/gm/QrCode.jsx`, and the tests `syncPatch`, `playerView`, `ownership`, `combat`.
## 8. Risks and what cannot be verified without real devices

### 8.1 Open questions (each is a line in `docs/real-device-checklist.md`; "if no" shows the planned response)

| # | Question | Why it matters | If the answer is no |
|---|---|---|---|
| R1 | Does `RTCPeerConnection` exist and connect on **iOS Safari** from a plain `http://192.168.x.x` page? (Chromium: yes, tested.) | Primary audio path | Automatic fallback to the WebSocket path (it is feature-detected); iOS players get the repaired fallback. If the fallback is not good enough on iOS, TLS mode (R8) becomes necessary for those players. |
| R2 | Does WebRTC audio keep playing on iOS and Android with the screen dimmed, with the keep-awake video running, and after a 2-minute lock? | The brief: "keep working through screen dimming" | Dimming should be fine. For lock: documented limitation; the pill returns to "Tap to hear the music"; consider a hint "turn off auto-lock". |
| R3 | Do `jitterBufferTarget` and `playoutDelayHint` exist on Safari and Android WebView? | The 800 ms target is what makes 1 s stalls inaudible | Without it WebRTC's default buffer (about 30-150 ms) is shallower than the old path's 750 ms; then use the fallback path (deeper buffer) when the player reports `jbt:false` and the stall statistics are bad, or keep WebRTC and accept short dropouts. The policy module already decides on measured concealment. |
| R4 | Does the Windows firewall let inbound UDP reach the GM's browser (return path after its outbound connectivity checks)? | ICE success | Fallback works meanwhile; add a program-scoped UDP rule to `ENABLE-LAN.ps1`. |
| R5 | Does rewriting mDNS candidates to IPs work on the phones' browsers (Safari might refuse remote candidates it cannot match)? Tested only between two Edge pages. | ICE success | Fall back to the user-visible "sound uses compatibility mode" and the WebSocket path. |
| R6 | Real Wi-Fi: how often do stalls longer than 0.8 s occur on the user's network, and is the GM on Wi-Fi? | Sizes the buffer defaults | The debug overlay and `/diag` record it; adapt defaults. |
| R7 | Do iOS and Android Chrome support the hidden-video keep-awake trick on `http://`? | Keep-awake | Ask players to raise the auto-lock time; documented. |
| R8 | Do users want an opt-in HTTPS mode (self-signed, fingerprint shown in the GM dialog)? | Secure context would unlock wake lock and more | Build later; not part of v3. |
| R9 | Is the GM tab's capture and WebRTC sending throttled when the GM minimises the browser for ten minutes? | The GM may switch to a music app or a map editor | Document "keep the GM window open (it can sit behind others)"; test with an occluded and with a minimised window; if throttled, show a warning in the Sound panel (`document.visibilityState`). |
| R10 | Does a 44.1 kHz (and Bluetooth) output click in the fallback after pinning the context to 48 kHz on Safari? | Fallback quality on iOS | Stateful JS resampler path (already specified) is switched on by user-agent. |

### 8.2 Design risks and mitigations

- **Complexity of the handshake.** The proof protocol is small (four HMACs) but is cryptographic glue; it is isolated in one module, tested against `node:crypto`, and should get a short review by a second engineer before release. Nothing is encrypted by us.
- **Dependence on `@noble/hashes`** (pure-JS SHA-256 on phones). It is audited, tiny and bundled; the alternative is a 60-line SHA-256 of our own, which is worse.
- **WebRTC details change by browser version** (SDP formats, stats names). Mitigated by golden SDP fixtures per browser, feature detection, and the fallback path.
- **Persistent `table.json`** adds a file the old program never wrote. It is small, written atomically, git-ignored, and a corrupt file only creates a fresh table (everyone must rejoin).
- **Short code is weaker than the QR secret** (3.6). Accepted and documented.
- **Fog is an overlay** (3.8). Accepted, documented, listed as a future project (tiled masked maps).
- **GM tab is the audio sender.** If the GM page crashes the sound stops; the status chip shows it and the fallback does not help (the encoder lives in the same page). Moving the sender into the server would need a Node WebRTC stack and is not worth the risk now.
- **Everything in `test-support/` is new code.** `harness.test.js` tests the harness (FIFO, loss rates, the analyser finding planted holes), because an untested impairment tool already misled this audit once.
- **Migration:** phones with a cached old player page will reconnect to the old path and fail with 404; the first load of the new page fixes it; the new server answers old clients on `/session-sync` with a short "please reload" text so the failure is not silent.
- **Dev server:** when `START.bat` falls back to Vite, the same guards apply (the Vite plugin calls `createRealm`), and the dev server binds to localhost unless `--lan`.

### 8.3 Verification summary: measured versus assumed

Measured here: every number in 2 and 5.6; the rebinding, limit and header findings; the non-secure-origin API list (Edge); WebRTC connection with rewritten candidates; 8-peer CPU; sample-rate click behaviour of Chromium; main-thread freeze behaviour of the old player.
Assumed or modelled: real Wi-Fi stall frequency; TCP retransmission behaviour (modelled with a 300 ms RTO and doubling); anything about Safari, iOS, Android, the Windows firewall for UDP, multicast on the user's router, Bluetooth routes; the estimate of 1.5-4 MB per map download.

## Appendix A - frozen protocol decisions (WP1)

Written by WP1 on 2026-10-13. Sections 4.2, 4.3 and 4.6 left some formulas, encodings and shapes open; the code in `src/net/protocol.js` and `src/net/hmac.js` fixes them as below. Where this appendix and an earlier section differ in wording, this appendix is the contract (the earlier text is the intent). Changing anything here needs the sign-off of section 7.8.

### A.1 Encodings (the bytes behind every formula)

| Thing | Frozen form |
|---|---|
| `device`, `nonce`, `srv` | 16 random bytes written as **32 lowercase hex characters**. Uppercase, odd length, or any other character is invalid everywhere (`isHex(value, 16)`). `isId` (`/^[\w-]{1,64}$/`) is for token ids / `aid` / `sid` only, never for these. |
| proofs (`joinProof`, `srvProof`, `wsProof`) | HMAC-SHA256 as **64 lowercase hex characters** |
| `dk` | `deriveDk` output: **64 lowercase hex characters**, kept and transported as that string (it is 32 bytes of entropy) |
| `S` (invite secret) | 16 random bytes as **22 base64url characters, no padding** (`randomSecret()`, `isInviteSecret()`); this exact text is what follows `#join=` |
| `C` (table code) | 8 characters of `ABCDEFGHJKMNPQRSTUVWXYZ23456789` (31 symbols, no I, L, O, 0, 1; 31^8 = about 39.6 bits). The UI may show it as `XXXX-XXXX`; the dash is not part of the code. `randomCode()` uses rejection sampling (bytes >= 248 are discarded), so there is no modulo bias. |
| `playerId` | first 12 bytes = **24 lowercase hex characters** of `HMAC(serverSecret, "pid" \0 device)` (`playerIdOf`) |
| `rf-d` cookie MAC | first 16 bytes = **32 lowercase hex characters** of `HMAC(serverSecret, "cookie" \0 device)` (`cookieMac`); cookie value is `<device>.<mac>` |
| `serverSecret` | 32 random bytes as 64 lowercase hex characters; used as a string key |

### A.2 How a key and a message are turned into bytes

1. A **string key is its UTF-8 bytes**; a `Uint8Array` key is used as is. So `dk` as an HMAC key is the 64-character hex *text* (64 bytes, exactly one SHA-256 block, never pre-hashed), and `S` is the 22-character base64url *text*. Nobody ever hex-decodes or base64-decodes a key. (A hex string and its decoded bytes are two different keys; mixing them is the likeliest cross-implementation bug.)
2. `hmac(key, ...parts)` authenticates the parts **joined by a single 0x00 byte**, strings as UTF-8, `Uint8Array` as is. A string part may not contain `\0` (it throws), so `("a\0b")` can never collide with `("a","b")`. With no parts the message is empty; with one part there is no separator.
3. The label is always the first part, so `hmac(key, 'rf3-join', device, nonce)` is byte-identical to the written `HMAC(key, "rf3-join\0" + device + "\0" + nonce)` of 4.3. The tests compare each formula with an independent `node:crypto` computation of the written text.
4. The formula functions **validate their inputs and throw `TypeError`** (device/nonce/srv must be `isHex(.,16)`, `dk` `isHex(.,32)`, role `'player'|'gm'`, keys non-empty). A server must therefore check attacker-supplied values with `isHex` / `parseAuthProtocol` / `inviteKey` first and answer 4xx; it must never let a `TypeError` from a formula reach a client as a 500.

### A.3 The formulas (all in `src/net/hmac.js`, nowhere else)

```
inviteKey('link', S)   = S                       (null unless 22 base64url characters)
inviteKey('code', C)   = "code:" + normalizeCode(C)    (null unless a valid code)
joinProof(key, device, nonce)        = hmac(key, 'rf3-join', device, nonce)
srvProof (key, device, nonce, srv)   = hmac(key, 'rf3-srv',  device, nonce, srv)
deriveDk (key, device, nonce, srv)   = hmac(key, 'rf3-dk',   device, nonce, srv)
wsProof  (dk,  device, nonce, role)  = hmac(dk,  'rf3-ws',   device, nonce, role)
```

Domain separation: the four labels differ (so a join proof can never be replayed as a server proof or a connection proof, and `dk` can never equal a proof computed from the same inputs); the link key (22 base64url characters) and the code key (starts with `code:`; `:` is not base64url) cannot be equal strings, so the two admission paths cannot be confused. In `how:'code'` the proof and `dk` are derived from `"code:" + C` exactly as for the link; `dk` therefore differs between the two paths.

### A.4 Table code normalisation

`normalizeCode(input)` returns the 8 canonical characters or **`null`** (never `''`, never throws): input must be a string of at most 64 characters; whitespace (`\s`) and dashes (`-`, U+2010..2015, U+2212) are removed; ASCII `a-z` become `A-Z` (**ASCII-only folding**, so `ſ`, `ı`, full-width letters and `ß` are not folded into the alphabet); the result must be exactly 8 characters of the alphabet. **Ambiguous letters are not mapped**: `O`, `I`, `L`, `0`, `1` make the code invalid (the alphabet simply does not contain them).

### A.5 The WebSocket sub-protocol token

`authProtocol(device, nonce, proof)` = `auth.<device>.<nonce>.<proof>` (5 + 32 + 1 + 32 + 1 + 64 = 135 characters; every character is a legal sub-protocol token character); it throws `TypeError` for anything not 32/32/64 lowercase hex. `parseAuthProtocol(x)` accepts the raw `Sec-WebSocket-Protocol` header (comma separated), an array, or a `Set` (what `ws` passes to `handleProtocols`), and returns `{ device, nonce, proof }` or `null`. It returns `null` (never throws) for: header longer than 512 characters, more than 8 offered protocols, a non-string entry, **two** `auth.` tokens, an `auth.` token of the wrong shape, uppercase hex, wrong lengths, trailing garbage, control characters (only spaces and tabs around a token are trimmed). It does **not** check that `rf3` was offered; the hub does that when it selects the sub-protocol.

### A.6 GM connections (decision, WP2/WP4 must follow)

4.3 describes the proof for players and a cookie/loopback rule for the GM, but a browser cannot compute a proof from an `HttpOnly` cookie and the GM has no `dk`. Decision: **a `role=gm` upgrade offers only the sub-protocol `rf3` and no `auth.*` token, and the server neither requires nor consults one.** The GM is authenticated by: remote address is loopback, `Host` is `localhost`/`127.0.0.1`/`[::1]` (and allowed), `Origin` present and equal to the Host, and the `rf-gm` cookie valid (4.3, test group B). `wsProof(..., 'gm')` is still defined (the role is part of the proof so a captured *player* proof can never be presented for a GM socket, test A14), but nothing uses it today. The GM link therefore skips `POST /__realm/hello`.

### A.7 Join and cookie details the text left open

- A join request's `nonce` is chosen by the client; the server's `srv` is fresh per response. A replayed identical join request (same `device`, `nonce`, `proof`) must be **idempotent**: it returns the same device's status with a new `srv`; it never creates a second device. It is still counted against `joinPerIpPerMin`.
- Because `dk = HMAC(key, "rf3-dk" ... device nonce srv)` and `device`, `nonce`, `srv` all cross the Wi-Fi in clear text, **anyone who knows the invite secret `S` (or, for the code path, the code) and captured that join can compute that device's `dk`.** This is inherent in the approved formula, not a bug in the implementation: a Wi-Fi sniffer who never saw the QR code cannot; a former guest who kept `S` and sniffed a later join can. Mitigation is the existing one (Kick the device, **Rotate the invite**, which changes `S`); a captured join with the typed code additionally allows offline guessing of the 40-bit code (already stated in 3.6). 3.10 should list this under residual risks.
- `how:'code'` and `how:'link'` use the same endpoint and the same proof label; only the key differs (A.3).

### A.8 `protocol.js` shapes

- `PATHS`, `CLOSE`, `LIMITS`, `TYPE_CAPS` and every nested object are deeply frozen (assignment throws in strict mode). `CLOSE` is 4.2 plus `UNSUPPORTED_DATA: 1003` and `TOO_BIG: 1009`, the two standard codes 4.5/4.6 use.
- `LIMITS` is the exact 4.2 list plus numbers that 4.3-4.6 give only in prose, so there is one source: `httpBodyMax 512`, `nonceTtlMs 15000`, `nonceMaxLive 256`, `socketsPerDevice 3`, `codeFreshAfterCloseMs 600000`, `wrongCodePerIpPerMin 5`, `wrongCodeGlobalPerMin 30`, `pendingTtlMs 300000`, `strikesToClose 10`, `strikeWindowMs 10000`, `strikeBanMs 30000`, `resumeWaitMs 2000`, `resumeMaxPatches 16`, `actionMemory 64`, `actionRetryMs 5000`, `nameMax 40`.
- Also exported: `ROLES`, `ADMISSION_MODES` (`open ask locked`), `TABLE_OPS` (`kick admit deny lock unlock rotate mode rename`), `ACK_REASONS` (`blocked paused away not-your-turn rate invalid`), `CODE_ALPHABET`, `CODE_LENGTH`, `isHex`.
- The four **message Sets** are frozen: the object is frozen and `add`, `delete`, `clear` throw `TypeError`. (`Set.prototype.add.call(set, x)` can still bypass this; the guarantee is against accidental mutation, not against hostile code in the same realm.)
- Direction names mean what they say: `PLAYER_TYPES` / `GM_TYPES` are what the server accepts from that role; `SERVER_TO_PLAYER` / `SERVER_TO_GM` are what the server sends. Overlaps are deliberate and tested: clients both send `PING RESUME`; the server sends both clients `HELLO MAP_PING PONG`. `SCENE`, `TABLE_CMD` and every `AUDIO_*` GM command are not in `PLAYER_TYPES`.
- v2 names kept so the facade keeps working: `PLAYER_ID`, `MOVE_REJECTED`, `TURN_REJECTED` stay in `SERVER_TO_PLAYER` (ACK is the v3 form; the hub may send either, the facade accepts both), `PLAYER_ROSTER` and `REQUEST_FULL_STATE` in `SERVER_TO_GM`, `REQUEST_FULL_STATE` and `RESYNC` in `PLAYER_TYPES`. The v2 audio relay messages `AUDIO_REGISTER`, `AUDIO_DEVICE_UPDATE`, `AUDIO_DEVICE_SETTINGS`, `AUDIO_LISTENERS` are **not** in the catalogue: the v3 equivalents are `AUDIO_LISTEN`, `AUDIO_SELECT`, `AUDIO_LISTENER` and the `audio` field of `PLAYER_ROSTER` (WP5 replaces the old relay).
- `TYPE_CAPS[type] = { max, burst, perSec }`, **one entry per type name** regardless of direction (the same name in two directions shares one entry, e.g. `AUDIO_OFFER` is 12,288 B both ways). `max` is bytes of the frame after decompression. `burst` is the token-bucket capacity and `perSec` the refill rate; `RESUME` is `burst 1, perSec 0` ("once per socket"). A type that **no client may send** (`STATE_FULL`, `ACK`, `KICKED`, ...) has `burst: null, perSec: null` (not rate limited) and its `max` is the largest frame a receiver must accept (`STATE_FULL`/`STATE_PATCH` 8 MiB = the `SCENE` cap, `PLAYER_ROSTER`/`TABLE` 64 KiB, the small notices 128-256 B, `HELLO` 2 KiB, `JOIN_REQUEST` 1 KiB, `AUDIO_LISTENER` 512 B).
- Two caps are deliberately looser than the table's prose, because the stricter reading would punish honest clients: `PLAYER_PING` is `burst 2, perSec 1.5` (the 700 ms cooldown is a rule of `actions.js`, not of the flood bucket) and `AUDIO_OFFER` is `burst 20, perSec 10` (the GM sends one offer per admitted device, up to 16, at the moment sound starts). `PLAYER_END_TURN` is `burst 3, perSec 1`, `AUDIO_STATS` `burst 2, perSec 0.25`, `RESYNC`/`REQUEST_FULL_STATE` `burst 3, perSec 0.5`, `PLAYER_NAME` `burst 1, perSec 0.5`, `AUDIO_LISTEN` `burst 2, perSec 1`, `AUDIO_ANSWER` `burst 3, perSec 3`, `SCENE` `burst 60, perSec 60`, the other GM audio commands `burst 20, perSec 20`, `TABLE_CMD` `burst 10, perSec 10`.
- `cleanName(value, limit = 40)`: non-strings give `''`; at most 4,096 UTF-16 units are examined; characters of categories Cc (controls incl. `\n`, `\t`, DEL, C1), Cs (lone surrogates), Co (private use) and Cf (format: bidi overrides/isolates, zero-width space, LRM/RLM, word joiner, BOM, soft hyphen) are removed, **except U+200C and U+200D** which real names and emoji sequences need; runs of whitespace (any `\p{Z}` or `\s`) collapse to one space; the result is trimmed and cut to `limit` **code points** (never in the middle of a surrogate pair, so up to `2 * limit` UTF-16 units) and trimmed again. The v2 server removed only controls and cut by UTF-16 units; v3 is a superset of that behaviour. A `limit` that is not a finite number falls back to 40.
- `fnv1a(text)`: 32-bit FNV-1a (offset 0x811c9dc5, prime 0x01000193) over the **UTF-8 bytes** of `String(text)`, returned as an **unsigned** integer. UTF-8 (not UTF-16 code units) so that any other implementation, and the server and the browser, agree on non-ASCII text.

### A.9 Dependency and environment

`@noble/hashes` 2.4.0 (the only new dependency of the rewrite) is imported with the explicit `.js` paths its `exports` map requires: `@noble/hashes/hmac.js` and `@noble/hashes/sha2.js`. `src/net/hmac.js` needs `TextEncoder`, `btoa` and `crypto.getRandomValues` and nothing else; it was bundled with Vite 5 into a classic script and run in a bare `vm` context (no `require`, no `process`, no `crypto.subtle`) and produced the same proof as Node.
