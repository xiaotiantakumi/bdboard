import { act, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { describe, expect, it } from 'vitest';
import { useChatSendState } from './useChatSendState';

function Probe() {
  const send = useChatSendState();
  const seen = useRef<Record<string, unknown>>({});
  const stableKeys = [
    'setIsSending',
    'setStreamingReply',
    'setTurnRecoveryGeneration',
    'clearStreamingReplyForKey',
    'markUnresolvedSend',
    'clearUnresolvedSend',
    'detachedStreamSendRef',
    'requestAbortControllerRef',
  ] as const;
  const allMismatchesRef = useRef<string[]>([]);
  for (const key of stableKeys) {
    if (key in seen.current && seen.current[key] !== send[key]) allMismatchesRef.current.push(key);
    seen.current[key] = send[key];
  }
  return (
    <div>
      <p data-testid="state">{JSON.stringify(send)}</p>
      <p data-testid="mismatches">{allMismatchesRef.current.join(',')}</p>
      <button onClick={() => send.setIsSending(true)}>sending</button>
      <button onClick={() => send.setStreamingReply((prev) => ({ ...prev, key: 'partial' }))}>stream</button>
      <button onClick={() => send.setTurnRecoveryGeneration((generation) => generation + 1)}>generation</button>
      <button onClick={() => send.markUnresolvedSend(undefined)}>undefined</button>
      <button onClick={() => send.markUnresolvedSend('session')}>mark</button>
      <button onClick={() => send.clearUnresolvedSend('session')}>clear</button>
      <button onClick={() => send.clearStreamingReplyForKey('key')}>clear-stream</button>
    </div>
  );
}

describe('useChatSendState (bdboard-sso1.83 第13a段)', () => {
  it('keeps setters and refs stable across rerenders', () => {
    render(<Probe />);
    for (const label of ['sending', 'stream', 'generation', 'mark', 'clear']) {
      act(() => screen.getByText(label).click());
    }
    expect(screen.getByTestId('mismatches')).toHaveTextContent('');
  });

  it('does nothing when markUnresolvedSend receives undefined', () => {
    render(<Probe />);
    const before = screen.getByTestId('state').textContent;
    act(() => screen.getByText('undefined').click());
    expect(screen.getByTestId('state').textContent).toBe(before);
  });

  it('reflects updates to send state', () => {
    render(<Probe />);
    act(() => screen.getByText('sending').click());
    act(() => screen.getByText('stream').click());
    act(() => screen.getByText('generation').click());
    act(() => screen.getByText('mark').click());
    expect(screen.getByTestId('state')).toHaveTextContent('"isSending":true');
    expect(screen.getByTestId('state')).toHaveTextContent('"key":"partial"');
    expect(screen.getByTestId('state')).toHaveTextContent('"turnRecoveryGeneration":1');
    expect(screen.getByTestId('state')).toHaveTextContent('"session":true');
  });
});
