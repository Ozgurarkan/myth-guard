# Build "Realm Forge" from scratch: brief for the coding agent

You are a senior full-stack engineer. Build **Realm Forge**, a complete local virtual tabletop for Dungeons & Dragons, in a NEW, empty folder. Everything you need is in this document. Where it says "must", it is a requirement; where it gives numbers, use them. Where something is not specified, choose the simplest thing that satisfies the intent and note the choice in `docs/decisions.md`.

A finished reference implementation may exist at `C:\Users\K0tal\OneDrive\Desktop\Games\Cyberpunk RED\APP`. If you can read it, treat it as a reference for behaviour only. Write fresh, clean code; do not copy files wholesale, and do not modify that folder. If you cannot read it, this document alone is enough.

---

## 1. What it is

Realm Forge is a **local-network virtual tabletop**. One person, the **Game Master (GM)**, runs the app on their Windows PC. The **players** join from their phones, tablets or a shared screen over the **same home Wi-Fi** by scanning a QR code. There are **no accounts, no internet requirement, no cloud**: nothing leaves the home network.

- The GM gets a rich desktop screen: battle map with fog of war, tokens, initiative and hit points, spell templates, map markers, handouts, character-sheet PDFs, quest and NPC notebooks, a session-planning word processor, and sound sharing.
- Players get a fast, minimal phone screen: the map (within a frame the GM chooses), their own hero to drag, the turn order, a ping tool, a distance-measuring tool, an "end turn" button, handouts and shared sound.
- The GM computer is the single source of truth. Players never receive anything the GM has not allowed (hidden tokens, fogged tokens, exact creature hit points, private notes).

**Non-goals:** internet play, cloud hosting, accounts, user-generated rules automation (this is not a rules engine), 3D, video/voice chat, TLS (see section 9.1 for the reasoning), native mobile apps. Packaging as a desktop executable will be done later and is out of scope.

## 2. Hard constraints

1. **Offline-first.** After `npm install`, nothing may load from a CDN or the internet. Fonts, icons, libraries are bundled.
2. **Windows 11 first.** One-click launch via `START.bat`. Node.js 22 or newer. Use only cross-platform Node APIs inside the code so it also runs elsewhere.
3. **Stack (fixed):** Node ESM (`"type": "module"`), React 19, Vite 5 (multi-page: `index.html` = GM, `player.html` = player), Konva + react-konva for the map canvas, `ws` for WebSockets, plain CSS with design tokens (no CSS framework, no TypeScript requirement; JSDoc is fine), `node --test` for tests. Other dependencies allowed: `use-image`, `uqr` (QR code), `@noble/hashes` (HMAC-SHA256 for a non-secure browser origin), `@fontsource-variable/inter`, `@fontsource-variable/cormorant`, TipTap (`@tiptap/react`, `@tiptap/pm`, `@tiptap/starter-kit`, `@tiptap/extension-placeholder`, `-highlight`, `-task-list`, `-task-item`, `-table`) for the session planner. Icons: generate a small inline SVG icon set from Lucide (ISC licence) with a script, so Lucide is a dev-only, no-save dependency.
4. **Players are on a NON-secure origin** (`http://192.168.x.x:5173`). Therefore on phones there is no `crypto.subtle`, no AudioWorklet, no WebCodecs, no service worker, no wake lock, no `getUserMedia`. Design every player feature for that. The GM page at `http://localhost:5173` IS a secure context.
5. **Port 5173** is the app's port. The launcher must reuse an already-running server (detect it via a status endpoint) instead of failing.
6. **Line endings:** all files LF.
7. **No telemetry, no analytics, no update checks.**
8. **Accessibility basics:** keyboard operable GM UI, visible focus rings, `aria-label`s on icon buttons, text contrast of at least 4.5:1, touch targets of at least 44 px on the player side, `prefers-reduced-motion` respected.

## 3. Architecture at a glance

```
START.bat -> scripts/start.mjs
   builds if sources are newer than dist/, then serves dist/ from memory (Brotli/gzip once at startup)
   one Node process = HTTP server + WebSocket hub + asset store + audio signalling/relay

GM browser (http://localhost:5173)             Player phones (http://<LAN-IP>:5173/player.html#join=<secret>)
  React app, owns the scene state                React app, renders the filtered scene
  IndexedDB: scenes, tokens library,             localStorage: device identity, name
   handouts, sheets, quests, NPCs, plans
        |  WS /session-sync?role=gm                       |  WS /session-sync?role=player
        +------------------------> HUB (server) <---------+
              SCENE (whole scene)      projects what players may see, diffs it,
                                       sends STATE_FULL / STATE_PATCH, checks actions
```

- The **GM page** holds the full scene in a React reducer store and publishes it (throttled, coalesced) to the server. Images are uploaded once to a **content-addressed asset store** on the server and referenced by short URL (`/__realm/assets/<sha256>`).
- The **server hub** keeps the GM's complete scene, derives the **player projection** (a strict allowlist of fields), diffs it against the previous projection, and fans out small JSON patches. Late joiners and reconnecting phones are served from the server's copy, even if the GM window is closed.
- **Player actions** (move own token, ping, end turn, rename) go player -> hub (validated, rate-limited) -> GM. The hub applies token moves optimistically to its copy and forwards them to the GM, who owns the truth.
- **Sound** goes GM page -> each player via WebRTC (primary) with an automatic per-listener fallback over a hardened WebSocket path.

### Suggested layout

```
START.bat  START-DEV.bat  ENABLE-LAN.ps1  package.json  vite.config.js  index.html  player.html
public/            favicon.svg, manifest.webmanifest, brand/ (mark.svg, seal.svg, icons, banner)
scripts/           start.mjs, dev.mjs, build-icons.mjs, check-*.mjs, accept-*.mjs
server/net/        small modules, each exporting one factory and taking its collaborators + a clock
src/net/           protocol.js, hmac.js, connection.js, gmLink.js, playerLink.js, joinClient.js, deviceStore.js, facade.js
src/audio/         sender/receiver (WebRTC + WebSocket), playout.js, jitter.js, keepAwake.js, pcm.js (ADPCM)
src/canvas/        shared.jsx (grid, fog, token art, markers, areas, pings), MapStage.jsx (GM)
src/gm/            header, tool rail, sidebar tabs, panels/, planner/, dialogs
src/player/        PlayerMap.jsx, InitiativeBar.jsx, JoinGate.jsx, PlayerTools.jsx, screens
src/styles/        tokens.css, components.css, gm.css, panels.css, dialogs.css, player.css, planner.css
test/              node --test files ONLY (never put helpers here)
test-support/      fake clock/socket, network-impairment proxies, helpers
docs/              network-design.md, decisions.md, real-device-checklist.md
```

Important: `node --test` executes every `.js` file under any directory named `test`, so helpers go in `test-support/`.

## 4. Domain model

### Scene (shared between GM and server; players get a filtered copy)

```
mapImageSrc, mapWidth, mapHeight          the battle map picture and its size in pixels (maps are shrunk to at most 4096 px)
showGrid, gridSize (px per square, default 50), gridColor, gridOpacity, feetPerCell (default 5), snapToGrid
playerCanMoveTokens                       GM switch: pause or allow player movement
showFog, fogCells (["col,row", ...]), fogColor, fogOpacity
areaEffects[]                             spell templates (see below)
markers[]                                 map points of interest
playerViewRect {x,y,width,height}         the frame players may look inside
tokens[]
combat { entries[{tokenId, initiative, hp, maxHp}], activeId, round }
handoutSrc, handoutName                   the image currently revealed to players
```

GM-only state (never in the scene): selection, tool, pan/zoom, open panels, notebooks, plans, sheets, handout library, token library.

### Token
`id, name, x, y, gridSize (0.5, 1, 2, 3, 4 squares), characterType ('pc' | 'npc'), color (ring colour hex), borderWidth (2-20), imageSrc (cropped circle), portraitSrc (initiative portrait), portraitSource (uncropped original, GM only), showNumber/number (badge), visibleToPlayers, ownerId (the player device that may move it), maxHp (optional, saved on the token), npcId, notes (GM only), category`.
- A **hero** (`pc`) shows players exact hit points. A **creature/NPC** shows players only a **condition**: Healthy (full), Wounded (<100%), Badly wounded (<=50%), Almost dead (<=25%), Down (0). Exact numbers never leave the server.
- `maxHp` set in the token form is used automatically when the token joins combat (starts at full health); editing "HP max" inside combat is remembered on the token.

### Combat
Initiative list sorted high to low (stable ties). Actions: upsert entry, remove entry (advances the turn and round if the active one is removed), next turn (wraps and increments the round), previous turn (never before round 1 turn 1), reset. Per entry: initiative, hp, maxHp (hp clamped to 0..maxHp). One-click damage/heal buttons with a configurable amount (presets 1, 5, 10, 20).

### Spell areas
`circle` (radius), `rect` (width x height), `cone` (length, angle) in **feet**, converted with `feetPerCell`. Nine damage-type colours: Fire #e5533d, Cold #6fb4e8, Lightning #f3d44f, Acid #8bd24f, Poison #4fae7d, Necrotic #9d7bd4, Radiant #f3e7c0, Force/Thunder #e08ad0, Earth/Smoke #9c7a52. Draggable, labelled with size in feet, visible to players.

### Markers
Shapes (star, pin, flag, and similar), label, colour, size, visible-to-players flag (default visible). Private markers show faded for the GM.

### Players and devices
A **device** is one browser on one phone. It has an id, a per-device key, a name, a status (admitted, pending, revoked) and connection quality. The GM assigns a token to a device by choosing it in the Table panel.

## 5. The GM application

**Layout** (grid): header on top, tool rail left, map centre, optional docked sheet viewer, right sidebar panel with a tab rail at the far right, status bar at the bottom. Side panel can be closed; below ~960 px it becomes a drawer. Floating, glass-style overlays on the map: tool options, selection bar, zoom, a combat turn chip with "Next turn", share banners, and a player-frame badge.

**Header:** brand (logo mark + name), scene chip (current scene name, unsaved dot, opens the Scenes tab), table-status pill (players online, connection state; opens the invite dialog; badge for pending join requests), buttons: **Session plan**, **Import map**, **Save**, **Player view** (opens `/player.html` in a new tab), keyboard help.

**Welcome card** (before any map): "Set the scene. Tell your story." with Import a map / Open a scene / Add a token / Invite players / Use a blank table. The GM can run a **blank table** (empty grid) with no map.

**Tool rail** (with one-key shortcuts): Select `V`, Pan `H`, Marker `M`; Fog: Hide `F`, Reveal `E`; Spells: Circle `C`, Square `R`, Cone `K`; View: Grid `G`, Fog toggle, Player frame `P`; Sheets `S`. `Ctrl+S` saves the scene, `N` opens the session plan, `?` lists shortcuts, `Delete` removes the selection, `Esc` returns to Select. One-key shortcuts must be disabled while typing in a field and while a dialog or the planner is open.

**Map interactions:** wheel zoom around the cursor (0.04x to 12x), middle-drag or `H` to pan, drag tokens (snap to grid optional), right-click context menu (hide/reveal, duplicate, edit, delete), fog painted as grid cells with a continuous brush (fast drags must leave no gaps), spell templates dragged out with live feet labels, markers placed by click. Hidden tokens appear faded with a dashed ring and an "eye-slash" badge. Down tokens (0 HP) show an X and an empty HP bar. Selected, active-turn and dragging states each have a **shape cue**, not only a colour.

**Sidebar tabs** (each a panel with consistent section headers, empty states and keyboard focus):
1. **Scenes:** name, Save / Save copy / New; saved scene cards with thumbnail, token count, date, delete; warn before losing unsaved work. A scene stores the map, tokens, fog, markers, areas, combat and settings.
2. **Tokens:** list with show/hide eye, edit, duplicate, delete, owner badge; a **token library** of presets (categories: Heroes, Creatures & folk) with Place buttons.
3. **Combat:** round banner, turn-order strip, per-combatant cards with HP bar (state shown by icon + label + fill pattern, not colour alone), damage/heal buttons, initiative, HP now / HP max fields, "Roll a d20", "Roll all", Start/Next/Back, End combat. What players will see is previewed on creature cards.
4. **Table:** list of devices with connection quality (signal bars + ms), online dot, "Give a token to <player>" select, Invite button.
5. **Quests** and **NPCs:** private, searchable notebooks (records with title, status, text, links between quests and NPCs); an NPC can be placed on the map as a hidden token.
6. **Sheets:** upload character-sheet PDFs; view docked beside the map (resizable) or full screen; tabs, number keys 1-9 and arrows to switch; private to the GM.
7. **Handouts:** image library (stored in IndexedDB with thumbnails), private preview, **Reveal** to all players full screen, **Hide**, rename, save to disk, delete (**one click, no confirmation**). The handout's name is never shown to players or in the viewer.
8. **Spells** and **Markers:** pickers for shape, size in feet and colour, and lists of what is on the map.
9. **Sound:** share the computer's audio with chosen player devices (see section 10): start/stop, per-device on/off, master volume and mute, device list with state.
10. **Settings:** grid (show, size, colour, opacity, snap), scale (5 ft, 10 ft or custom feet per square), fog (show, colour, opacity), player view frame (enable, position and resize on the map), allow/pause player movement.

**Modals:** Add/Edit token (live preview card, name, hero or creature, **max hit points**, picture upload with circular crop and a separate initiative-portrait crop, size, **ring colour: 26 presets plus a free colour picker**, ring width, number badge, "keep in my library"), image picker (handout grid with search), image viewer (zoom/pan, used for previews), invite dialog (section 9.6), shortcuts dialog, sheet viewer.

**Session plan** (a word-processor page for the GM's own writing; opens full-area over the map, toggle with the header button or `N`, `Esc` closes): page list with search and "New page" (Blank or **Session outline** template: Recap, Strong start, Scenes (checklist), Secrets and clues, Locations, People, Monsters, Rewards, Afterwards), editable title, rich text (TipTap): undo/redo, text style (Normal, Heading 1-3), bold, italic, underline, strikethrough, highlight, bullet/numbered/checklist, read-aloud quote box, divider, link, tables with row/column controls, clear formatting; autosave (700 ms debounce, "Saved" indicator, Ctrl+S forces), word count, duplicate, delete (with a single confirmation), export as print/PDF (clean black-on-white print CSS), `.html` or `.txt`. Stored only in IndexedDB; never sent anywhere. Load the editor with a dynamic import so it is a separate chunk that players never download.

## 6. The player application

**Join flow** (section 9.6 has the protocol): open the QR link (secret in the `#fragment`) or type the 8-character table code; enter a name; connect. Screens for every state: needs-invite/enter code, wrong code, waiting for admission (Ask-first mode), table locked, table full, removed by the GM, banned, outdated page (reload), unauthorised. A phone remembers its identity (localStorage) so reloading needs no code.

**Main screen:** full-screen map with overlays:
- **Top-left: initiative bar** (collapsible): round badge, one portrait card per combatant ordered by initiative. Each portrait has a **border and glow in that token's ring colour**; the active combatant gets a pulsing glow in its colour and a "Turn" pill; the player's own heroes carry a "You" tag. Heroes show "hp / max" with a thin meter; creatures show only their condition word. Token names are NOT shown anywhere on the map under tokens.
- **Top-right:** connection chip (a dot when fine; words only when there is a problem; different shapes per state) and a menu button (change name, full screen, show handout).
- **Right edge, vertically centred: tool rail** like the GM's rail. **Ping** (tap the tool, then tap the map: a glowing, name-labelled ripple appears for everyone including the GM for about 3.6 s; one tap, one ping; per-player colour; constant on-screen size), **Measure** (drag to see feet and squares; starts on a token if touched; with snapping, count squares like 5e movement where a diagonal step is one square; local only, never sent), **End turn** (enabled and glowing only while one of your heroes is active; sends the request, then disables for a moment).
- **Bottom:** zoom out / % / zoom in / "find my hero", hint pills (only when relevant; **no hint text on a blank table**), "Tap to hear the music" audio pill.
- **Turn banner** and a vibration pattern when it becomes your hero's turn.
- **Handout viewer** full screen with "Hide for now" and a bring-it-back button; the same handout re-revealed after the GM hid it must show again.
- **Blank table** (no map, no tokens): show just the grid and the chrome, with no explanatory text.

**Map behaviour:** one-finger pan, pinch zoom (1x to 6x), clamped so players can never pan outside the GM's player-view frame; drag only your own visible, unfogged tokens, only while movement is allowed; optimistic movement with server confirmation and rollback on rejection (messages: paused, GM away, blocked).

## 7. Privacy rules (the projection)

The server derives what players see with a strict **allowlist**, never a blocklist:
- Tokens: only `id, x, y, gridSize, color, borderWidth, imageSrc, showNumber, number, ownerId` (+ `portraitSrc` when it differs from `imageSrc`). Hidden tokens (`visibleToPlayers === false`) and tokens standing on fogged cells are removed completely, including from combat, and their art URLs are never sent. (Name is also withheld on the player's map.)
- Markers: only visible ones, allowlisted fields. Area effects: allowlisted fields. `playerViewRect`: x, y, width, height only.
- Combat: entries of removed tokens are dropped; NPC entries carry only `tokenId, initiative, condition`; heroes carry hp and maxHp.
- GM notes, NPC/quest data, plans, sheets, the token library and every other GM-only field never enter the scene at all.
- Write a **canary test**: fill every GM-only field with a unique marker string, drive every path (snapshot, patch, resume, reconnect, roster), capture every byte sent to a player socket and assert no marker appears.

## 8. Persistence

- **GM browser, IndexedDB** (one database with versioned upgrades; bump the version when adding a store): `maps` (saved scenes), `token_presets`, `token_categories`, `handouts` (image + thumbnail), `sheets` (PDF blobs), `quests`, `npcs`, `plans`. Same-origin use: the GM must keep using `http://localhost:5173`.
- **Server, `.realm-data/table.json`:** server secret, invite state, device records with keys, table mode, bans. Written atomically; corruption must not crash the server (start fresh and say so). Add `.realm-data/` to `.gitignore`.
- **Server memory:** the asset store (content-addressed images, bounded by quotas) and the player-facing scene copy.

## 9. Networking and security (the most important part)

### 9.1 Principles
- Plain HTTP and WS on the home LAN. **No TLS**: a self-signed certificate puts a full-screen warning on every phone and LAN IPs change with DHCP; no player feature needs a secure context. Security is **by invitation**, plus strict request checks, limits and an allowlisted projection. State plainly in the README what is NOT protected: traffic is not encrypted (Wi-Fi WPA2/3 is the protection), fog is an overlay (the whole map image is sent, so developer tools can reveal it), the invite stops strangers joining but does not hide traffic from someone who can capture Wi-Fi and knows the invite.
- Every server module is small, exports one factory, takes its collaborators and a **clock** as arguments, and is unit-tested with fake clocks and fake sockets.

### 9.2 Identity and admission
- **Invite:** a 22-character base64url secret `S` shown in the QR link `http://<ip>:5173/player.html#join=<S>` (in the fragment, which browsers never send), and an 8-character **table code** from a 31-symbol alphabet without I, L, O, 0, 1 (shown `ABCD-EFGH`, case-insensitive, accepted only while the GM's invite dialog is open and for 10 minutes after).
- **Join handshake** (HMAC-SHA256 via `@noble/hashes`, never `crypto.subtle`): the phone generates a random 32-hex `device` id, requests a server nonce, proves knowledge of `S` (or the code) with `HMAC(inviteKey, device|nonce)`, and the server answers with its own proof and a per-device key `dk` derived from the invite key, device, nonce and a server value. Every later WebSocket connection offers a one-time nonce and an HMAC proof with `dk` in the `Sec-WebSocket-Protocol` header (`rf3`, `auth.<device>.<nonce>.<proof>`), verified **during the HTTP upgrade**, so strangers never get a socket. A replayed identical join returns the same result (idempotent); a different nonce for an existing device is refused and counted as a strike.
- **Modes:** `Open` (anyone with the QR or code joins), `Ask first` (each new device waits until the GM presses Admit; the GM sees a join-request card with Admit/Deny and a count badge), `Locked` (no new devices; already admitted devices can reconnect).
- **GM controls:** Kick (device removed and keyless), Rename, **New invite** (rotates the secret and the code so old QR codes stop working), Lock/Unlock. Wrong-code guessing is rate-limited per IP and globally; a flood auto-locks the table. 5 failed proofs from one IP in a minute ban it for 5 minutes; the GM's own computer is never banned.
- **The GM connection** is authenticated differently: loopback source address **and** strict Host allowlist **and** Origin check **and** an HttpOnly `rf-gm` cookie set when `index.html` is served to a loopback client. No auth token in the subprotocol. A second GM window replaces the first (the first is closed with a final code).

### 9.3 HTTP hardening
- **Host allowlist** (localhost, 127.0.0.1, the machine's own LAN IPs and hostname) to defeat DNS rebinding: a request with any other `Host` gets 421, even from loopback. **Origin required** and must match for WebSocket upgrades and state-changing requests. Reject cross-origin.
- Cookie flags (`HttpOnly`, `SameSite=Strict`, `Path=/`). Security headers: `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`/`frame-ancestors 'none'`, a CSP (start in report-only), `Cache-Control: no-store` on API responses, long immutable cache for hashed assets.
- Static serving: path-traversal safe, from an in-memory map built at startup. `POST /hello` and `/join` require `Content-Type: application/json` and bodies of at most 512 bytes.
- **Assets:** only the GM (loopback + cookie + an `X-RF` header) may upload; `PUT /__realm/assets/<sha256>` must hash-match; sniff the bytes and accept only PNG, JPEG, WebP, GIF, AVIF (never SVG/HTML); per-file and total quotas; downloads need a valid device cookie/proof; egress pacing so a big map download does not flood Wi-Fi; unpinned assets are garbage-collected.
- Limits: per-IP and total socket caps, WebSocket upgrade rate limit, max devices (16 admitted, 4 pending), pending requests expire after 5 minutes, per-message-type frame size caps (players: tiny, 2 KB or less; GM scene up to 16 MB), per-type token-bucket rate limits, binary frames from players refused, oversize frames close with 1009. A 100,000-frame fuzz must never crash the hub.

### 9.4 WebSocket lifecycle (control channel `/session-sync?role=gm|player&v=3`)
HELLO (server version, limits) -> RESUME (client says its last revision and unacknowledged action ids) -> STATE_FULL or STATE_PATCH stream. Heartbeat PING/PONG every few seconds carrying the measured RTT and loss; silence detection closes and reconnects. **Reconnect** with exponential backoff (0.5 s x 2^n, cap 6 s, +/-30% jitter), immediately when the phone wakes or comes online; keep the revision across reconnects so a phone N patches behind gets N patches and one further behind (more than 64) gets a snapshot. Use close codes (e.g. 4001 replaced by another GM window, 4002 kicked/denied, 4004 version mismatch, 4008 abuse backoff, 4009 slow client dropped, 4010 server shutdown, 4011 auth failed with a fresh nonce to retry once). A phone with a cached older page that hits the old path must be told plainly to reload (HTTP 426).

### 9.5 State sync
- Scene publish from the GM is **throttled (about 40 ms) and coalesced**; only changes to the shared keys trigger a publish (pan/zoom/selection send nothing).
- The hub computes the projection, diffs it against the last (object-level JSON patch with stable array identity by `id`; falls back to whole-array replacement on duplicate/missing ids), bumps a **revision**, and sends `STATE_PATCH {rev, base, patch}` to each synced player. Slow clients: if a socket's send buffer exceeds 256 KB stop queueing patches for it and mark it stale; resend a full snapshot once it drains below 64 KB; close with 4009 if it never does. Every 50th patch carries a checksum of the projection that the client verifies, requesting a resync on mismatch.
- **Idempotent actions:** token move, ping and end-turn carry an action id `aid`; the hub remembers recent ids so a retry after reconnect never doubles an action; replies are `ACK {aid, ok, reason}`.
- **Token move rules** (server-side): token exists, is owned by this device, is visible and not under fog, movement is not paused, the GM is connected; position clamped to the map; applied to the hub's copy immediately and forwarded to the GM. Rejection reasons: `blocked`, `paused`, `away`.
- **Ping:** `PLAYER_PING {x,y}` -> clamp to map -> broadcast `MAP_PING {id, name, x, y}` to every player and the GM; 700 ms cooldown per device; never stored.
- **End turn:** `PLAYER_END_TURN {tokenId}` -> accepted only if that token is owned by the sender and is the combat's active token; a 1.5 s double-tap guard; forwarded to the GM, whose window re-checks and then advances the turn and shows "<name> ended their turn."

### 9.6 The invite dialog (GM)
A large QR code of the join link for the best LAN address (list other addresses if there are several), the address as text, the table code in big grouped characters with a Copy button, the three-way mode control with one-line explanations, "New invite" (confirm first), the device list with name, device label ("Android - Chrome"), status and connection quality, Admit/Deny/Rename/Kick (confirm kick), and troubleshooting text (same Wi-Fi, guest networks isolate devices, run `ENABLE-LAN.ps1`). The dialog tells the server the invite is being shown (this opens the typed-code window) while it is open. `Ctrl+Shift+D` on either page toggles a tiny network debug overlay (RTT, loss, reconnects, bytes, patches, last close code).

### 9.7 Firewall helper
`ENABLE-LAN.ps1`: checks for administrator rights, warns if the network profile is Public, creates a Private-profile-only inbound TCP rule for the app port, and (after asking) UDP rules scoped to the installed browsers' programs and the local subnet for WebRTC audio; idempotent; switches `-SkipUdp`, `-Yes`, `-Port`.

## 10. Sound

**Goal: no cut-offs.** Measured causes of cut-offs in a naive WebSocket design: a Wi-Fi stall longer than the player's buffer leaves about a second of silence and the audio then stays 1-3 s late forever; playing audio on the phone's main thread (no AudioWorklet on a non-secure origin) breaks when the UI thread freezes; phones whose audio hardware runs at 44.1 kHz click about once a second unless the context is pinned to 48 kHz; an unbounded relay queue lets a listener fall 10 s behind.

- **Capture (GM page, secure context):** share system/tab audio with `getDisplayMedia({audio:true})`; one GainNode applies master volume and mute for both transport paths.
- **Primary path: WebRTC.** The GM page creates an `RTCPeerConnection` per listening device and sends the captured audio track; the existing WebSocket is used only for signalling (`AUDIO_OFFER/ANSWER/ICE/LISTEN/SELECT/STATS/...`). No STUN/TURN: LAN host candidates only. Browsers hide host addresses behind random `.local` mDNS names, which often fail on Wi-Fi; the **server rewrites** those candidates to the phone's/GM's real LAN IPs (pure, unit-tested function in `candidates.js`; also sanitise SDP, cap sizes). Set a deep `jitterBufferTarget` (about 800 ms) so stalls up to about a second are inaudible. Up to 8-16 listeners must be fine on the GM PC.
- **Fallback path (automatic, per listener):** if ICE does not connect in a few seconds (or the player has no `RTCPeerConnection`), the server relays ADPCM (4-bit) audio packets over a dedicated audio WebSocket with a packet header carrying sequence number and timestamp. The relay queue is bounded (about 8 packets / 64 KB, drop oldest, flag the skip), at most 2 writes in flight, close with 4009 after 10 s without progress. The player runs an **adaptive jitter buffer / playout scheduler** (pure, injected clock, unit-tested): start around 1.2 s, never stay late after a stall (trim back to target + 150 ms), absorb clock drift with a tiny `playbackRate` trim (at most +/-0.3%, slewed), conceal lost packets, never play a duplicate or reordered packet twice, pin the AudioContext to 48 kHz, resume it after suspend, rebase if the sender's clock paused.
- **Keep sound alive on phones** (screen dim/lock/background): `navigator.wakeLock` where it exists, otherwise a hidden looping silent `<video>` trick (ship two tiny silent clips); require one user tap ("Tap to hear the music") for autoplay policy.
- **Targets (simulated):** zero dropouts at 1-10% packet loss and 80 ms jitter; a 1 s network stall causes no audible gap; after any longer outage the delay returns to the target within seconds.

## 11. Design system ("moonlit spell-library")

Arcane, ethereal, calm; dark indigo-ink surfaces, violet and cyan luminous accents, soft glows, glass-like layers; the map is the hero and the chrome recedes. No leather, brass or parchment.

- **Fonts (bundled):** Cormorant Variable for display (headings, brand, modal titles), Inter Variable for UI and body; tabular lining figures everywhere (HP, initiative, distances). Small-caps labels use Inter (Cormorant is too thin below 12 px).
- **Tokens (CSS custom properties, semantic names, not colour names):** surfaces `--surface-0..4` = `#060916 #0b1024 #121a35 #1a2447 #243060`, sunken input well `#050813`; borders `#1d2750 / #2c3a6c / #4458a0`, control border `#5a6cb0`; text `#eef2ff / #c6d0f2 / #a0acd6 / #8591c0`; primary accent violet `#a58bff` (hi `#cbbcff`, lo `#6a4fd6`); secondary accent cyan `#4fd8ee` (hi `#9bebf7`, lo `#1e8aa3`); arcane `#c792ff`; success `#4fe3a1`; warning `#ffc15a`; danger `#ff6f8e` (solid `#d8405f`); info `#6fb0ff`; light "moonlight vellum" `#e6eaff` with `#141a38` ink for the QR tile. Each accent has `-wash` and `-glow` variants. Also radii, a 4 px spacing scale, a type scale, shadows, motion durations (120/200/340 ms) and easings, a z-index scale, layout sizes.
- **Components:** buttons (default, primary, secondary, ghost, danger, icon, small/large), inputs, selects, segmented control, switch, chips, badges, avatar with initials, progress/HP bar, tabs, cards, rows with hover-revealed actions, empty states with art, modals (bottom sheets under 560 px), toasts, tooltips via `data-tip`, section headers with a rune line.
- **Token ring colours:** 26 presets (Violet #a58bff, Cyan #3fc4dc, Aurora #3fd08c, Rose #ff5c80, Azure #5a9cf0, Amber #f5b040, Moonlight #dfe5ff, Slate #8591c0, Crimson #e0384f, Coral #ff7a6b, Orange #ff8a3d, Gold #f2c94c, Lemon #f6ee6a, Lime #a6e22e, Emerald #1fb870, Teal #20c4b0, Sky #5ec8ff, Cobalt #3b6dff, Indigo #6f7bff, Purple #b45cff, Magenta #e84bd0, Pink #ff9ecb, Sand #e8dcc0, Tan #c9a57a, Bronze #b8763a, Graphite #5b6478) plus a free picker.
- **Motion:** purposeful and subtle; respect `prefers-reduced-motion` globally.

### Branding
- **Logo mark:** a faceted crystal d20 (violet facets, a cyan "Y" of inner edges) cradled from below by a white crescent moon, with a small cyan flame above its top vertex. Provide it as SVG (`mark.svg`, square viewBox, transparent), a favicon (mark on a dark rounded square), a **seal** (the mark inside a double ring with 12 small rune ticks and diamonds, soft violet glow) used on the GM welcome card and the player join gate, a 192/512 px app icon, an apple-touch icon, a web manifest for the player page (`start_url /player.html`, standalone), and a README banner. Generate placeholders yourself; they will be replaced by the final art.
- **Empty-state art:** four small line illustrations (map scroll, empty token stand, door with light underneath, lantern) as transparent PNGs used in the Scenes, Tokens, Table and Quests/NPCs empty states.

## 12. Performance requirements and known pitfalls

Build these in from the start; each one was a measured problem in a previous build.
1. **Cap Konva's pixel ratio** at 1.75 (`Konva.pixelRatio = Math.min(devicePixelRatio, 1.75)`): phones report 3x and repaint nine times the pixels otherwise.
2. **Big maps:** build a downscaled proxy canvas (longest side about 1400 px) once per map and draw it while the view is moving (pan, wheel, pinch, drag), swapping back to the full image about 140 ms after motion stops. Full redraws of a 4096 px image on every frame were the single biggest cost.
3. **No `shadowBlur`/`shadowColor` on frequently redrawn canvas shapes** (tokens, rings, markers, areas, pings, frames). Use extra translucent strokes for glow.
4. **Throttle Konva animations** (turn ring about 22 fps, pings about 30 fps); return `false` from the animation callback to skip a repaint. Keep animated shapes from forcing the token layer to redraw more often than needed.
5. **Fog and grid are each ONE Konva shape** (a single path), never one node per cell or line.
6. **No `backdrop-filter` over the changing map** on the GM screen, and none on the player HUD; use near-opaque tinted backgrounds. No animated `box-shadow`/`filter` on large elements.
7. Fewer than about 6 Konva layers (put pings and measure overlays inside the token layer).
8. **Code-split:** the session planner/TipTap, and anything the player does not need, load lazily; players must never download the editor. Manual chunks for `react` and `konva`.
9. Players: dvh units, safe-area insets, no hover-dependent interactions, `touch-action` set so pinch-zoom works, reduce blur and shadows, small bundle (aim for about 250 KB first load including fonts).
10. Debounce autosaves, hash image digests rather than whole data URLs when caching uploads, and shrink uploaded images (maps to 4096 px, token art to 384 px, photos to 1600 px before cropping).
11. Locale pitfall: never use locale-sensitive `toLowerCase()` for identifiers (a Turkish locale turns "I" into a dotless i). Use `toLowerCase` only on known-ASCII strings or `toLocaleLowerCase('en-US')`/`ToLowerCase` with the invariant culture.
12. IndexedDB: bump `DB_VER` whenever you add an object store; open/close per operation.
13. The stage pan/zoom must not re-render the whole React tree more than necessary; keep per-frame view changes cheap.

## 13. Tests (write them as you go; `npm test` must stay green)

- **Pure/unit:** protocol constants and caps (every message type has a cap, Sets are frozen), HMAC against `node:crypto` (1,000 random inputs plus RFC 4231 vectors) and working without `crypto.subtle`, invite/code normalisation, handshake proofs and replay handling, host guard (including DNS-rebinding cases), IP limiter, table store persistence and corruption, devices admission modes, asset sniffing/quotas, status/metrics, state-sync diffing (random edit sequences always reproduce the next state; identity preserved for untouched items), combat reducer, ownership rules, projection/privacy including the **canary test**, planner text/export helpers, jitter/playout scheduler (fake clock; stall, jitter, drift, loss and reorder scenarios; no click, no permanent lateness), SDP and candidate rewriting, ADPCM codec round-trip, ping and end-turn rules.
- **Over real sockets:** hub state sync and resume, action ACKs and idempotency, limits and fuzz (100,000 random frames), slow-client policy, GM replacement and GM-away behaviour, the full join flow in each mode, kick and rotate.
- **Harness (in `test-support/`):** fake clock, fake socket, a **FIFO** TCP impairment proxy (delay, jitter, burst stalls; it must never reorder), a UDP loss/jitter relay, a sine-wave continuity analyser that finds a planted 12 ms hole, and a helper that boots a table with a GM and N players.
- **Acceptance scripts** (separate from `npm test`): `accept-net` (token-move latency p50/p95/p99, snapshot bytes and time for a 4096x4096 map with 5,000 fog cells and 30 tokens, memory per player, reconnect churn, soak), `accept-security` (the join/Host/Origin/limits/fuzz checks against a live server), `accept-audio-ws` and `accept-audio-rtc` (headless Edge driven over the DevTools protocol with `ws`, sine continuity and `RTCPeerConnection.getStats()`), `check-player-browser`, and a `check-eol` script.
- **Targets to aim for:** token move to 8 players p95 under 10 ms on loopback; STATE_FULL for the reference scene about 12 KB on the wire; token-move patch under 300 bytes; under 300 KB of server memory per player and flat over a long session; at least 50 automated security checks.
- Write `docs/real-device-checklist.md` listing what only real phones can verify (iOS Safari WebRTC over http, audio after screen lock, 44.1 kHz and Bluetooth clicks, the Windows firewall UDP rule on the user's router, multicast/mDNS behaviour), each as a checkbox with the planned response if it fails.

## 14. Build order (verify at the end of each step; do not skip ahead)

1. Project skeleton: Vite multi-page, scripts, `START.bat`/`START-DEV.bat`, design tokens, fonts, icon generator, base components, brand placeholders. `npm run build` and `npm test` green.
2. Domain core without UI: scene store/reducer, combat reducer, ownership, projection (with the canary test), state diff/patch. All unit tested.
3. Network contract: `protocol.js`, `hmac.js`, tests. Then server modules in dependency order (clock, lan, hostGuard, ipLimiter, tableStore, devices, invite, handshake, assets, http, status, access), then hub (validate, session, stateSync, actions, roster, hub, realm) and production server. Tests with fake clocks and real sockets.
4. Client links: connection (reconnect/resume), joinClient, deviceStore, gmLink, playerLink, facade.
5. GM shell and map: header, rail, map canvas with grid, fog, tokens, markers, areas, pings, player frame, scene save/load, import map. Add the performance measures of section 12 now, not later.
6. GM panels and modals: tokens (with library, max HP, colour picker), combat, table, scenes, notebooks, sheets, handouts, spells, markers, settings; invite dialog, join requests.
7. Player app: join gate and all state screens, map, initiative bar, tool rail (ping, measure, end turn), handouts, menu, debug overlay.
8. Session planner (lazy chunk).
9. Sound: playout/jitter pure modules first, then the WebSocket fallback, then WebRTC with candidate rewriting and signalling, keep-awake, GM sound panel, player pill.
10. Hardening and acceptance: run the acceptance scripts, fix findings, write the README (quick start, GM guide, player guide, networking and what is not protected, project layout), `docs/network-design.md` summary, firewall script.

## 15. Working agreements

- Work autonomously; make sensible decisions and record them in `docs/decisions.md`. Ask a question only if something would be hard to reverse.
- Keep modules small and named by what they do. Comment the *why* (especially for privacy and network rules), not the *what*.
- Never run experiments on port 5173 if something else may be using it; use ports 5290-5299 and stop what you start. Use temporary data directories for tests (`REALM_DATA_DIR`).
- Before claiming something works, run it: build, tests, and a real headless-browser smoke check (GM opens, invites, a player joins, a token moves, a ping appears, end turn works, a handout reveals). Report honestly what was NOT verified (real phones, real Wi-Fi, real firewall).
- Deliverable: the working project in the new folder, `npm test` green, `npm run build` green, `START.bat` working, and a short final report listing what was built, what was measured (numbers), and what still needs a real device.
