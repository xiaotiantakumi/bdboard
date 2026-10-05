import { describe, expect, it } from 'vitest';
import { isLoopbackHostname, reportProjectOf } from './manualDraftAccess';

describe('manual draft access helpers', () => {
  it.each(['localhost', 'LOCALHOST', '127.0.0.1', '[::1]', '::1'])('recognizes loopback hostname %s', (hostname) => {
    expect(isLoopbackHostname(hostname)).toBe(true);
  });
  it.each(['', '192.168.1.2', 'x.trycloudflare.com', 'localhost.example.com', '127.0.0.2'])('rejects hostname %s', (hostname) => {
    expect(isLoopbackHostname(hostname)).toBe(false);
  });
  it('includes project only when exactly one valid selection is available', () => {
    const names = new Map([['p', 'Project']]);
    const paths = new Map([['p', '/workspace/project']]);
    expect(reportProjectOf(['p'], names, paths)).toEqual({ name: 'Project', path: '/workspace/project' });
    expect(reportProjectOf([], names, paths)).toBeUndefined();
    expect(reportProjectOf(['p', 'q'], names, paths)).toBeUndefined();
    expect(reportProjectOf(['p'], new Map(), paths)).toBeUndefined();
    expect(reportProjectOf(['p'], new Map([['p', ' ']]), paths)).toBeUndefined();
    expect(reportProjectOf(['p'], new Map([['p', 'x'.repeat(201)]]), paths)).toBeUndefined();
    expect(reportProjectOf(['p'], names, new Map([['p', 'x'.repeat(1001)]]))).toBeUndefined();
  });
});
