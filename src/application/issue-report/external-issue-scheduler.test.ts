import { describe, expect, it, vi } from 'vitest';
import { createExternalIssueScheduler, type ExternalIssueSchedulerTimerHandle } from './external-issue-scheduler.js';

interface FakeTimer extends ExternalIssueSchedulerTimerHandle { callback: () => void; ms: number; unrefs: number; cleared: boolean }
function fakeTimers() {
  const timers: FakeTimer[] = [];
  const setTimer = vi.fn((callback: () => void, ms: number): FakeTimer => {
    const timer = { callback, ms, unrefs: 0, cleared: false, unref() { this.unrefs += 1; } };
    timers.push(timer);
    return timer;
  });
  const clearTimer = vi.fn((timer: ExternalIssueSchedulerTimerHandle) => { (timer as FakeTimer).cleared = true; });
  return { timers, setTimer, clearTimer, fire: (index: number) => timers[index]!.callback() };
}

describe('external issue scheduler', () => {
  it('schedules after completion, backs off and resets, and unrefs every timer', async () => {
    const fake = fakeTimers();
    const results = [
      { state: 'error', error: { kind: 'rate-limited' } },
      { state: 'error', error: { kind: 'rate-limited' } },
      { state: 'ok', error: null },
    ];
    const poll = vi.fn(async () => results.shift()!);
    const scheduler = createExternalIssueScheduler({ poll, baseIntervalMs: 300_000, setTimer: fake.setTimer, clearTimer: fake.clearTimer });
    scheduler.start();
    scheduler.start();
    expect(fake.timers.map((timer) => timer.ms)).toEqual([60_000]);
    fake.fire(0);
    await vi.waitFor(() => expect(fake.timers).toHaveLength(2));
    fake.fire(1);
    await vi.waitFor(() => expect(fake.timers).toHaveLength(3));
    fake.fire(2);
    await vi.waitFor(() => expect(fake.timers).toHaveLength(4));
    expect(fake.timers.map((timer) => timer.ms)).toEqual([60_000, 600_000, 1_200_000, 300_000]);
    expect(fake.timers.every((timer) => timer.unrefs === 1)).toBe(true);
  });

  it('does not overlap polls and stop prevents a follow-up timer', async () => {
    const fake = fakeTimers();
    let resolvePoll!: (value: { state: string; error: null }) => void;
    const poll = vi.fn(() => new Promise<{ state: string; error: null }>((resolve) => { resolvePoll = resolve; }));
    const scheduler = createExternalIssueScheduler({ poll, baseIntervalMs: 300_000, setTimer: fake.setTimer, clearTimer: fake.clearTimer });
    scheduler.start();
    fake.fire(0);
    expect(poll).toHaveBeenCalledTimes(1);
    expect(fake.timers).toHaveLength(1);
    scheduler.stop();
    resolvePoll({ state: 'ok', error: null });
    await vi.waitFor(() => expect(fake.timers).toHaveLength(1));
    expect(fake.clearTimer).not.toHaveBeenCalled();
  });
});
