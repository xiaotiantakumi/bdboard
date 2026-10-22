import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import { createPublicAddressProbe } from './public-address-probe.js';

type Getter = NonNullable<Parameters<typeof createPublicAddressProbe>[1]>;

function getter(body: string | ((family: number | undefined) => string), statusCode = 200) {
  const calls: { url: URL; family: unknown }[] = [];
  const get: Getter = (url, options, callback) => {
    calls.push({ url, family: options.family });
    const request = new EventEmitter() as EventEmitter & ReturnType<Getter>;
    request.setTimeout = () => undefined;
    request.destroy = () => undefined;
    queueMicrotask(() => {
      const response = new EventEmitter() as IncomingMessage;
      Object.defineProperties(response, {
        statusCode: { value: statusCode },
        setEncoding: { value: () => undefined },
        resume: { value: () => undefined },
      });
      callback(response);
      if (statusCode === 200) {
        response.emit('data', typeof body === 'function' ? body(options.family) : body);
        response.emit('end');
      }
    });
    return request;
  };
  return { get, calls };
}

describe('createPublicAddressProbe', () => {
  it('parses ip= lines for IPv4 and IPv6', async () => {
    const mocked = getter((family) => `fl=abc\nip=${family === 4 ? '203.0.113.7' : '2001:db8::7'}\n`);
    const probe = createPublicAddressProbe(Date.now, mocked.get);
    await expect(probe.probe('https://example.test')).resolves.toEqual({ ipv4: '203.0.113.7', ipv6: '2001:db8::7' });
    expect(mocked.calls.map((call) => call.family).sort()).toEqual([4, 6]);
  });

  it('returns null for non-200 and request failures', async () => {
    const mocked = getter('ip=203.0.113.7\n', 503);
    const probe = createPublicAddressProbe(Date.now, mocked.get);
    await expect(probe.probe('https://example.test')).resolves.toEqual({ ipv4: null, ipv6: null });
    const failing: Getter = () => {
      const request = new EventEmitter() as EventEmitter & ReturnType<Getter>;
      request.setTimeout = () => undefined;
      request.destroy = () => undefined;
      queueMicrotask(() => request.emit('error'));
      return request;
    };
    await expect(createPublicAddressProbe(Date.now, failing).probe('https://example.test'))
      .resolves.toEqual({ ipv4: null, ipv6: null });
  });

  it('caches by URL for ten minutes and refreshes after expiry', async () => {
    let time = 0;
    const mocked = getter('ip=198.51.100.9\n');
    const probe = createPublicAddressProbe(() => time, mocked.get);
    const first = probe.probe('https://example.test');
    expect(probe.probe('https://example.test')).toBe(first);
    await first;
    expect(mocked.calls).toHaveLength(2);
    time = 10 * 60_000 - 1;
    await probe.probe('https://example.test');
    expect(mocked.calls).toHaveLength(2);
    time = 10 * 60_000;
    await probe.probe('https://example.test');
    expect(mocked.calls).toHaveLength(4);
  });
});
