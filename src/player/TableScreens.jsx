// The screens a player sees when the table does not let them straight in (design 3.9 items 7 and 8):
// the table code, waiting for the GM, locked, full, banned, removed, replaced, out of date, wrong table.
// They reuse the join gate's card so the whole entrance looks like one place.
import React, { useState } from 'react';
import { Icon, Button, Input } from '../ui';
import { LogoSeal } from '../brand';
import { CODE_ALPHABET, CODE_LENGTH } from '../net/protocol';
import { normalizeCode } from '../net/hmac';

/** What to tell a person for each reason a join was refused (the JoinError `code`). */
const ERRORS = {
  'bad-proof': 'That code was not accepted. Check the letters, or ask the Dungeon Master to open the Invite screen (a code only works while it is open) or to make a new one.',
  'bad-code': `The code has ${CODE_LENGTH} letters and numbers, for example ABCD-EFGH.`,
  'bad-invite': 'That invite link is no longer valid. Ask the Dungeon Master for the table code or a fresh QR code.',
  locked: 'The table is locked. Ask the Dungeon Master to unlock it.',
  full: 'The table is full.',
  banned: 'Too many wrong tries from this phone. Wait a few minutes, then try again.',
  rate: 'Too many tries. Wait a moment, then try again.',
  'rogue-server': 'This is not the table you were invited to. Check the address.',
  network: 'Could not reach the table. Check that you are on the same Wi-Fi.',
};
export const joinErrorText = error => (error ? ERRORS[error.code] ?? error.message ?? 'Could not join the table.' : '');

/** Type, paste or dictate: case, spaces and dashes do not matter. The field shows ABCD-EFGH as you go. */
export const cleanTyped = text => String(text ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, CODE_LENGTH);
const show = clean => (clean.length > 4 ? `${clean.slice(0, 4)}-${clean.slice(4)}` : clean);

function CodeForm({ error, onCode, again }) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [local, setLocal] = useState(null);
  const odd = [...typed].filter(char => !CODE_ALPHABET.includes(char));
  const ready = typed.length === CODE_LENGTH && odd.length === 0;
  const message = local ?? (error ? joinErrorText(error) : '');

  const submit = async event => {
    event.preventDefault();
    const code = normalizeCode(typed);
    if (!code) { setLocal(odd.length ? `Table codes never use ${odd.join(', ')}.` : ERRORS['bad-code']); return; }
    setBusy(true);
    setLocal(null);
    try { await onCode(code); } catch (failure) { setLocal(joinErrorText(failure)); } finally { setBusy(false); }
  };

  return (
    <form className="gate__card" onSubmit={submit} aria-labelledby="gate-title">
      <span className="gate__seal"><LogoSeal size={104} /></span>
      <span className="eyebrow">{again ? 'Back to the table' : 'One more step'}</span>
      <h1 id="gate-title">Enter the table code</h1>
      <p>Ask the Dungeon Master for the 8-character code on their Invite screen, or scan their QR code.</p>
      <label className="gate__field">
        <span className="sr-only">Table code, 8 letters and numbers</span>
        <Input className="gate__code" value={show(typed)} onChange={event => { setTyped(cleanTyped(event.target.value)); setLocal(null); }}
          placeholder="ABCD-EFGH" inputMode="text" autoCapitalize="characters" autoComplete="off" autoCorrect="off" spellCheck={false}
          enterKeyHint="go" autoFocus aria-invalid={Boolean(message) || odd.length > 0} aria-describedby="gate-code-help" />
      </label>
      <p id="gate-code-help" className={`gate__help${message || odd.length ? ' is-error' : ''}`} role={message ? 'alert' : undefined}>
        {message || (odd.length ? `Table codes never use ${odd.join(', ')} (no O, I, L, 0 or 1).` : 'Letters and numbers only; capitals and the dash are optional.')}
      </p>
      <Button type="submit" variant="primary" size="lg" block iconRight="chevron-right" disabled={!ready || busy}>{busy ? 'Checking…' : 'Join the table'}</Button>
    </form>
  );
}

const MESSAGES = {
  waiting: {
    icon: 'hourglass', eyebrow: 'Almost there', title: 'Waiting for the Dungeon Master to let you in',
    text: 'You can stay on this page. The adventure appears as soon as you are admitted.', live: true,
  },
  locked: { icon: 'lock', eyebrow: 'Closed for now', title: 'The table is locked', text: 'The Dungeon Master is not letting new players in right now. This page tries again by itself every few seconds.', live: true },
  full: { icon: 'users', eyebrow: 'No empty seats', title: 'This table is full', text: 'Ask the Dungeon Master to make room, then try again.', live: true },
  banned: { icon: 'shield', eyebrow: 'Please wait', title: 'Too many wrong tries', text: 'Wait a few minutes before trying again.', live: true },
  replaced: { icon: 'monitor-smartphone', eyebrow: 'Another window', title: 'The table moved to another window', text: 'This screen was replaced by another one on the same device. Reload to take the table back.', reload: true },
  outdated: { icon: 'refresh-cw', eyebrow: 'New version', title: 'This page is out of date', text: 'Myth Guard was updated. Reload this page to continue.', reload: true },
  unauthorized: { icon: 'key-round', eyebrow: 'Not recognised', title: 'The table does not recognise this device', text: 'Reload the page and join again with the table code or the QR code.', reload: true },
  'rogue-server': { icon: 'shield', eyebrow: 'Wrong table', title: 'This is not the table you were invited to', text: 'Check the address with the Dungeon Master and make sure you are on their Wi-Fi.', reload: true },
};

/**
 * @param {string} kind    code | removed | auth | one of MESSAGES
 * @param {object} [error] the last JoinError, shown on the code form
 * @param {(code: string) => Promise} onCode  joinWithCode
 * @param {() => void} onRetry                retryPlayerConnection
 */
export function TableScreen({ kind, error, onCode, onRetry }) {
  const [asking, setAsking] = useState(false);

  if (kind === 'code') return <main className="gate"><CodeForm error={error} onCode={onCode} /></main>;
  if ((kind === 'removed' || kind === 'denied' || kind === 'auth') && asking) return <main className="gate"><CodeForm error={error} onCode={onCode} again /></main>;
  if (kind === 'removed' || kind === 'denied' || kind === 'auth') {
    const removed = kind !== 'auth';
    const denied = kind === 'denied';
    return (
      <main className="gate">
        <section className="gate__card" role="status" aria-labelledby="gate-title">
          <span className="gate__icon"><Icon name={removed ? 'door-open' : 'key-round'} size={44} /></span>
          <span className="eyebrow">{denied ? 'Not this time' : removed ? 'Out of the party' : 'Not recognised'}</span>
          <h1 id="gate-title">{denied ? 'The Dungeon Master did not let you in' : removed ? 'The Dungeon Master removed this device' : 'The table does not know this device'}</h1>
          <p>{removed ? 'You can ask to join again with a table code from the Dungeon Master.' : 'Join again with the table code or the QR code.'}</p>
          <Button variant="primary" size="lg" block iconRight="chevron-right" onClick={() => setAsking(true)}>Ask to join again</Button>
        </section>
      </main>
    );
  }
  const screen = MESSAGES[kind];
  if (!screen) return null;
  return (
    <main className="gate">
      <section className="gate__card" role="status" aria-labelledby="gate-title">
        <span className={`gate__icon${screen.live ? ' is-pulsing' : ''}`}><Icon name={screen.icon} size={44} /></span>
        <span className="eyebrow">{screen.eyebrow}</span>
        <h1 id="gate-title">{screen.title}</h1>
        <p>{screen.text}</p>
        {screen.reload
          ? <Button variant="primary" size="lg" block icon="refresh-cw" onClick={() => window.location.reload()}>Reload</Button>
          : <Button variant="secondary" size="lg" block icon="refresh-cw" onClick={onRetry}>{kind === 'waiting' ? 'Check again' : 'Try again'}</Button>}
      </section>
    </main>
  );
}

/** Which of the screens above the player should see, or null for the normal page. */
export function screenFor({ status, waiting, removed }) {
  if (removed) return removed.reason === 'auth' ? 'auth' : removed.reason === 'denied' ? 'denied' : 'removed';
  if (status === 'needs-invite') return 'code';
  if (status === 'kicked') return 'removed';
  if (status === 'waiting' || waiting) return 'waiting';
  if (['locked', 'full', 'banned', 'replaced', 'outdated', 'unauthorized', 'rogue-server'].includes(status)) return status;
  return null;
}
