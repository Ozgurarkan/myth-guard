// "Thorin wants to join": a card per waiting device, with Admit and Deny. Lives on the GM page itself, so it works with the
// invite dialog closed. Several requests stack; the header pill carries the count.
import React from 'react';
import { Icon, Button } from '../ui';
import { useTableState, answerRequest, describeRequest } from './tableState';

export function JoinRequests() {
  const { requests } = useTableState();
  return (
    <div className="join-requests" role="region" aria-label="Players asking to join" aria-live="polite">
      {requests.map(request => (
        <div className="join-request" key={request.device} role="group" aria-label={`${describeRequest(request)} wants to join`}>
          <Icon name="bell-ring" size={20} />
          <div className="join-request__text">
            <strong>{request.name || 'A new device'} wants to join</strong>
            <span>{[request.label, request.ip].filter(Boolean).join(' · ') || 'Unknown device'}</span>
          </div>
          <div className="join-request__actions">
            <Button size="sm" variant="primary" icon="check" onClick={() => answerRequest(request.device, true)}>Admit</Button>
            <Button size="sm" variant="ghost" onClick={() => answerRequest(request.device, false)}>Deny</Button>
          </div>
        </div>
      ))}
    </div>
  );
}
