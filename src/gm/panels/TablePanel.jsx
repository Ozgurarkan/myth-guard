// Who is at the table, and which hero belongs to whom.
import React from 'react';
import { Button, Select, Switch, EmptyState, Avatar, Icon, ask } from '../../ui';
import { sendTableCommand } from '../../broadcast';
import { answerRequest, useTableState } from '../tableState';
import { useGM } from '../../store';
import { useWorkspace } from '../workspace';
import { PanelSection } from './PanelParts';

/** Connection quality: signal bars plus a word and the round-trip time, so it never relies on colour alone. */
function Ping({ rtt }) {
  if (rtt == null) return null;
  const level = rtt < 80 ? 3 : rtt < 250 ? 2 : 1;
  const word = level === 3 ? 'Good' : level === 2 ? 'Fair' : 'Poor';
  return (
    <span className={`ping is-level-${level}`} title={`${word} connection, ${rtt} ms round trip`}>
      <span className="ping__bars" aria-hidden="true"><i /><i /><i /></span>
      <span className="ping__text"><span className="sr-only">{word} connection, </span>{rtt} ms</span>
    </span>
  );
}

export function TablePanel() {
  const { state, dispatch } = useGM();
  const { setSessionOpen } = useWorkspace();
  const { table } = useTableState();
  const heroes = state.tokens;
  const unowned = heroes.filter(token => !token.ownerId);
  const assign = (tokenId, ownerId) => {
    const token = state.tokens.find(t => t.id === tokenId);
    if (token) dispatch({ type: 'TOKEN_UPDATE', token: { ...token, ownerId: ownerId || null } });
  };
  // A token owned by someone who has never reconnected this session still needs a home in the list.
  const knownIds = new Set(state.players.map(player => player.id));
  const strays = [...new Set(heroes.map(token => token.ownerId).filter(id => id && !knownIds.has(id)))];
  const waiting = state.players.filter(player => player.admitted === false);
  const members = state.players.filter(player => player.admitted !== false);
  const kick = async person => {
    const yes = await ask({ title: `Remove ${person.name || 'this device'}?`, danger: true, confirmLabel: 'Remove', message: 'The device is cut off at once. To let the same person back in they need the current invite.' });
    if (yes && person.deviceId) sendTableCommand('kick', { device: person.deviceId });
  };
  const people = [...members, ...strays.map(id => ({ id, name: 'Absent player', online: false, device: 'Not connected this session' }))];
  const onlineCount = people.filter(person => person.online).length;

  return (
    <div>
      <Button variant="primary" block icon="qr-code" onClick={() => setSessionOpen(true)}>Invite players — address &amp; QR code</Button>
      <div className="panel-card panel-card--tight">
        <Switch checked={table?.codeRequired === true} onChange={() => sendTableCommand('entry', { required: table?.codeRequired !== true })}
          label="Players need the QR code or table code" hint="Off: anyone on your Wi-Fi who opens the address can join. Turn on to ask for the code, or choose to approve each device first." />
      </div>
      <div className="panel-card panel-card--tight">
        <Switch checked={state.playerCanMoveTokens} onChange={() => dispatch({ type: 'PV_TOGGLE_TOKEN_MOVE' })}
          label="Players can move their own tokens" hint="Turn off for cutscenes or when the screen is a shared display." />
      </div>

      {waiting.length > 0 && (
        <PanelSection title="Waiting to join" count={waiting.length}>
          <div className="rows">
            {waiting.map(person => (
              <div className="row" key={person.deviceId ?? person.id}>
                <div className="row__main"><strong className="row__title">{person.name || 'A new device'}</strong><span className="row__meta">{person.device || 'Unknown device'}</span></div>
                <Button size="sm" variant="primary" icon="check" onClick={() => answerRequest(person.deviceId, true)}>Admit</Button>
                <Button size="sm" variant="ghost" onClick={() => answerRequest(person.deviceId, false)}>Deny</Button>
              </div>
            ))}
          </div>
        </PanelSection>
      )}

      <PanelSection title="Players" count={people.length} action={people.length > 0 && <span className="table-online"><span className={`presence${onlineCount ? ' is-online' : ''}`} aria-hidden="true" />{onlineCount} online</span>}>
        {people.length === 0 && <EmptyState icon="users" art="door" title="No one has arrived">Share the address from the button above. Players enter a name and appear here.</EmptyState>}
        <div className="player-cards">
          {people.map(person => {
            const owned = heroes.filter(token => token.ownerId === person.id);
            const options = [{ value: '', label: 'Give a token…' }, ...heroes.filter(token => token.ownerId !== person.id)
              .map(token => ({ value: token.id, label: `${token.name || 'Unnamed token'}${token.ownerId ? ' (take from another)' : ''}` }))];
            return (
              <article key={person.id} className={`player-card${person.online ? ' is-online' : ''}`}>
                <header>
                  <span className="player-card__avatar">
                    <Avatar name={person.name} size={38} color={person.online ? 'var(--success)' : 'var(--border-strong)'} />
                    <span className={`presence${person.online ? ' is-online' : ''}`} role="img" aria-label={person.online ? 'Online' : 'Offline'} />
                  </span>
                  <div className="row__main"><strong className="row__title">{person.name}</strong>
                    <span className="row__meta">{person.online ? person.device : 'Offline — rejoins automatically'}</span></div>
                  {person.online ? <Ping rtt={person.rtt} /> : <span className="ping is-offline"><Icon name="wifi-off" size={14} /><span className="ping__text">Offline</span></span>}
                  {person.deviceId && <Button size="sm" variant="ghost" icon="trash" aria-label={`Remove ${person.name} from the table`} title="Kick this device" onClick={() => kick(person)} />}
                </header>
                <div className="player-card__tokens">
                  {owned.length === 0 && <span className="row__meta">No tokens yet</span>}
                  {owned.map(token => (
                    <button key={token.id} type="button" className="chip" title={`Take ${token.name || 'this token'} back`} onClick={() => assign(token.id, null)}>
                      <Avatar src={token.imageSrc} name={token.name} color={token.color} size={20} />{token.name || 'Unnamed'}<Icon name="x" size={12} />
                    </button>
                  ))}
                </div>
                {heroes.length > 0 && <Select aria-label={`Give a token to ${person.name}`} value="" options={options} onChange={event => event.target.value && assign(event.target.value, person.id)} />}
              </article>
            );
          })}
        </div>
      </PanelSection>

      {heroes.length > 0 && (
        <PanelSection title="Only you control" count={unowned.length}>
          {unowned.length === 0 ? <p className="panel-note">Every token has an owner.</p>
            : <div className="chips">{unowned.map(token => <span key={token.id} className="chip is-static"><Avatar src={token.imageSrc} name={token.name} color={token.color} size={20} />{token.name || 'Unnamed'}</span>)}</div>}
          <p className="panel-note">Players can only ever move tokens that are visible, outside the fog, and assigned to them. Save the scene to keep these assignments.</p>
        </PanelSection>
      )}
    </div>
  );
}
