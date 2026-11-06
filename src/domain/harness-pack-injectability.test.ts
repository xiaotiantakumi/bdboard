import { describe, expect, it } from 'vitest';
import { evaluatePackInjectability } from './harness-pack-injectability.js';
import type { HarnessManifest, PackSummary } from './harness-pack.js';

function pack(
  name: string,
  overrides: Partial<Omit<PackSummary, 'name'>> = {},
): PackSummary {
  return {
    name,
    version: '1.0.0',
    description: '',
    hooks: [],
    role: 'base',
    requires: [],
    ...overrides,
  };
}

function manifestOf(...names: string[]): HarnessManifest {
  return {
    packs: names.map((name) => ({
      name,
      version: '1.0.0',
      injectedAt: '2026-11-06T00:00:00.000Z',
      files: [],
    })),
  };
}

const BASE = pack('base-pack');
const OPTIONAL = pack('video-pack', { role: 'optional', requires: ['base-pack'] });

describe('evaluatePackInjectability', () => {
  it('accepts a base pack without requires on an empty project', () => {
    expect(evaluatePackInjectability(BASE, [BASE], manifestOf())).toEqual({ ok: true });
  });

  it('accepts an optional pack once its base is injected', () => {
    expect(
      evaluatePackInjectability(OPTIONAL, [BASE, OPTIONAL], manifestOf('base-pack')),
    ).toEqual({ ok: true });
  });

  it('allows re-injecting an already injected base pack (drift update)', () => {
    expect(evaluatePackInjectability(BASE, [BASE], manifestOf('base-pack'))).toEqual({
      ok: true,
    });
  });

  it('rejects an optional pack while its base is not injected, naming the missing pack', () => {
    const result = evaluatePackInjectability(OPTIONAL, [BASE, OPTIONAL], manifestOf());
    expect(result).toMatchObject({ ok: false, code: 'requires-not-injected' });
    expect(result.ok === false && result.reason).toContain('base-pack');
  });

  it('rejects a base pack that declares requires', () => {
    const bad = pack('bad-base', { role: 'base', requires: ['base-pack'] });
    const result = evaluatePackInjectability(bad, [BASE, bad], manifestOf('base-pack'));
    expect(result).toMatchObject({ ok: false, code: 'base-has-requires' });
  });

  it('rejects an optional pack with empty requires', () => {
    const bad = pack('bad-optional', { role: 'optional', requires: [] });
    const result = evaluatePackInjectability(bad, [BASE, bad], manifestOf('base-pack'));
    expect(result).toMatchObject({ ok: false, code: 'optional-without-requires' });
  });

  it('rejects when a required pack does not exist in the registry', () => {
    const orphan = pack('orphan', { role: 'optional', requires: ['ghost-pack'] });
    // 注入済みの記録が残っていても、レジストリに無い依存先は実在しない扱い。
    const result = evaluatePackInjectability(
      orphan,
      [BASE, orphan],
      manifestOf('base-pack', 'ghost-pack'),
    );
    expect(result).toMatchObject({ ok: false, code: 'requires-pack-missing' });
    expect(result.ok === false && result.reason).toContain('ghost-pack');
  });

  it('rejects a direct dependency cycle', () => {
    const a = pack('pack-a', { role: 'optional', requires: ['pack-b'] });
    const b = pack('pack-b', { role: 'optional', requires: ['pack-a'] });
    const result = evaluatePackInjectability(a, [a, b], manifestOf('pack-a', 'pack-b'));
    expect(result).toMatchObject({ ok: false, code: 'requires-cycle' });
    expect(result.ok === false && result.reason).toContain('pack-a');
    expect(result.ok === false && result.reason).toContain('pack-b');
  });

  it('rejects a transitive cycle that does not pass through the target itself', () => {
    const target = pack('target', { role: 'optional', requires: ['pack-a'] });
    const a = pack('pack-a', { role: 'optional', requires: ['pack-b'] });
    const b = pack('pack-b', { role: 'optional', requires: ['pack-a'] });
    const result = evaluatePackInjectability(
      target,
      [target, a, b],
      manifestOf('pack-a', 'pack-b'),
    );
    expect(result).toMatchObject({ ok: false, code: 'requires-cycle' });
  });

  it('uses the target definition even when the registry list is stale or empty', () => {
    expect(evaluatePackInjectability(BASE, [], manifestOf())).toEqual({ ok: true });
  });

  it('reports structure errors before dependency state', () => {
    const bad = pack('bad-base', { role: 'base', requires: ['ghost'] });
    const result = evaluatePackInjectability(bad, [bad], manifestOf());
    expect(result).toMatchObject({ ok: false, code: 'base-has-requires' });
  });
});
