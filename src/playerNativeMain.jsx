import React, { useState } from 'react';
import ReactDOM from 'react-dom/client';
import '@fontsource-variable/cormorant/wght.css';
import '@fontsource-variable/inter/wght.css';
import './styles/tokens.css';
import './styles/components.css';
import './styles/dialogs.css';
import './styles/player.css';
import PlayerApp from './PlayerApp.jsx';
import { playerServerUrl, setPlayerServerUrl } from './net/playerServer.js';

function Connect() {
  const [value, setValue] = useState(playerServerUrl());
  const [error, setError] = useState('');
  const join = () => { try { setPlayerServerUrl(value); window.location.reload(); } catch (reason) { setError(reason.message); } };
  return <main className="waiting"><h1>Myth Guard Player</h1><p>Paste the invite link or table address from your Game Master.</p><input aria-label="Table address" value={value} onChange={event => setValue(event.target.value)} placeholder="http://192.168.1.42:5173/player.html" style={{ width: 'min(90vw, 430px)', minHeight: 48, padding: '0 12px' }} /><button className="btn btn--primary" style={{ marginTop: 12 }} onClick={join}>Open table</button>{error && <p role="alert">{error}</p>}</main>;
}

ReactDOM.createRoot(document.getElementById('root')).render(playerServerUrl() ? <PlayerApp /> : <Connect />);
