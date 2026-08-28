import { useMemo } from 'react';
import { mergeLastServerContact } from '../boardFreshness';
import { useBoardStream, type StreamState } from '../useBoardStream';

export function useLastServerContact(boardDataUpdatedAt: number | undefined): {
  streamState: StreamState;
  lastContactAtMs: number | null | undefined;
} {
  const { state: streamState, lastContactAtMs: streamContactAtMs } = useBoardStream();
  const lastContactAtMs = useMemo(
    () => mergeLastServerContact(streamContactAtMs, boardDataUpdatedAt),
    [streamContactAtMs, boardDataUpdatedAt],
  );
  return { streamState, lastContactAtMs };
}
