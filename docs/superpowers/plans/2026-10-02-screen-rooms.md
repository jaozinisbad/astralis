# Salas de transmissão Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Discord-like client flow with an original, responsive Astralis experience for creating, discovering, and watching screen-sharing rooms on desktop and mobile web.

**Architecture:** Add an in-memory room registry and role-checked Socket.IO signaling to the existing server. The Electron desktop client publishes screen media directly to viewers over WebRTC; guests can use a narrow, unauthenticated spectator socket, which receives only room-view and signaling handlers. Replace the current server/chat/voice shell with a responsive rooms home and room stage, retaining the existing account and profile flows.

**Tech Stack:** React 18, Vite, Electron, Socket.IO 4, WebRTC, Node.js `node:test`.

**Spec:** `docs/superpowers/specs/2026-10-02-screen-rooms-design.md`

## Global Constraints

- There is no chat, microphone, in-app voice, or communication call in a room; users communicate in Discord.
- The host must be authenticated; a spectator may watch by link without an account; private rooms require their access code.
- Room metadata and presence are in memory and the room ends when its host disconnects.
- Screen media travels host-to-viewer over direct WebRTC; the Render server handles signaling only and no database schema changes are made.
- Only the host may create a room or offer media; signaling targets must be members of that same room.
- Quality controls expose 576p, 720p, 1080p; 15, 24, 30, 60 fps; and bitrates up to about 8 Mbps.
- The Discord-audio exclusion remains Electron/Windows-only and is labeled experimental; the spectator browser never requests microphone or display-capture permissions.
- Astralis uses its own identity and visual assets; Crystal is a functional reference only.

## Review Focus

- Private room codes must not leak through public discovery — test list serialization for private rooms.
- Guest sockets must not receive legacy chat, account, or voice handlers — test the visitor branch and room-only operations.
- An unrelated socket must not receive WebRTC signaling — test offer, answer, and ICE room/role checks.
- Host disconnect and viewer disconnect have different lifecycle behavior — test that the host closes the room while a viewer only leaves.
- Deep links and narrow screens must still load the spectator view — test hash-route parsing and render mobile-friendly video semantics.

---

### Task 1: In-memory screen-room registry

**Files:**
- Create: `server/streamRooms.js`
- Test: `server/tests/streamRooms.test.js`

**Interfaces:**
- Produces `createStreamRoomManager({ makeId, makeCode } = {})` with methods `createRoom({ ownerSocketId, ownerId, ownerName, name, visibility })`, `joinRoom({ roomId, socketId, userId, accessCode })`, `leaveRoom(socketId)`, `endRoom(roomId, socketId)`, `setLive(roomId, socketId, isLive)`, `listPublicRooms()`, `getRoom(roomId)`, `getSocketRole(socketId, roomId)`, and `canSignal({ roomId, fromSocketId, toSocketId, signalType })`.
- `createRoom` and `joinRoom` return `{ ok, room, role, accessCode, hostSocketId, peerSocketIds, error }`; irrelevant fields may be omitted. Only the creator receives a private room's code. Public discovery includes only live public rooms and never a code.
- Inputs use `visibility: 'public' | 'private'`; names are trimmed and limited to 60 characters. Private codes contain eight random non-ambiguous characters.

- [ ] **Step 1: Write failing tests** for creating public/private rooms, code secrecy, correct/incorrect private access, host/viewer roles, live-only discovery, signaling membership/role rules, and distinct host/viewer disconnect behavior.
- [ ] **Step 2: Run** `npm test -- --test-name-pattern='screen room'` from `server`; verify failures identify the missing manager/behavior.
- [ ] **Step 3: Implement** the manager with injected ID/code generators for deterministic tests and in-memory maps for rooms and socket membership.
- [ ] **Step 4: Run** `npm test` from `server`; all existing and new tests must pass.

### Task 2: Isolated visitor sockets and room signaling

**Files:**
- Modify: `server/index.js`
- Modify: `server/streamRooms.js`
- Test: `server/tests/streamRooms.test.js`
- Test: `server/tests/realtime.test.js`

**Interfaces:**
- Produces `registerStreamRoomEvents({ socket, io, manager })` in `server/streamRooms.js`.
- Events: `salas:listar` acknowledges `{ rooms }`; `salas:criar` accepts `{ name, visibility }`; `salas:entrar` accepts `{ roomId, accessCode }`; `salas:sair`, `salas:ao-vivo`, `salas:encerrar`; and `sala:sinal:oferta|resposta|candidato` accept `{ roomId, para, descricao|resposta|candidato }`.
- Room state broadcasts use `salas:atualizadas`; room peer events use `sala:espectador-entrou`, `sala:espectador-saiu`, and `sala:encerrada`.
- A tokenless handshake is accepted only with `auth.modo === 'espectador'`; it gets room handlers only and bypasses all legacy account/chat/voice listeners. Authenticated sockets retain existing APIs.

- [ ] **Step 1: Write failing tests** for visitor room-only access, room event acknowledgements, code checks, role-checked signaling, and rejection of offers to sockets outside the room.
- [ ] **Step 2: Run** `npm test -- --test-name-pattern='room socket|visitor|signaling'` from `server`; verify the intended failures.
- [ ] **Step 3: Implement** the Socket.IO adapter and visitor-only connection branch; constrain legacy offer/answer/ICE relays to the same active voice channel so unrelated sockets cannot be signaled.
- [ ] **Step 4: Run** `npm test` from `server`; all existing and new tests must pass.

### Task 3: Stream-quality and capture settings

**Files:**
- Create: `client/src/streamQuality.mjs`
- Test: `client/tests/streamQuality.test.mjs`
- Modify: `client/src/components/ScreenShareSourcePicker.jsx`

**Interfaces:**
- Produces `DEFAULT_STREAM_QUALITY`, `STREAM_QUALITY_OPTIONS`, and `getCaptureConstraints(settings)` from `client/src/streamQuality.mjs`.
- `settings` has `contentType: 'detail' | 'motion'`, `resolution: '576p' | '720p' | '1080p'`, `fps: 15 | 24 | 30 | 60`, `bitrate: 700 | 2000 | 4000 | 8000`, `adaptiveQuality: boolean`, `shareAudio: boolean`, and `ignoreDiscordAudio: boolean`.
- The source picker keeps Electron screen/window selection, adds accessible quality controls, and invokes its existing selection callback with both source metadata and the validated settings.

- [ ] **Step 1: Write failing tests** for default settings, each supported resolution/FPS preset, quality constraints, audio disabled when requested, and unsupported-value fallback.
- [ ] **Step 2: Run** `npm test -- --test-name-pattern='stream quality'` from `client`; verify failures are due to missing exports/behavior.
- [ ] **Step 3: Implement** the settings model and update the screen/window picker; keep unsupported advanced presets out of the UI.
- [ ] **Step 4: Run** `npm test` and `npm run build` from `client`.

### Task 4: Rooms home and create-room flow

**Files:**
- Create: `client/src/components/RoomsHome.jsx`
- Create: `client/src/components/CreateStreamRoomModal.jsx`
- Test: `client/tests/RoomsHome.test.mjs`
- Modify: `client/src/App.jsx`

**Interfaces:**
- `RoomsHome({ rooms, connectionStatus, user, onCreateRoom, onJoinRoom, onOpenProfile, onOpenSettings, onSignOut })` renders discovery and actions without chat/voice controls.
- `CreateStreamRoomModal({ onCreate, onClose })` returns `{ name, visibility }` with required name and explicit public/private choice.
- Authenticated room operations use the Socket.IO acknowledgements defined in Task 2. Browser hash links use `#/sala/<roomId>?codigo=<accessCode>`.

- [ ] **Step 1: Write failing tests** asserting public rooms render, room actions are accessible, empty discovery state has a create action, and no voice/chat actions are present.
- [ ] **Step 2: Run** `npm test -- --test-name-pattern='rooms home'` from `client`; verify the expected failures.
- [ ] **Step 3: Implement** the responsive room directory/create modal and replace the Discord-like authenticated app shell while preserving login, profile, update notification, and sign-out.
- [ ] **Step 4: Run** the focused client test and full client suite.

### Task 5: Host room stage and mobile spectator

**Files:**
- Create: `client/src/components/StreamRoom.jsx`
- Test: `client/tests/StreamRoom.test.mjs`
- Modify: `client/src/App.jsx`
- Modify: `client/src/styles.css`
- Modify: `client/index.html`

**Interfaces:**
- `StreamRoom({ roomId, accessCode, session, socket, onLeave })` joins using the room protocol; when `session` is absent it owns a guest Socket.IO connection configured with `auth.modo: 'espectador'`.
- The host starts Electron `getDisplayMedia` only after a user gesture, adds video and optional screen-audio tracks, offers only to room viewers, and can stop/end/copy the invitation. It never requests microphone audio.
- The viewer accepts host offers only, queues ICE candidates until the remote description exists, renders `<video autoPlay playsInline controls>`, and exposes an explicit play action for autoplay-blocked mobile browsers.
- Hash navigation returns to the directory on leave and supports a direct private link without changing the Vite relative asset base.

- [ ] **Step 1: Write failing tests** for route parsing, public/private join payloads, viewer rendering without microphone permission, and host-only capture affordances.
- [ ] **Step 2: Run** the focused client test; verify failures identify missing route/component behavior.
- [ ] **Step 3: Implement** the room stage, peer lifecycle, host controls, guest viewer route, and semantic states for waiting/live/ended/error.
- [ ] **Step 4: Run** focused client tests, `npm test` from `client` and `server`, and `npm run build` from `client`.
- [ ] **Step 5: Inspect** desktop and narrow mobile viewports in a browser; verify the page loads at the hash deep link, has no horizontal overflow, and the viewer never prompts for a mic.

### Task 6: Integration review

**Files:**
- Review only: all files changed by Tasks 1–5.

- [ ] Confirm every Global Constraint and Review Focus case against the tests and final diff.
- [ ] Run the server and client suites/build after integration; report any existing warning separately from failures.
- [ ] Verify no file from the pre-existing dirty state was staged, committed, overwritten, or reverted.
