// Share this computer's sound (music, ambience, effects) with chosen players.
import React from 'react';
import { Button, Input, Switch, EmptyState, Badge, Icon } from '../../ui';
import { useAudio } from '../../audio/AudioProvider';
import { PanelSection } from './PanelParts';

export function SoundPanel() {
  const { audio, controller } = useAudio();
  const c = () => controller.current;
  const volume = Math.round(audio.playerVolume * 100);
  return (
    <div>
      <div className={`broadcast${audio.active ? ' is-live' : ''}`} role="status">
        <span className="broadcast__icon"><Icon name={audio.active ? 'volume-2' : 'music'} size={26} /></span>
        <div className="broadcast__text">
          <strong>{audio.busy ? 'Choose a source…' : audio.active ? 'Broadcasting to your players' : 'Not broadcasting'}</strong>
          <span>{audio.active ? (audio.connected ? `${audio.listeners} ${audio.listeners === 1 ? 'device' : 'devices'} listening` : 'Reconnecting…') : 'Only sound is shared — never your screen or microphone.'}</span>
        </div>
        {audio.active && <span className="broadcast__bars" aria-hidden="true"><i /><i /><i /><i /></span>}
      </div>
      <div className="panel-gap" />
      <Button variant={audio.active ? 'danger' : 'primary'} block size="lg" icon={audio.active ? 'pause' : 'play'}
        disabled={audio.busy || (!audio.connected && !audio.active)} onClick={() => (audio.active ? c().stop() : c().start())}>
        {audio.busy ? 'Waiting for your choice…' : audio.active ? 'Stop broadcasting' : 'Broadcast PC audio'}
      </Button>
      {audio.active && audio.capturePaused && <><div className="panel-gap" /><Button block icon="refresh-cw" onClick={() => c().resume()}>Resume audio capture</Button></>}
      {audio.error && <p role="alert" className="form-error">{audio.error}</p>}
      {!audio.active && (
        <ol className="steps">
          <li>Click <strong>Broadcast PC audio</strong> (desktop Chrome or Edge).</li>
          <li>Choose <strong>Entire Screen</strong>, or a browser tab that is playing music.</li>
          <li>Turn on <strong>Share system audio</strong> (or <strong>Share tab audio</strong>) and press Share.</li>
          <li>Tick the players who should hear it below.</li>
        </ol>
      )}

      <PanelSection title="Volume for players" card>
        <Switch checked={audio.playerMuted} onChange={value => c().setPlayerMuted(value)} label="Mute the players" hint="Silences every selected device without stopping the broadcast." disabled={!audio.connected} />
        <label className="volume">
          <span><Icon name={audio.playerMuted || volume === 0 ? 'volume-x' : 'volume-2'} size={16} />Volume</span><output>{volume}%</output>
          <input type="range" min="0" max="1" step="0.05" value={audio.playerVolume} aria-label="Player audio volume" disabled={!audio.connected} onChange={event => c().setPlayerVolume(Number(event.target.value))} />
        </label>
      </PanelSection>

      <PanelSection title="Who hears it" count={audio.devices.length} action={audio.devices.length > 0 && <>
        <Button size="sm" variant="ghost" onClick={() => c().selectAllDevices(true)}>All</Button>
        <Button size="sm" variant="ghost" onClick={() => c().selectAllDevices(false)}>None</Button>
      </>}>
        {audio.devices.length === 0 && <EmptyState icon="headphones" title="No player screens connected">Players appear here once they join the table.</EmptyState>}
        <div className="rows">
          {audio.devices.map(device => (
            <div className={`row device${device.selected ? ' is-selected' : ''}`} key={device.id} data-device-id={device.id}>
              <input className="device__check" type="checkbox" checked={device.selected} aria-label={`Send sound to ${device.name}`}
                onChange={event => c().setDevice(device.id, { selected: event.target.checked })} />
              <div className="row__main">
                <Input key={`${device.id}:${device.name}`} className="device__name audio-device-name" defaultValue={device.name} maxLength={64} aria-label={`Name for ${device.name}`}
                  title="Rename this device, for example “Projector”"
                  onBlur={event => { const name = event.target.value.trim(); if (name && name !== device.name) c().setDevice(device.id, { name }); else event.target.value = device.name; }}
                  onKeyDown={event => { event.stopPropagation(); if (event.key === 'Enter') event.currentTarget.blur(); }} />
                <span className="row__meta">{device.address}</span>
              </div>
              <Badge tone={device.ready ? 'success' : 'warning'} icon={device.ready ? 'circle-check' : 'hand'}>{device.ready ? 'Ready' : 'Needs a tap'}</Badge>
            </div>
          ))}
        </div>
        <p className="panel-note">New devices start unticked. “Needs a tap” means that player must touch their screen once so the browser allows sound.</p>
      </PanelSection>
    </div>
  );
}
