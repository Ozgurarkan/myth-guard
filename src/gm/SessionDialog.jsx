// "Invite your players": the QR code (it carries a secret), the typed table code, who may join, and who is at the table.
//
// While this dialog is open it keeps fetching /__realm/info. The server treats every such request as "the GM is looking at
// the invite" and accepts the typed code for the next 10 minutes (design 3.6), so the code works only after the GM has
// actually shown it.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Modal, Button, Icon, Badge, Select, Segmented, EmptyState, Input, toast, ask } from '../ui';
import { QrCode } from './QrCode';
import { useGM } from '../store';
import { sendTableCommand } from '../broadcast';
import { useTableState, answerRequest } from './tableState';

const SHOWN_REFRESH_MS = 60_000;

const MODES = [
  { value: 'open', label: 'Open', icon: 'door-open', title: 'Anyone with the QR code or table code joins at once' },
  { value: 'ask', label: 'Ask first', icon: 'hand', title: 'You approve each new device' },
  { value: 'locked', label: 'Locked', icon: 'lock', title: 'No new devices; players already here can reconnect' },
];
const MODE_TEXT = {
  open: 'Anyone with the QR code or the table code joins at once, up to 16 devices.',
  ask: 'Each new device waits until you press Admit. Players already at the table reconnect freely.',
  locked: 'No new devices can join. Players already at the table can still reconnect. The table code changes.',
};

function Quality({ rtt, loss }) {
  if (rtt == null) return null;
  const level = rtt < 80 && !(loss > 5) ? 'Good' : rtt < 250 && !(loss > 15) ? 'Fair' : 'Poor';
  const tone = level === 'Good' ? 'success' : level === 'Fair' ? 'warning' : 'danger';
  return <Badge tone={tone}>{level} · {rtt} ms</Badge>;
}

/** admitted / pending / offline, in words (never colour alone). */
function statusOf(player) {
  if (!player.admitted) return { label: 'Pending', tone: 'warning' };
  if (!player.online) return { label: 'Offline', tone: 'neutral' };
  return { label: 'Admitted', tone: 'success' };
}

function DeviceRow({ player }) {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(player.name);
  const status = statusOf(player);
  const rename = event => {
    event.preventDefault();
    const name = draft.replace(/\s+/g, ' ').trim();
    if (name && name !== player.name) sendTableCommand('rename', { device: player.deviceId, name });
    setRenaming(false);
  };
  const kick = async () => {
    const yes = await ask({
      title: `Remove ${player.name || 'this device'}?`, danger: true, confirmLabel: 'Remove',
      message: 'The device is cut off at once and cannot return with its old key. To let the same person back in, they need the current invite (create a new one first if they must not reuse the old one).',
    });
    if (yes) sendTableCommand('kick', { device: player.deviceId });
  };
  return (
    <div className="row session__device">
      <span className={`dlg-presence${player.online ? ' is-online' : ''}`} aria-hidden="true" />
      <div className="row__main">
        {renaming ? (
          <form className="session__rename" onSubmit={rename}>
            <Input aria-label="Name" value={draft} maxLength={40} autoFocus onChange={event => setDraft(event.target.value)} />
            <Button size="sm" variant="primary" type="submit">Save</Button>
            <Button size="sm" variant="ghost" onClick={() => setRenaming(false)}>Cancel</Button>
          </form>
        ) : <>
          <span className="row__title">{player.name || 'Unnamed'}</span>
          <span className="row__meta">{player.device || 'Unknown device'}</span>
        </>}
      </div>
      {!renaming && <>
        <Badge tone={status.tone}>{status.label}</Badge>
        {player.online && player.admitted && <Quality rtt={player.rtt} loss={player.loss} />}
        {!player.admitted ? <>
          <Button size="sm" variant="primary" icon="check" onClick={() => answerRequest(player.deviceId, true)}>Admit</Button>
          <Button size="sm" variant="ghost" onClick={() => answerRequest(player.deviceId, false)}>Deny</Button>
        </> : <>
          <Button size="sm" variant="ghost" icon="pencil" aria-label={`Rename ${player.name || 'device'}`} title="Rename" onClick={() => { setDraft(player.name); setRenaming(true); }} />
          <Button size="sm" variant="ghost" icon="trash" aria-label={`Remove ${player.name || 'device'} from the table`} title="Kick" onClick={kick}>Kick</Button>
        </>}
      </>}
    </div>
  );
}

export function SessionDialog({ onClose }) {
  const { state } = useGM();
  const { table } = useTableState();
  const [info, setInfo] = useState(null);
  const [failed, setFailed] = useState(false);
  const [choice, setChoice] = useState(0);
  const [copied, setCopied] = useState(null);
  const copiedTimer = useRef(null);
  const live = useRef(true);
  useEffect(() => () => { live.current = false; clearTimeout(copiedTimer.current); }, []);

  const load = useCallback(() => {
    fetch('/__realm/info', { cache: 'no-store' }).then(r => (r.ok ? r.json() : Promise.reject(new Error('info')))).then(
      data => { if (live.current) { setInfo(data); setFailed(false); } },
      () => { if (live.current) setFailed(true); },
    );
  }, []);

  // Opening the dialog = "the invite is being shown". Keep saying so while it stays open; stop when it closes.
  useEffect(() => {
    load();
    const timer = setInterval(load, SHOWN_REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);
  // The table changed (mode, lock, rotate): the code or link may have changed with it.
  useEffect(() => { if (table) load(); }, [table, load]);

  const addresses = info?.addresses ?? [];
  const entry = addresses[Math.min(choice, Math.max(addresses.length - 1, 0))];
  const joinUrl = entry?.joinUrl;
  const mode = table?.mode ?? info?.mode ?? 'open';
  const code = info?.codeDisplay ?? null;
  const people = state.players;
  const onlineCount = people.filter(player => player.online && player.admitted).length;
  const pendingCount = people.filter(player => !player.admitted).length;
  const sorted = [...people].sort((a, b) => Number(a.admitted) - Number(b.admitted));
  const notLocal = !['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname);

  const flash = what => {
    setCopied(what);
    clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setCopied(null), 2200);
  };
  const copy = async (text, what, message) => {
    try { await navigator.clipboard.writeText(text); flash(what); toast(message, { tone: 'success' }); }
    catch { toast('Select the text and copy it by hand.', { tone: 'warning' }); }
  };

  const setMode = next => {
    if (next === mode) return;
    if (!sendTableCommand('mode', { mode: next })) toast('The table server is not reachable right now.', { tone: 'danger' });
  };
  const rotate = async () => {
    const yes = await ask({
      title: 'Create a new invite?', confirmLabel: 'New invite', danger: true,
      message: 'Old QR codes and table codes stop working. Players already at the table stay.',
    });
    if (!yes) return;
    if (sendTableCommand('rotate')) toast('New invite created. Show the new QR code to your players.', { tone: 'success' });
    else toast('The table server is not reachable right now.', { tone: 'danger' });
  };

  return (
    <Modal title="Invite your players" icon="wifi" width={680} onClose={onClose}
      footer={<Button variant="primary" onClick={onClose}>Done</Button>}>
      <div className="session">
        <section className="session__join">
          {failed && !info && <EmptyState icon="wifi-off" title="Can’t find the network">Myth Guard could not read this computer’s network address. Make sure it is connected to your Wi-Fi or router.</EmptyState>}
          {!failed && !info && <p className="session__loading"><Icon name="loader-circle" className="dlg-spin" /> Looking for your network…</p>}
          {info && !addresses.length && <EmptyState icon="wifi-off" title="No network found">Connect this computer to your Wi-Fi or router, then reopen this window.</EmptyState>}
          {joinUrl && <>
            <div className="session__qr"><QrCode value={joinUrl} label={`QR code that joins the table at ${entry.url}`} /></div>
            <div className="session__address">
              <span className="eyebrow">Scan with a phone camera, or open</span>
              <code className="session__url" aria-label="Player address">{entry.url}</code>
              <span className="eyebrow">Table code (to type instead)</span>
              <div className="session__code-row">
                <strong className="session__code" aria-label={`Table code ${(code ?? '').split('').join(' ')}`}>{code ?? '— — — —'}</strong>
                <Button variant="primary" icon={copied === 'code' ? 'check' : 'copy'} disabled={!code}
                  onClick={() => copy((code ?? '').replace('-', ''), 'code', 'Table code copied.')}>{copied === 'code' ? 'Copied' : 'Copy'}</Button>
              </div>
              <div className="session__actions">
                <Button size="sm" icon={copied === 'link' ? 'check' : 'link'} onClick={() => copy(joinUrl, 'link', 'Invite link copied. Send it only to your players.')}>{copied === 'link' ? 'Copied' : 'Copy invite link'}</Button>
                <Button size="sm" variant="ghost" icon="refresh-cw" onClick={rotate}>New invite</Button>
              </div>
              <p className="session__note">The QR code contains a secret that lets a phone in. Show it to the people at your table, not to the internet.</p>
              {addresses.length > 1 && (
                <label className="session__alt">
                  <span>Not working? Try another network:</span>
                  <Select value={choice} onChange={event => setChoice(Number(event.target.value))}
                    options={addresses.map((item, index) => ({ value: index, label: `${item.address} — ${item.name}${item.virtual ? ' (virtual)' : ''}` }))} />
                </label>
              )}
            </div>
          </>}
        </section>

        <section>
          <h3 className="session__heading"><Icon name="lock" size={16} /> Who may join</h3>
          <Segmented label="Who may join" value={mode} options={MODES} onChange={setMode} />
          <p className="session__hint session__mode-text" role="status">{MODE_TEXT[mode]}</p>
          {info && !info.persist && <p className="session__note">This table is not being saved to disk, so players must be invited again after a restart.</p>}
        </section>

        <section>
          <h3 className="session__heading"><Icon name="users" size={16} /> At the table
            {pendingCount > 0 && <Badge tone="warning">{pendingCount} waiting</Badge>}
            <Badge tone={onlineCount ? 'success' : 'neutral'}>{onlineCount} online</Badge></h3>
          {people.length === 0 && <p className="session__hint">Nobody has joined yet. Players scan the code or type the table code, enter their name, and appear here.</p>}
          <div className="rows">
            {sorted.map(player => <DeviceRow key={player.deviceId ?? player.id} player={player} />)}
          </div>
        </section>

        <details className="session__help">
          <summary>Players can’t connect?</summary>
          <ul>
            <li>Everyone must be on the <strong>same Wi-Fi</strong>. Guest networks often block devices from talking to each other.</li>
            <li>The typed <strong>table code</strong> works only while this window is open (and for 10 minutes after). The QR code always works until you create a new invite.</li>
            <li><strong>Wrong code?</strong> Codes have no O, I, L, 0 or 1. Five wrong tries from one phone pause it for a few minutes; if someone keeps guessing, the table locks itself.</li>
            <li><strong>Table locked?</strong> Press Open or Ask first above. Phones that already joined can still reconnect while it is locked.</li>
            <li>A phone in private browsing, or one that cleared its site data, counts as a new device and needs the QR code or table code again.</li>
            <li>If Windows asks, allow <strong>Node.js</strong> through the firewall on <strong>Private networks</strong>. Still stuck? Run <code>ENABLE-LAN.ps1</code> once as administrator.</li>
            <li>Keep this computer awake while you play.{notLocal && <> To share PC sound, open this screen from <code>http://localhost</code> on the GM computer.</>}</li>
          </ul>
        </details>
      </div>
    </Modal>
  );
}
