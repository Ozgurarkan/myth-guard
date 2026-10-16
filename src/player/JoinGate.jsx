// The door to the table: a glass card that asks who is arriving.
import React, { useState } from 'react';
import { Icon, Button, Input } from '../ui';
import { LogoSeal } from '../brand';

export function JoinGate({ initialName = '', status, onJoin, onCancel, embedded = false }) {
  const [name, setName] = useState(initialName);
  const returning = !!initialName;
  const submit = event => {
    event.preventDefault();
    const clean = name.replace(/\s+/g, ' ').trim();
    if (clean) onJoin(clean);
  };
  const Wrapper = embedded ? 'div' : 'main';
  return (
    <Wrapper className={`gate${embedded ? ' gate--embedded' : ''}`}>
      <form className="gate__card" onSubmit={submit} aria-labelledby="gate-title">
        {!embedded && <span className="gate__seal"><LogoSeal size={104} /></span>}
        <span className="eyebrow">{returning ? 'A new name for the tale' : 'A seat awaits you'}</span>
        <h1 id="gate-title">{returning ? 'Who are you now?' : 'Welcome, adventurer'}</h1>
        <p>{returning ? 'Change how you appear to the Dungeon Master and the rest of the party.' : 'Tell the Dungeon Master who has arrived. Use your character’s name, or your own.'}</p>
        <label className="gate__field">
          <span className="sr-only">Your name</span>
          <Input value={name} onChange={event => setName(event.target.value)} placeholder="Your name" maxLength={40} autoFocus autoComplete="nickname" autoCapitalize="words" spellCheck={false} enterKeyHint="go" />
        </label>
        <Button type="submit" variant="primary" size="lg" block iconRight="chevron-right" disabled={!name.trim()}>{returning ? 'Save name' : 'Take your seat'}</Button>
        {onCancel && <Button variant="ghost" block onClick={onCancel}>Never mind</Button>}
        {status && <p className={`gate__status is-${status}`} role="status"><span className="gate__lamp" aria-hidden="true" />{status === 'open' ? 'The table is within reach' : 'Finding the table…'}</p>}
      </form>
    </Wrapper>
  );
}
