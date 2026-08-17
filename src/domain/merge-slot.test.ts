import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MERGE_SLOT_THRESHOLDS,
  evaluateMergeSlotStatus,
  type MergeSlotRawSignal,
} from './merge-slot.js';

const NOW = new Date('2026-08-17T11:17:14.000Z');

describe('evaluateMergeSlotStatus', () => {
  it('returns absent status when signal is null', () => {
    expect(evaluateMergeSlotStatus('proj-a', null, NOW)).toEqual({
      projectId: 'proj-a',
      present: false,
      held: false,
      holder: null,
      heldSinceIso: null,
      heldForMs: 0,
      isLongHeld: false,
    });
  });

  it('returns present but not held when status is open', () => {
    const signal: MergeSlotRawSignal = {
      status: 'open',
      holder: null,
      updatedAt: '2026-08-17T10:48:26Z',
    };

    expect(evaluateMergeSlotStatus('proj-a', signal, NOW)).toEqual({
      projectId: 'proj-a',
      present: true,
      held: false,
      holder: null,
      heldSinceIso: null,
      heldForMs: 0,
      isLongHeld: false,
    });
  });

  it('computes held duration below the long-hold threshold', () => {
    const signal: MergeSlotRawSignal = {
      status: 'in_progress',
      holder: 'session-31fdf8f9-bdboard-3tw.107',
      updatedAt: '2026-08-17T10:47:14Z',
    };

    expect(
      evaluateMergeSlotStatus('proj-a', signal, NOW, DEFAULT_MERGE_SLOT_THRESHOLDS),
    ).toEqual({
      projectId: 'proj-a',
      present: true,
      held: true,
      holder: 'session-31fdf8f9-bdboard-3tw.107',
      heldSinceIso: '2026-08-17T10:47:14Z',
      heldForMs: 30 * 60_000,
      isLongHeld: false,
    });
  });

  it('flags long-held slots when duration exceeds the threshold', () => {
    const signal: MergeSlotRawSignal = {
      status: 'in_progress',
      holder: 'session-merge',
      updatedAt: '2026-08-17T10:00:00.000Z',
    };

    expect(
      evaluateMergeSlotStatus('proj-a', signal, NOW, DEFAULT_MERGE_SLOT_THRESHOLDS),
    ).toEqual({
      projectId: 'proj-a',
      present: true,
      held: true,
      holder: 'session-merge',
      heldSinceIso: '2026-08-17T10:00:00.000Z',
      heldForMs: 77 * 60_000 + 14_000,
      isLongHeld: true,
    });
  });

  it('treats invalid updatedAt as zero held duration', () => {
    const signal: MergeSlotRawSignal = {
      status: 'in_progress',
      holder: 'session-merge',
      updatedAt: 'not-a-date',
    };

    expect(evaluateMergeSlotStatus('proj-a', signal, NOW)).toEqual({
      projectId: 'proj-a',
      present: true,
      held: true,
      holder: 'session-merge',
      heldSinceIso: 'not-a-date',
      heldForMs: 0,
      isLongHeld: false,
    });
  });
});
