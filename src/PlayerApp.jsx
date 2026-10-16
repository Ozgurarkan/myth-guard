/**
 * The players' screen: what a phone, tablet or shared display shows.
 *
 * The server sends only what players may see — hidden tokens, fogged tokens,
 * private notes and exact creature health never arrive here at all.
 * Everything below is presentation: the map, the turn order, your hero,
 * handouts and sound.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { withPlayerAudio } from './audio/audioChannel';
import { subscribePlayer, sendPlayerMessage, sendPlayerTokenMove, sendPlayerPing, sendPlayerEndTurn, setPlayerName, getPlayerName, joinWithCode, retryPlayerConnection, getPlayerNetStats } from './broadcast';
import { emitPing } from './pings';
import { usePlayerAudio } from './audio/usePlayerAudio';
import { LogoMark } from './brand';
import { Icon, IconButton, Button, Modal, ToastHost, toast } from './ui';
import ImageViewer from './modals/ImageViewer';
import PlayerMap from './player/PlayerMap';
import { InitiativeBar } from './player/InitiativeBar';
import { PlayerTools } from './player/PlayerTools';
import { JoinGate } from './player/JoinGate';
import { TableScreen, screenFor } from './player/TableScreens';
import { NetDebug } from './NetDebug';

const MOVE_MESSAGES = {
  paused: 'The Dungeon Master has paused movement for now.',
  away: 'The Dungeon Master has stepped away.',
  blocked: 'That token can’t be moved right now.',
};
const TURN_MESSAGES = {
  away: 'The Dungeon Master has stepped away.',
  'not-your-turn': 'It isn’t your turn.',
};

function Waiting({ open, gmPresent, name }) {
  const message = !open ? 'Finding the table…' : gmPresent === false ? 'The Dungeon Master hasn’t opened the table yet…' : 'Unrolling the map…';
  return (
    <main className="waiting" role="status">
      <span className="waiting__die"><LogoMark size={84} /></span>
      <h1>{message}</h1>
      <p>{name ? <>Welcome, <strong>{name}</strong>. </> : null}{open ? 'You’re connected — the adventure will appear here the moment it begins.' : 'Make sure you are on the same Wi-Fi as the Dungeon Master.'}</p>
    </main>
  );
}

function ConnectionChip({ open, gmPresent, latency }) {
  let tone = 'good', label = latency ? `${latency} ms` : 'Connected';
  if (!open) { tone = 'bad'; label = 'Reconnecting…'; }
  else if (gmPresent === false) { tone = 'warn'; label = 'GM away'; }
  else if (latency > 250) tone = 'warn';
  return <span className={`p-chip is-${tone}`} title={open ? (gmPresent === false ? 'The Dungeon Master has left the table for now' : 'Connected to the table') : 'Trying to reach the table again'}><i aria-hidden="true" /><span className="p-chip__label">{label}</span></span>;
}

function AudioPill({ audio, onEnable }) {
  if (!audio.active || !audio.selected) return null;
  const blocked = !audio.enabled || audio.needsResume;
  return blocked
    ? <button type="button" className="p-pill is-action" onClick={onEnable}><Icon name="volume-x" size={16} /> Tap to hear the music</button>
    : <span className="p-pill" title="The Dungeon Master is sharing sound with you"><Icon name="volume-2" size={16} /> Sound on</span>;
}

function TurnBanner({ combat, tokens, playerId }) {
  const [shown, setShown] = useState(null);
  const lastActive = useRef(null);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    if (!playerId) return;
    const activeId = combat?.activeId ?? null;
    if (activeId === lastActive.current) return;
    lastActive.current = activeId;
    const active = tokens.find(token => token.id === activeId);
    clearTimeout(timer.current);
    if (active && active.ownerId === playerId) {
      setShown(active.name || 'adventurer');
      try { navigator.vibrate?.([140, 70, 140]); } catch { /* vibration is optional */ }
      timer.current = setTimeout(() => setShown(null), 4500);
    } else setShown(null);
  }, [combat?.activeId, tokens, playerId]);
  if (!shown) return null;
  return <div className="p-turn" role="alert"><Icon name="swords" size={22} /><div><span className="eyebrow">Your turn</span><strong>{shown}, the moment is yours!</strong></div></div>;
}

export default function PlayerApp() {
  const [name, setName] = useState(() => getPlayerName());
  const [renaming, setRenaming] = useState(false);
  const [playerId, setPlayerId] = useState(null);
  const [ps, setPs] = useState(null);
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState('connecting');
  const [gmPresent, setGmPresent] = useState(null);
  const [latency, setLatency] = useState(null);
  const [waiting, setWaiting] = useState(false);       // the GM has not admitted this device yet ('Ask first' mode)
  const [removed, setRemoved] = useState(null);        // { reason } after a kick; cleared when joining again
  const [joinError, setJoinError] = useState(null);    // the last refused join, for the code screen
  const [pending, setPending] = useState({});
  const [menuOpen, setMenuOpen] = useState(false);
  const [dismissed, setDismissed] = useState(null);
  const [zoom, setZoom] = useState(1);
  const [fullscreen, setFullscreen] = useState(false);
  const [tool, setTool] = useState(null);            // null, 'ping' or 'measure'
  const [endingTurn, setEndingTurn] = useState(false);
  const mapRef = useRef(null);
  const focused = useRef(false);
  const { state: audio, enable } = usePlayerAudio();

  // A move is shown at once; it is confirmed when the server echoes it back, or undone if refused.
  const settle = useCallback(scene => {
    setPending(current => {
      const ids = Object.keys(current);
      if (!ids.length) return current;
      const next = { ...current };
      for (const id of ids) {
        const token = scene.tokens.find(t => t.id === id);
        if (!token || (token.x === current[id].x && token.y === current[id].y)) delete next[id];
      }
      return Object.keys(next).length === ids.length ? current : next;
    });
  }, []);

  // The link starts joining the moment it exists, so it waits until the visitor has given a name: the Dungeon Master sees
  // "Thorin wants to join", not a nameless request.
  const hasName = !!name;
  useEffect(() => {
    if (!hasName) return undefined;
    return subscribePlayer(withPlayerAudio(sendPlayerMessage, {
    onState: scene => { setPs(scene); settle(scene); },
    onConnection: (isOpen, state) => {
      setOpen(isOpen); setStatus(state);
      if (state === 'connecting' || state === 'open') { setRemoved(null); setJoinError(null); }
      if (state !== 'waiting') setWaiting(false);
    },
    onWaiting: isWaiting => setWaiting(isWaiting === true),
    onKicked: info => { setRemoved({ reason: info?.reason ?? 'kicked' }); setPs(null); },
    onJoinError: setJoinError,
    onGm: setGmPresent,
    onIdentity: setPlayerId,
    onLatency: setLatency,
    onPing: emitPing,
    onTurnRejected: ({ reason }) => { setEndingTurn(false); toast(TURN_MESSAGES[reason] || TURN_MESSAGES['not-your-turn'], { tone: 'warning' }); },
    onMoveRejected: ({ id, reason }) => {
      setPending(current => { const next = { ...current }; delete next[id]; return next; });
      toast(MOVE_MESSAGES[reason] || MOVE_MESSAGES.blocked, { tone: 'warning' });
    },
    }));
  }, [settle, hasName]);

  // Give up on an unanswered move after a moment so a token can never stay stuck out of place.
  useEffect(() => {
    if (!Object.keys(pending).length) return undefined;
    const timer = setTimeout(() => setPending({}), 3000);
    return () => clearTimeout(timer);
  }, [pending]);

  // "End turn" stays greyed out until the order moves on; a lost reply must not leave it stuck.
  const activeTurn = ps?.combat?.activeId ?? null;
  useEffect(() => { setEndingTurn(false); }, [activeTurn]);
  useEffect(() => {
    if (!endingTurn) return undefined;
    const timer = setTimeout(() => setEndingTurn(false), 2500);
    return () => clearTimeout(timer);
  }, [endingTurn]);

  // Once the GM takes the handout away, forget that this player dismissed it, so revealing it again shows it again.
  const liveHandout = ps?.handoutSrc ?? null;
  useEffect(() => { if (!liveHandout) setDismissed(null); }, [liveHandout]);

  useEffect(() => {
    const update = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', update);
    return () => document.removeEventListener('fullscreenchange', update);
  }, []);

  // On a phone the whole scene is a thumbnail, so open on your own hero.
  useEffect(() => {
    if (focused.current || !ps || !playerId || window.innerWidth >= 700) return;
    const hero = ps.tokens.find(token => token.ownerId === playerId);
    if (!hero) return;
    const half = (hero.gridSize * ps.gridSize) / 2;
    if (mapRef.current?.focusOn(hero.x + half, hero.y + half, 2.4)) focused.current = true;
  }, [ps, playerId]);

  const moveToken = useCallback((id, x, y) => {
    if (!sendPlayerTokenMove(id, x, y)) { toast('You’re offline — the move didn’t reach the table.', { tone: 'danger' }); return; }
    setPending(current => ({ ...current, [id]: { x, y } }));
  }, []);

  const join = clean => { setPlayerName(clean); setName(clean); setRenaming(false); };
  const toggleFullscreen = () => {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen?.().catch(() => {});
    else document.exitFullscreen?.().catch(() => {});
  };

  const screen = screenFor({ status, waiting, removed });
  const announce = {
    code: 'Enter the table code.', waiting: 'Waiting for the Dungeon Master to let you in.', locked: 'The table is locked.', full: 'This table is full.',
    banned: 'Too many wrong tries. Please wait.', removed: 'The Dungeon Master removed this device.', denied: 'The Dungeon Master did not let you in.', auth: 'The table does not know this device.',
    replaced: 'The table moved to another window.', outdated: 'This page is out of date. Reload.', unauthorized: 'This device is not recognised. Reload.',
    'rogue-server': 'This is not the table you were invited to.',
  }[screen] ?? (open ? 'Connected to the table.' : '');
  const debug = <NetDebug read={getPlayerNetStats} status={status} extra={audio.stats ? { 'audio underruns': audio.stats.underruns, 'audio quality': audio.quality } : undefined} />;
  const live = <div className="sr-only" role="status" aria-live="polite">{name ? announce : ''}</div>;

  if (!name) return <><JoinGate onJoin={join} /><ToastHost />{debug}</>;
  if (screen) return <><TableScreen kind={screen} error={joinError} onCode={joinWithCode} onRetry={retryPlayerConnection} />{live}<ToastHost />{debug}</>;
  if (!ps) return <><Waiting open={open} gmPresent={gmPresent} name={name} />{live}<ToastHost />{debug}</>;

  const canMove = open && ps.playerCanMoveTokens !== false && gmPresent !== false;
  const mine = ps.tokens.filter(token => token.ownerId === playerId);
  const handout = ps.handoutSrc ? { src: ps.handoutSrc, name: ps.handoutName } : null;
  const handoutHidden = handout && dismissed === handout.src;
  const myTurn = !!ps.combat?.activeId && mine.some(token => token.id === ps.combat.activeId);
  const chooseTool = name => setTool(current => (current === name ? null : name));
  const ping = (x, y) => {
    if (!sendPlayerPing(x, y)) toast('You’re offline — the ping didn’t reach the table.', { tone: 'danger' });
    setTool(null);   // one tap, one ping
  };
  const endTurn = () => {
    if (!myTurn) return;
    if (!sendPlayerEndTurn(ps.combat.activeId)) { toast('You’re offline — your turn wasn’t ended.', { tone: 'danger' }); return; }
    setEndingTurn(true);
  };
  const blankTable = !ps.mapImageSrc && ps.tokens.length === 0;
  const findHero = () => {
    const hero = mine[0];
    if (!hero) return;
    const half = (hero.gridSize * ps.gridSize) / 2;
    mapRef.current?.focusOn(hero.x + half, hero.y + half);
  };

  return (
    <div className="player-page">
      <PlayerMap ref={mapRef} ps={ps} playerId={playerId} canMove={canMove} pending={pending} tool={tool} onPing={ping} onMoveToken={moveToken} onZoomChange={setZoom} />
      <div className="p-top">
        <div className="p-top__row">
          <InitiativeBar combat={ps.combat} tokens={ps.tokens} playerId={playerId} />
          <div className="p-top__right">
            <ConnectionChip open={open} gmPresent={gmPresent} latency={latency} />
            <IconButton icon={menuOpen ? 'x' : 'menu'} label="Menu" variant="secondary" onClick={() => setMenuOpen(value => !value)} aria-expanded={menuOpen} />
          </div>
        </div>
        <TurnBanner combat={ps.combat} tokens={ps.tokens} playerId={playerId} />
        {(!open || gmPresent === false) && (
          <div className={`p-banner ${open ? 'is-warn' : 'is-bad'}`} role="status">
            <Icon name={open ? 'hourglass' : 'wifi-off'} size={17} />
            {open ? 'The Dungeon Master has stepped away. The table will update when they return.' : 'Connection lost — rejoining automatically…'}
          </div>
        )}
      </div>

      {menuOpen && (
        <>
        <button type="button" className="p-scrim" aria-label="Close menu" tabIndex={-1} onClick={() => setMenuOpen(false)} />
        <div className="p-menu" role="menu">
          <div className="p-menu__who"><span className="avatar" style={{ '--size': '38px', '--ring': 'var(--accent)' }}><span>{name.slice(0, 2).toUpperCase()}</span></span>
            <div><span className="eyebrow">Playing as</span><strong>{name}</strong></div></div>
          <button type="button" role="menuitem" onClick={() => { setRenaming(true); setMenuOpen(false); }}><Icon name="pencil" size={17} /> Change name</button>
          {document.documentElement.requestFullscreen && <button type="button" role="menuitem" onClick={() => { toggleFullscreen(); setMenuOpen(false); }}><Icon name={fullscreen ? 'minimize' : 'maximize'} size={17} /> {fullscreen ? 'Leave full screen' : 'Full screen'}</button>}
          {handout && <button type="button" role="menuitem" onClick={() => { setDismissed(null); setMenuOpen(false); }}><Icon name="images" size={17} /> Show the handout</button>}
          <p className="p-menu__note">{open ? (latency ? `Connection: ${latency} ms` : 'Connected') : 'Reconnecting…'}</p>
        </div>
        </>
      )}

      <PlayerTools tool={tool} onTool={chooseTool} canEndTurn={myTurn} endingTurn={endingTurn} onEndTurn={endTurn} />

      <div className="p-bottom">
        <div className="p-bottom__left">
          <AudioPill audio={audio} onEnable={enable} />
          {handoutHidden && <Button size="sm" variant="primary" icon="images" onClick={() => setDismissed(null)}>Show the handout</Button>}
        </div>
        <div className="p-bottom__right">
          {tool === 'ping' && <span className="p-hint"><Icon name="crosshair" size={14} /> Tap the map to ping</span>}
          {tool === 'measure' && <span className="p-hint"><Icon name="ruler" size={14} /> Drag on the map to measure</span>}
          {!blankTable && canMove && mine.length === 0 && <span className="p-hint"><Icon name="info" size={14} /> Ask the GM to give you a hero</span>}
          {!blankTable && canMove && mine.length > 0 && <span className="p-hint"><Icon name="hand" size={14} /> Drag your hero to move</span>}
          {!blankTable && ps.playerCanMoveTokens === false && <span className="p-hint is-warn"><Icon name="lock" size={14} /> Movement paused</span>}
        </div>
        <div className="p-zoom" role="group" aria-label="Map controls">
          <IconButton icon="minus" label="Zoom out" variant="ghost" onClick={() => mapRef.current?.zoomBy(1 / 1.4)} disabled={zoom <= 1.001} />
          <button type="button" className="p-zoom__value" onClick={() => mapRef.current?.reset()} title="Show the whole scene">{Math.round(zoom * 100)}%</button>
          <IconButton icon="plus" label="Zoom in" variant="ghost" onClick={() => mapRef.current?.zoomBy(1.4)} />
          {mine.length > 0 && <IconButton icon="locate-fixed" label="Find my hero" variant="ghost" onClick={findHero} />}
        </div>
      </div>

      {handout && !handoutHidden && <ImageViewer player src={handout.src} alt="Handout" subtitle="From the Dungeon Master" closeLabel="Hide for now" onClose={() => setDismissed(handout.src)} />}
      {renaming && <Modal title="Change your name" icon="pencil" width={420} onClose={() => setRenaming(false)}><JoinGate initialName={name} onJoin={join} onCancel={() => setRenaming(false)} embedded /></Modal>}
      {live}
      <ToastHost />
      {debug}
    </div>
  );
}
