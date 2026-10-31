import { describe, expect, it } from 'vitest';
import { createCloudflaredTunnel } from '../cloudflared-tunnel.js';
import { createFakeSpawnedProcess } from '../cloudflared-tunnel.test-support.js';
import { createConnectionMonitor, type ConnectionHealth } from './connection-monitor.js';

const reg = (i: number): string =>
  `2026-10-31T00:00:00Z INF Registered tunnel connection connIndex=${i} location=nrt01\n`;
const retry = (i: number): string =>
  `2026-10-31T00:01:00Z ERR Connection terminated error="control stream encountered a failure while serving" connIndex=${i}\n` +
  `2026-10-31T00:01:00Z INF Retrying connection in up to 2s connIndex=${i}\n`;

describe('createConnectionMonitor', () => {
  it('reports degraded only when every registered connection dropped, and recovery', () => {
    const events: ConnectionHealth[] = [];
    const monitor = createConnectionMonitor((h) => events.push(h));
    monitor.feed(reg(0) + reg(1));
    monitor.feed(retry(0));
    expect(events).toEqual([]);
    monitor.feed(retry(1));
    expect(events).toHaveLength(1);
    expect(events[0]?.degraded).toBe(true);
    expect(events[0]?.lastError).toContain('connIndex=1');
    monitor.feed(reg(2));
    expect(events[1]).toEqual({ degraded: false });
  });

  it('handles lines split across chunks', () => {
    const events: ConnectionHealth[] = [];
    const monitor = createConnectionMonitor((h) => events.push(h));
    monitor.feed(reg(0).slice(0, 30));
    monitor.feed(reg(0).slice(30));
    monitor.feed('INF Retrying conn');
    monitor.feed('ection in up to 1s connIndex=0\n');
    expect(events.map((e) => e.degraded)).toEqual([true]);
  });
});

describe('cloudflared tunnel connection health', () => {
  it('notifies listeners after the URL was published', async () => {
    const proc = createFakeSpawnedProcess();
    const tunnel = createCloudflaredTunnel({
      port: 1,
      spawnFn: () => proc,
      resolveExecutable: () => '/bin/cloudflared',
      createLogSink: () => ({ write: () => {}, close: () => {} }),
    });
    const events: boolean[] = [];
    tunnel.onConnectionHealth?.((h) => events.push(h.degraded));
    const started = tunnel.start();
    proc.emitStderr('https://example-abc.trycloudflare.com\n' + reg(0));
    await started;
    proc.emitStderr(retry(0));
    expect(events).toEqual([true]);
  });
});
