// The Game Master's screen: header, tool rail, map, sidebar and status bar.
import React, { useRef, useEffect, useState, lazy, Suspense } from 'react';
import { GMProvider, useGM, hasUnsavedChanges, sceneHasContent } from './store';
import MapStage from './canvas/MapStage';
import AddTokenModal from './modals/AddTokenModal';
import ImageViewer from './modals/ImageViewer';
import ImagePicker from './modals/ImagePicker';
import SheetViewer from './modals/SheetViewer';
import { subscribeGM, sendGmMessage } from './broadcast';
import { withGmAudio } from './audio/audioChannel';
import { emitPing } from './pings';
import { AudioProvider } from './audio/AudioProvider';
import { ToastHost, ConfirmHost, toast } from './ui';
import { WorkspaceCtx } from './gm/workspace';
import { Header } from './gm/Header';
import { Toolbar } from './gm/Toolbar';
import { Sidebar, TabRail } from './gm/Sidebar';
import { CanvasOverlays } from './gm/CanvasOverlays';
const SessionPlanner = lazy(() => import('./gm/planner/SessionPlanner'));   // the writing tools load only when asked for
import { StatusBar } from './gm/StatusBar';
import { ContextMenu } from './gm/ContextMenu';
import { KeyboardHandler, ShortcutsDialog } from './gm/Keyboard';
import { SessionDialog } from './gm/SessionDialog';
import { JoinRequests } from './gm/JoinRequests';
import { setTable, addJoinRequest, reconcileRequests } from './gm/tableState';
import { NetDebug } from './NetDebug';
import { getGMNetStats } from './broadcast';
import { importMapFile } from './gm/sceneActions';

function Inner() {
  const canvasRef = useRef(null);
  const { state, dispatch } = useGM();
  const latest = useRef(state);
  latest.current = state;

  const [panelOpen, setPanelOpen] = useState(() => window.innerWidth > 1100);
  const [sessionOpen, setSessionOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [plannerOpen, setPlannerOpen] = useState(false);
  const openPanel = tab => { dispatch({ type: 'TAB_SET', tab }); setPanelOpen(true); };

  // Players' actions arrive here: this window owns the scene, so it applies their moves.
  useEffect(() => {
    let lastLatency = null;
    return subscribeGM(withGmAudio(sendGmMessage, {
      onRoster: players => { dispatch({ type: 'PLAYERS_SET', players }); reconcileRequests(players); },
      onTable: setTable,
      onJoinRequest: addJoinRequest,
      onAssetError: message => toast(message, { tone: 'warning', duration: 7000 }),
      onTokenMove: (id, x, y) => dispatch({ type: 'TOKEN_MOVE', id, x, y }),
      onPing: emitPing,
      // The server already checked it is that hero's turn; this window has the final say, because it owns the order.
      onEndTurn: ({ playerId, tokenId }) => {
        const current = latest.current;
        const token = current.tokens.find(t => t.id === tokenId);
        if (!token || token.ownerId !== playerId || current.combat?.activeId !== tokenId) return;
        dispatch({ type: 'COMBAT_NEXT' });
        toast(`${token.name || 'A hero'} ended their turn.`);
      },
      onStatus: status => dispatch({ type: 'NET_SET', net: status === 'open' ? { status } : { status, latency: null } }),
      onLatency: latency => {
        const rounded = Math.round(latency / 5) * 5 || 5;
        if (rounded !== lastLatency) { lastLatency = rounded; dispatch({ type: 'NET_SET', net: { latency: rounded } }); }
      },
    }));
  }, [dispatch]);

  // The welcome card and the header both import maps through here.
  useEffect(() => {
    const onImport = async event => {
      try { await importMapFile(event.detail, latest.current, dispatch); toast('Map imported.', { tone: 'success' }); }
      catch { toast('That image could not be opened. Try a PNG, JPG or WebP map.', { tone: 'danger' }); }
    };
    window.addEventListener('realm:import-map', onImport);
    return () => window.removeEventListener('realm:import-map', onImport);
  }, [dispatch]);

  // Closing the window with unsaved work is almost always a mistake.
  const dirty = hasUnsavedChanges(state) && sceneHasContent(state);
  useEffect(() => {
    if (!dirty) return undefined;
    const warn = event => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const docked = state.showSheets && state.sheetLayout === 'dock';
  const classes = ['app', docked && 'with-sheets', !panelOpen && 'panel-closed'].filter(Boolean).join(' ');

  return (
    <WorkspaceCtx.Provider value={{ panelOpen, setPanelOpen, openPanel, sessionOpen, setSessionOpen, shortcutsOpen, setShortcutsOpen, plannerOpen, setPlannerOpen }}>
      <KeyboardHandler />
      <a className="skip-link" href="#battle-map" onClick={event => { event.preventDefault(); document.getElementById('battle-map')?.focus({ preventScroll: true }); }}>Skip to the battle map</a>
      <div className={classes} style={docked ? { '--sheet-w': `${state.sheetDockWidth}px` } : undefined}>
        <Header />
        <Toolbar />
        <main className="canvas-area" id="battle-map" tabIndex={-1} ref={canvasRef} aria-label="Battle map">
          <MapStage containerRef={canvasRef} />
          <CanvasOverlays />
        </main>
        {state.showSheets && <SheetViewer />}
        {panelOpen && <Sidebar />}
        <TabRail />
        <StatusBar />
      </div>

      {state.showTokenModal && <AddTokenModal />}
      {state.showImagePicker && <ImagePicker />}
      {state.previewSrc && <ImageViewer src={state.previewSrc} alt="Handout preview" subtitle="Private preview" onClose={() => dispatch({ type: 'PREVIEW_HIDE' })} />}
      {sessionOpen && <SessionDialog onClose={() => setSessionOpen(false)} />}
      {shortcutsOpen && <ShortcutsDialog onClose={() => setShortcutsOpen(false)} />}
      {plannerOpen && <Suspense fallback={null}><SessionPlanner onClose={() => setPlannerOpen(false)} /></Suspense>}
      <ContextMenu />
      <JoinRequests />
      <NetDebug read={getGMNetStats} status={state.net.status} />
      <ToastHost />
      <ConfirmHost />
    </WorkspaceCtx.Provider>
  );
}

export default function App() {
  return (
    <GMProvider>
      <AudioProvider>
        <Inner />
      </AudioProvider>
    </GMProvider>
  );
}
