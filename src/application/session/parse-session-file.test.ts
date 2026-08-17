import { describe, expect, it } from 'vitest';
import {
  encodeCwdForTranscript,
  normalizeSessionId,
  parseSessionFile,
} from './parse-session-file.js';

const measuredJson = {
  pid: 75108,
  sessionId: 'f4c1e1c6-073a-4211-8xxx',
  cwd: '/Users/testuser/Documents/src/private_src/example-project',
  startedAt: 1786702129554,
  procStart: 'Fri Aug 14 10:08:48 2026',
  version: '2.1.229',
  peerProtocol: 1,
  kind: 'interactive',
  entrypoint: 'claude-desktop',
  messagingSocketPath: '/tmp/cc-socks/75108xxx',
  name: 'example-project-97',
  nameSource: 'derived',
};

describe('parseSessionFile', () => {
  it('parses measured JSON shape', () => {
    const parsed = parseSessionFile(measuredJson);

    expect(parsed).not.toBeNull();
    expect(parsed?.sessionId).toBe('f4c1e1c6-073a-4211-8xxx');
    expect(parsed?.pid).toBe(75108);
    expect(parsed?.cwd).toBe('/Users/testuser/Documents/src/private_src/example-project');
    expect(parsed?.kind).toBe('interactive');
    expect(parsed?.entrypoint).toBe('claude-desktop');
    expect(parsed?.name).toBe('example-project-97');
    expect(parsed?.startedAt.getTime()).toBe(1786702129554);
  });

  it('returns null when pid is missing', () => {
    const { pid: _pid, ...rest } = measuredJson;
    expect(parseSessionFile(rest)).toBeNull();
  });

  it('returns null when sessionId is missing', () => {
    const { sessionId: _sessionId, ...rest } = measuredJson;
    expect(parseSessionFile(rest)).toBeNull();
  });

  it('returns null when cwd is missing', () => {
    const { cwd: _cwd, ...rest } = measuredJson;
    expect(parseSessionFile(rest)).toBeNull();
  });

  it('parses startedAt as epoch milliseconds', () => {
    const parsed = parseSessionFile({ ...measuredJson, startedAt: 1_700_000_000_000 });
    expect(parsed?.startedAt.getTime()).toBe(1_700_000_000_000);
  });

  it('parses startedAt as ISO string', () => {
    const parsed = parseSessionFile({
      ...measuredJson,
      startedAt: '2026-08-14T01:08:49.554Z',
    });
    expect(parsed?.startedAt.toISOString()).toBe('2026-08-14T01:08:49.554Z');
  });

  it('defaults startedAt to epoch 0 when missing', () => {
    const { startedAt: _startedAt, ...rest } = measuredJson;
    const parsed = parseSessionFile(rest);
    expect(parsed).not.toBeNull();
    expect(parsed?.startedAt.getTime()).toBe(0);
  });

  it('returns null for null, array, or string raw input', () => {
    expect(parseSessionFile(null)).toBeNull();
    expect(parseSessionFile([])).toBeNull();
    expect(parseSessionFile('not-json')).toBeNull();
  });

  it('returns null when pid is a string', () => {
    expect(parseSessionFile({ ...measuredJson, pid: '75108' })).toBeNull();
  });
});

describe('encodeCwdForTranscript', () => {
  it('encodes a normal project path', () => {
    expect(
      encodeCwdForTranscript('/Users/testuser/Documents/src/private_src/example-project'),
    ).toBe('-Users-testuser-Documents-src-private-src-example-project');
  });

  it('encodes worktree paths with dots and underscores', () => {
    expect(encodeCwdForTranscript('/a/b/.claude/worktrees/c_d')).toBe(
      '-a-b--claude-worktrees-c-d',
    );
  });
});

describe('normalizeSessionId', () => {
  it('strips local_ prefix', () => {
    expect(normalizeSessionId('local_abc-123')).toBe('abc-123');
  });

  it('returns id unchanged when no local_ prefix', () => {
    expect(normalizeSessionId('abc-123')).toBe('abc-123');
  });
});
