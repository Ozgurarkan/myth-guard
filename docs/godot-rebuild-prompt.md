# Rebuild "Myth Guard" in Godot: brief for the coding agent

You are a senior game/tools engineer. Rebuild **Myth Guard**, a local virtual tabletop (VTT) for Dungeons & Dragons, as a **Godot 4 project** in a NEW, empty folder. This document is the whole brief. "Must" is a requirement. Where something is unspecified, pick the simplest option that satisfies the intent and record the choice in `docs/decisions.md`.

## 0. Reference implementation (read-only)

A finished web version (React + Vite + Konva + Node WebSocket server + Capacitor) exists at:

`C:\Users\K0tal\OneDrive\Desktop\Games\Cyberpunk RED\APP`

Use it as a **behavioural reference only**. Do not modify that folder, and do not port code line by line. Rewrite idiomatically in GDScript. Read these first:

- `README.md` for features and the player/GM experience.
- `docs/network-design.md` and `docs/rebuild-prompt.md` for the security model, the sync design and the earlier rebuild spec.
- `src/store.jsx` for the scene shape and every GM action.
- `src/combat.js`, `src/playerView.js`, `src/syncPatch.js`, `src/ownership.js`, `src/pings.js`, `src/utils.js` for the rules you must preserve.
- `test/*.test.js` for the guarantees to keep (especially `combat`, `playerView`, `syncPatch`, `ownership`, `canary`).

If you cannot read that folder, this document is enough.

## 1. What the product is

A **local-network** virtual tabletop. One person, the **Game Master (GM)**, runs the app on a PC. **Players** join from their phones or tablets on the **same Wi-Fi**. No accounts, no cloud, no internet requirement, no telemetry. The GM's app is the single source of truth. Players never receive anything the GM has not allowed (hidden tokens, fogged tokens, exact creature HP, private notes).

**Deliverable:** one Godot project that exports to:
- **Windows** (GM and player roles; Linux/macOS exports are a bonus, not required),
- **Android** (player role first; the GM role should work on a tablet but is not the priority),
- **iOS** (player role first).

Role is chosen on the start screen (**Host a table** / **Join a table**). Phones show *Join* prominently; hosting is available everywhere but is desktop-first in layout.

**Non-goals for this build:** internet/relay play, accounts, a rules engine (see section 11 for the hooks to leave), 3D, voice/video chat.

## 2. Decisions already made (do not re-litigate)

| Topic | Decision | Reason |
|---|---|---|
| Engine | Godot **4.4 or newer** (use the latest stable 4.x installed; record the exact version). GDScript with **static typing** everywhere. No C#, no GDExtension unless a section below says so. | Smallest toolchain; works on all three targets. |
| Renderer | **Compatibility** (OpenGL) for the whole project. | Widest phone support; 2D only. |
| Players are native apps | Players install the Godot app (Android/iOS/PC). There is **no browser player** in this build. | A browser player needs a Godot web export, which is heavy and constrained. Keep the transport behind an interface so a web player can be added later (section 6.1). |
| GM is the server | The GM app **hosts** the table in-process. There is no separate Node server. | Removes the whole server/launcher layer. Consequence: when the GM app closes, the table ends. Players show "The GM left the table" and keep trying to reconnect. |
| Persistence | Files under `user://` (JSON for data, raw files for images/PDFs/audio). No database. | Simple, inspectable, portable. |
| Look and feel | Dark fantasy "Myth Guard" theme: bundle **Inter** and **Cormorant Garamond** (both OFL). Icons are bundled SVGs (Lucide, ISC licence). A single `Theme` resource holds the design tokens (colours, spacing, radii, font sizes). No hard-coded colours in scenes. | Consistency and easy reskinning. |

## 3. Ground rules for how you work

1. **Plan first.** Before writing game code, write `docs/decisions.md` (stack, versions, the decisions above, anything you add) and `docs/architecture.md` (autoloads, scene tree, message catalogue, data model). Keep both up to date.
2. **Work in milestones** (section 10). After each: run the tests, run the project headless to check for parser/script errors, and commit with a clear message. Do not start the next milestone on a red build.
3. **Test what can be tested without a device** (section 9). Be explicit in your reports about what you verified automatically, what you verified by running the desktop app, and what is **unverified because it needs a real phone**. Never claim a device behaviour you did not observe.
4. **Do not invent assets you cannot license.** Use only: OFL fonts, Lucide icons, and art you generate procedurally or draw as simple vector shapes. No copyrighted D&D art, text or trademarked logos. Placeholder token art is a coloured disc with initials.
5. **Security rules apply to every line of networking code** (section 6.3). In particular: never decode untrusted bytes with object decoding enabled.
6. Keep scripts small and single-purpose. Prefer signals and autoload services over deep node-path lookups. Name files in `snake_case.gd`, classes in `PascalCase`.
7. All files use **LF** line endings. Add a `.gitattributes` and `.editorconfig`.

## 4. Feature specification

### 4.1 GM screen (desktop layout)

Five regions: **header** (scene name, table status pill, import/save), **tool rail** (left), **map** (centre), **sidebar with tabs** (right), **status bar** (hints). Everything is keyboard-operable on desktop, with visible focus.

**Sidebar tabs**

| Tab | Behaviour |
|---|---|
| **Scenes** | Save/open/rename/delete scenes (map + tokens + fog + areas + markers + combat). Warn before losing unsaved changes. Autosave to a recovery file every 60 s. |
| **Tokens** | Heroes, creatures, objects. Add, edit, duplicate, delete; reveal/hide to players; favourites in a reusable **library** (presets). Fields: name, art (image), category (PC/NPC/object), `characterType` (`pc` or `npc`), size in grid cells, `maxHp`, optional number badge, `visibleToPlayers`. |
| **Combat** | Roll or type initiative per token, sort descending, next/previous turn, round counter, HP with one-click damage/heal, remove from combat. |
| **Table** | Connected devices with connection quality, admission mode, which hero belongs to which player, kick. |
| **Quests / NPCs** | Private searchable notebooks (title, rich-ish text, tags). An NPC can be placed on the map as a **hidden token**. |
| **Sheets** | Character sheets docked beside the map, switchable with number keys 1-9. See the PDF note in 4.4. |
| **Handouts** | Preview privately, then reveal an image to all players full screen; hide again. |
| **Spells / Markers** | Measured **circle, square, cone** area templates sized in feet, coloured by damage type. Map markers (points of interest) with colour, label and visibility. |
| **Sound** | A music/ambience player. See 4.5. |
| **Settings** | Grid size, feet per cell, snap-to-grid, fog on/off, the **player frame** (the rectangle players may see), table admission settings. |

**Map tools** (tool rail, with the keys from the web app): `V` select, `H` pan, `M` marker, `F` fog-hide brush, `E` fog-reveal brush, `C`/`R`/`K` circle/square/cone area, `G` grid toggle, `P` player frame, `S` sheets, `Delete` remove selection, `Ctrl+S` save, `?` shortcut help.

**Map behaviour**
- Pan (middle-drag, `H`, or two-finger), zoom (wheel/pinch) around the pointer, with sane limits.
- Background map image of up to 4096 px; grid overlay with configurable cell size; optional snap.
- **Fog of war** by grid cells, painted with a continuous brush: fast drags must leave no gaps (interpolate between samples). The GM sees fog translucent; players see it opaque. Persist fog as a set of cells.
- Tokens: drag to move (snap optional), size in cells, circular crop of art, selection ring, number badge, **hidden tokens drawn faded on the GM map**.
- Area templates: drag to size, or type exact feet (radius / width x height / length + spread angle for cones). Convert feet to cells with `feet_per_cell`. Snap when snap is on.
- Pings: a glowing ripple with the pinger's name; GM and players both see it. Rate-limit per sender.
- A **turn chip** over the map during combat with *Next turn*.
- Status bar shows context hints for the active tool.

### 4.2 Player screen (touch-first)

- Map within the GM's **player frame** only; the player can pan and pinch-zoom inside it, never beyond.
- **Drag your own hero** (only when the GM has assigned one and allows movement). A centre-on-my-hero button.
- **Turn order** bar at the top. On your turn: a banner and a **haptic buzz** (`Input.vibrate_handheld`).
- Right-edge tool rail: **Ping** (tap tool, then tap map; one tap, one ping), **Measure** (drag to show feet and squares; local only; starts on a hero if you touch one), **End turn** (enabled only on your hero's turn).
- **Handouts** appear full screen with *Hide for now* / *Show the handout*.
- Connection pill (connected / reconnecting / quality). Dropped connections rejoin automatically with jittered back-off and resume.
- Keep the screen awake while connected (`DisplayServer.screen_set_keep_on`). Respect safe areas (`DisplayServer.get_display_safe_area`). All touch targets at least 44 px.
- Creatures show a **condition** (Healthy, Wounded, Badly wounded, Almost dead, Down) instead of numbers; heroes show exact HP. Reproduce `healthCondition` thresholds from `src/combat.js`.

### 4.3 Joining and admission

- **LAN discovery:** the host broadcasts a small UDP beacon (table name, version, port, join-mode). The Join screen lists tables it hears. Beacons carry no secrets.
- **Join methods:** (a) pick a discovered table and enter the **8-character table code**; (b) type host IP plus code manually; (c) *stretch:* scan the host's **QR code**. The QR encodes `address:port` plus the invite secret. QR *display* is required (implement or vendor a small MIT-licensed QR encoder as a script); QR *scanning* on phones needs a camera plugin and is optional. Record what you did.
- **Admission modes:** *Open*, *Ask first* (GM sees name + device label and presses Admit/Deny; auto-deny after 5 min), *Locked*. **Kick**, **Rotate invite** (old codes stop working; seated players stay), **Rename**. Wrong codes are rate-limited and repeated failures lock the table.
- A phone remembers the table and device identity so wake/reload/reconnect needs no code. Clearing app data counts as a new device.
- Limits: 16 admitted devices, 4 pending.

### 4.4 Character sheets

Godot cannot render PDFs. Decide and document one approach:
- **Required:** import sheet pages as **images** (PNG/JPG/WebP) and show them in a docked viewer with zoom/pan, tabs and rename.
- **Desktop convenience:** if a `.pdf` is imported, store it and open it with `OS.shell_open` in the system viewer.
- Do not spend time writing a PDF renderer. Structured (non-PDF) character data is a later feature (section 11).

### 4.5 Sound

The web app captured PC audio and streamed it live. Do **not** replicate capture. Replace it with:
- A GM **music/ambience library** (import OGG/MP3/WAV into `user://audio/`), play/pause/seek/loop/volume, per-track and master.
- Selected players receive the track file **once** (as a content-addressed asset, section 6.5) and play it **locally**, kept in sync by messages (`AUDIO_PLAY {asset, position, server_time}`, pause, seek, volume). Use a measured clock offset to align start positions.
- Per-player mute and a GM-side list of who is listening.
- Phones need no "tap to hear" gate in a native app; do not add one.

### 4.6 Session planner

A markdown-style editor for session notes: `TextEdit` with a toolbar (headings, bold, italic, lists, task checkboxes, highlight) and a rendered preview using `RichTextLabel` BBCode. Plans are stored as files, listed and searchable. No WYSIWYG engine; keep it simple.

## 5. Data model

Define each as a typed `Resource` subclass or a typed `Dictionary` wrapper with `to_dict()` / `from_dict()`; all persisted data is **JSON with a `schema_version`**, loaded through a validating function that rejects wrong types and clamps ranges. Cross-check shapes against `src/store.jsx`.

- **Scene:** id, name, map asset hash, grid (cell px, feet per cell, snap), fog cell set, tokens[], area effects[], markers[], player frame rect, combat, handout state.
- **Token:** id, name, art asset hash, category, `character_type` (`pc`|`npc`), position (px), size in cells, `max_hp`, number, `visible_to_players`, `owner_device_id` (optional).
- **Combat:** entries `{token_id, initiative, hp, max_hp}`, `active_id`, `round`.
- **Area effect:** id, type (`circle`|`rect`|`cone`), position, dimensions in px, colour (damage type), angle, direction.
- **Marker:** id, position, colour, label, `visible_to_players`.
- **Library items:** token presets, quests, NPCs, plans, sheets, handouts, audio tracks.
- **Assets:** content-addressed by SHA-256 in `user://assets/<hash>`; maps are downscaled (max 4096 px, default 3072) and re-encoded (WebP) before hashing. Reject images over a sane decoded-size limit (decompression-bomb guard).

## 6. Networking and sync

### 6.1 Transport

Use Godot's `SceneMultiplayer` **but do not use scattered `@rpc` calls for game logic.** Define one message envelope `{type: String, aid?: int, ...}` sent as JSON-encoded bytes through `SceneMultiplayer.send_bytes` (reliable channel for state/actions; a separate unreliable-ordered channel for pings/measure/cursor). Put the transport behind a small interface (`NetTransport`) so ENet and WebSocket (`WebSocketMultiplayerPeer`) can be swapped. Default: **ENet** (UDP) with Godot's built-in DTLS **off** (same trade-off as the web app: no TLS on a home LAN; see section 6.3).

Autoloads (suggested): `Net` (transport + sessions), `Session` (roster, admission), `GameState` (the host's scene), `Assets` (store + transfer), `Settings`, `Haptics`.

### 6.2 State sync (keep the proven design)

- The host holds the **full scene**. It derives a **player projection** using a strict **allowlist** per collection (unknown fields are dropped), then sends `STATE_FULL {rev, state}` to a joining device and `STATE_PATCH {rev, base, patch}` afterwards. Reproduce `src/playerView.js` and `src/syncPatch.js` semantics: the projection hides hidden tokens, tokens under fog, hidden markers, private notes, and **numeric HP of NPCs** (players get `condition` only). `rev` increases only when the projection changes.
- Keep the last 64 patches so a device that blinks for a few seconds receives patches instead of a snapshot; otherwise send a snapshot.
- **Idempotent actions:** player actions (`PLAYER_TOKEN_MOVE`, `PLAYER_END_TURN`, `PING`) carry an `aid`; the host de-duplicates the last 64 per device and answers `ACK {aid, ok, reason}` with reasons `blocked | paused | away | not-your-turn | rate | invalid`. The client rolls back an unacknowledged move after 5 s.
- **Ownership rules** from `src/ownership.js`: a player may move only the token assigned to them, only when the GM allows it, only inside the frame and not into fog.
- Backpressure: if a peer's outgoing queue grows past a threshold, mark it stale, drop intermediate patches, and send one snapshot when it drains.

### 6.3 Security (do not skip)

Threat model: guests and other devices on the same Wi-Fi, and malformed or hostile packets. The design is **secure by invitation, not by encryption** (no TLS on a home LAN; say so plainly in the README).

1. Use `SceneMultiplayer`'s **authentication** hook (`auth_callback`, `send_auth`, `complete_auth`) so no peer is part of the multiplayer session until it passes the handshake. Peers that do not complete auth within a few seconds are disconnected.
2. **Invite secret `S`** (16 random bytes) and **table code `C`** (8 chars from `ABCDEFGHJKMNPQRSTUVWXYZ23456789`). First join proves knowledge of `S` or `C` with an HMAC-SHA256 over device id + nonce (`Crypto.hmac_digest`), and the host proves it too (mutual proof), then both derive a per-device key `dk`. After join, `S` and `dk` never cross the network again; every reconnect proves possession of `dk` with a fresh host nonce. Port the exact flow from `docs/network-design.md` section 4.3, adapted to the auth hook.
3. **Never decode untrusted data with objects.** Set `allow_object_decoding = false`. Parse JSON only, then **validate every message** against a per-type schema (types, ranges, string lengths, array sizes). Unknown types are dropped and count as a strike.
4. **Limits:** per-message-type size caps and rate limits (token move, ping, end turn), per-peer and global connection caps, strikes then a temporary ban. Player max packet about 16 KB; host-to-player assets are chunked.
5. Wrong table codes: 5 per source IP per minute, then a 5-minute ban; 30 per minute globally locks the table and tells the GM.
6. **Canary test:** build a scene where every GM-only field holds a unique `CANARY-...` string, plus a hidden token, a fogged token and NPC hit points. Capture **every byte** the host would send to a player over: first snapshot, each kind of patch, reveal-then-hide, reconnect snapshot, resumed patches, ping, roster. Assert none contains a canary, a hidden token's id or name, or an NPC's numeric HP. This test must exist and must run in CI.
7. State the known limits in the README: Wi-Fi traffic is not encrypted; fog is an overlay (the whole map image is shared), so a motivated player could extract it; use Rotate/Kick after a guest leaves.

### 6.4 Clocks and reconnects

Heartbeat every 4 s; consider a peer dead after about 12 s of silence. Reconnect with exponential back-off plus jitter and **resume** from the last applied `rev`. Measure round-trip and expose it in the connection pill and in a debug overlay (`Ctrl+Shift+D`).

### 6.5 Assets

Content-addressed (`SHA-256` via `HashingContext`), uploaded/served in chunks over the reliable channel, resumable, verified by hash on receipt, cached in `user://cache/assets/`. A player only receives assets for things it is allowed to see (hidden-token art is never sent). Pace large transfers so they do not starve state patches (cap bytes per frame, lower priority than state). Use quotas and an LRU eviction that never evicts assets referenced by the live scene.

## 7. Rendering and input details

- Map root is a `Node2D` with a `Camera2D` (or a manually transformed container). Pointer logic must work for **mouse, touch and pen**: use `InputEventScreenTouch/Drag` plus `InputEventMagnifyGesture/PanGesture`, and for desktop testing enable `input_devices/pointing/emulate_touch_from_mouse` behind a debug setting.
- Fog rendering: keep a cell bitset; render it as a small `ImageTexture` (one pixel per cell) scaled up with a shader that softens edges. Update only dirty regions. The GM view uses partial alpha; the player view full alpha.
- Grid: a shader or a cached line batch; no per-frame thousands of `draw_line` calls.
- Tokens: a reusable scene with a circle-mask shader for art, a selection ring, a number badge and a hidden-state fade.
- Area templates: draw in `_draw()` with antialiasing; cones use a polygon fan.
- UI: `Control` nodes with anchors and containers; `content_scale_mode = canvas_items`, `content_scale_aspect = expand`; the GM layout is desktop-first, the player layout is portrait phone-first. One `Theme` resource.
- Respect OS reduced-motion where available; keep animations short and optional.

## 8. Platform notes you must handle

- **Android:** produce an export preset, minimum SDK compatible with Godot 4.4+, arm64-v8a. Permissions needed: `INTERNET`, `ACCESS_NETWORK_STATE`, `ACCESS_WIFI_STATE`, `CHANGE_WIFI_MULTICAST_STATE` (UDP broadcast discovery often needs a multicast lock; check whether Godot's Android template handles it and document any plugin needed), `VIBRATE`, `WAKE_LOCK`. Document keystore creation. Build a debug APK if the SDK is present; otherwise ship the preset plus exact steps.
- **iOS:** exports an Xcode project and **requires macOS and an Apple developer account**. You cannot build it on Windows. Deliver the export preset, `Info.plist` entries (`NSLocalNetworkUsageDescription`, `NSBonjourServices` if used), and a `docs/ios.md` with exact steps. Do not claim the iOS build works; say it is unverified.
- **Windows:** export a runnable `.exe` (+ `.pck` or embedded). Add a first-run note about allowing the app through the Windows firewall on **Private** networks, and a `docs/firewall.md` (UDP + TCP port range used). Pick fixed default ports and make them configurable.
- **Discovery caveat:** guest/AP-isolated Wi-Fi blocks broadcast and device-to-device traffic. Always offer manual IP + code entry and say why in the UI.

## 9. Testing

Use **GdUnit4** or **GUT** (pick one, record why) and make tests runnable headless from a script: `scripts/test.ps1` (Windows) and `scripts/test.sh`. Put pure logic in scripts with **no scene dependencies** so it is testable.

Must have automated tests for:
- **Combat reducer:** normalise, upsert, remove, next/previous with round increment and floor at round 1, `health_condition` thresholds, NPC numeric-HP hiding (port `test/combat.test.js`).
- **Player projection** allowlist and fog/hidden filtering (port `playerView` tests) **plus the canary test** (6.3).
- **Patch diff/apply** (port `syncPatch` tests): round-trip, revisions, snapshot fallback, history window.
- **Ownership/move rules** and **rate limits**.
- **Handshake:** mutual proof, wrong secret, replayed nonce, expired nonce, revoked device, kick, rotate invite.
- **Message validation:** fuzz at least a few hundred random/malformed payloads; none may crash the host or be accepted.
- **Persistence:** save/load round trip, schema-version upgrade, rejection of corrupt files.
- **Feet-to-cells and area geometry** (circle/rect/cone point-in-shape and sizing).
- A **loopback integration test**: start a host and two simulated clients in one headless process, join, move a token, change fog, run combat, and assert the clients' views.

Add a manual `docs/real-device-checklist.md` for what cannot be automated (discovery on real Wi-Fi, haptics, sleep/wake, backgrounding, pinch gestures, audio sync, low-end Android). Mark every item *unverified* until a human ticks it.

## 10. Milestones (each ends green, committed, and reported)

**M0: Foundation.** Project skeleton, theme, autoloads, `docs/decisions.md`, `docs/architecture.md`, test runner, CI-style script, role-select start screen, export presets stubbed. *Done when:* the empty app runs on desktop and tests execute headless.

**M1: Map and tokens (single machine).** Camera pan/zoom, map import and downscale, grid, tokens (add/edit/drag/hide), library presets, scene save/load. *Done when:* a scene survives restart.

**M2: Fog, areas, markers, pings, measure.** All map tools with their shortcuts; gap-free fog brush; area templates in feet; frame editing. *Done when:* the tool behaviours in 4.1 work with mouse.

**M3: Combat.** Initiative, turn chip, HP, conditions, round counter; reducer fully tested.

**M4: Networking core.** Transport interface, authentication hook, handshake, roster, admission modes, kick/rotate, discovery beacons, heartbeat/reconnect/resume. *Done when:* the loopback integration test and handshake tests pass.

**M5: Sync and the player view.** Projection, snapshots, patches, history, ACK/aid, ownership, backpressure, canary test. Player screen with touch pan/zoom, drag own hero, turn order bar, ping, measure, end turn, handouts. *Done when:* two desktop instances (one host, one player) play a full combat on one PC, and the canary test is green.

**M6: Assets and sound.** Content-addressed transfer, caching, pacing; music library and synchronised playback.

**M7: GM library tabs.** Quests/NPCs (including NPC as hidden token), sheets (images/PDF open), handouts, session planner, settings polish, shortcut help overlay, debug overlay.

**M8: Mobile.** Android export and debug APK (if the SDK is available), touch/safe-area/haptics/keep-awake, iOS preset and docs, real-device checklist, README for hosts and players.

After M8, stop and write a short report. **Do not start section 11.**

## 11. Future work to leave room for (do not build now)

The product will later add the full D&D rules content: **spells, monsters, attacks, conditions, dice, structured characters, spell slots, damage resolution, and "game feel" effects** (dice animation, floating damage, hit flashes, spell VFX, audio cues). Prepare for it without building it:

- Keep game data in **data-driven resources/JSON** loaded through a `RulesData` autoload (empty for now) so SRD content can be dropped in. Licensing note: only SRD 5.1/5.2 (CC-BY-4.0) content may be bundled; anything else would be user-imported.
- Give tokens an optional `stats` dictionary field (ignored today, persisted and round-tripped).
- Keep the combat reducer pure and extensible so `DAMAGE` / `HEAL` / `APPLY_CONDITION` actions can be added.
- Route all visual feedback through one `Feedback` autoload (floating text, flashes, haptics, sounds) with no-op defaults, so effects can be added in one place later.
- Keep the message catalogue versioned (`PROTOCOL_VERSION`) with schema-per-type validation, so new player actions (attack, cast) are one schema plus one handler.

## 12. Reporting

At the end of each milestone, reply with: what changed, test results (counts and failures), what you ran by hand, what is **unverified** (and why), and decisions you added to `docs/decisions.md`. If you must deviate from this brief, say so and why before doing it, not after.
