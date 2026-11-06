import { describe, expect, it } from 'vitest';
import type { HarnessManifest, PackSummary } from './harness-pack.js';
import { evaluatePackRemovability, unresolvedInstalledPacks } from './harness-pack-removability.js';

function pack(name: string, requires: string[] = []): PackSummary {
  return {
    name,
    version: '1.0.0',
    description: '',
    role: requires.length === 0 ? 'base' : 'optional',
    requires,
    hooks: [],
  };
}

function manifestOf(...names: string[]): HarnessManifest {
  return {
    packs: names.map((name) => ({ name, version: '1.0.0', injectedAt: '2026-11-06T00:00:00Z', files: [] })),
  };
}

describe('evaluatePackRemovability', () => {
  const registry = [pack('base'), pack('video', ['base']), pack('extra', ['video'])];

  it('allows removing a pack nothing else requires', () => {
    expect(evaluatePackRemovability('video', registry, manifestOf('base', 'video'))).toEqual({ ok: true });
  });

  it('allows removing the base when no injected pack requires it', () => {
    expect(evaluatePackRemovability('base', registry, manifestOf('base'))).toEqual({ ok: true });
  });

  it('rejects a pack that is not in the manifest', () => {
    expect(evaluatePackRemovability('video', registry, manifestOf('base'))).toMatchObject({
      ok: false,
      code: 'not-injected',
    });
  });

  it('rejects the base while an injected optional pack requires it', () => {
    const result = evaluatePackRemovability('base', registry, manifestOf('base', 'video'));
    expect(result).toMatchObject({ ok: false, code: 'required-by-injected', dependents: ['video'] });
  });

  it('follows requires transitively (A -> B -> C: C is required by A even when B is not injected)', () => {
    const result = evaluatePackRemovability('base', registry, manifestOf('base', 'extra'));
    expect(result).toMatchObject({ ok: false, code: 'required-by-injected', dependents: ['extra'] });
  });

  it('lists every dependent, direct and indirect', () => {
    const result = evaluatePackRemovability('base', registry, manifestOf('base', 'video', 'extra'));
    expect(result).toMatchObject({ ok: false, dependents: ['extra', 'video'] });
  });

  it('terminates on a requires cycle', () => {
    const cyclic = [pack('a', ['b']), pack('b', ['a'])];
    expect(evaluatePackRemovability('a', cyclic, manifestOf('a', 'b'))).toMatchObject({
      ok: false,
      dependents: ['b'],
    });
  });

  it('does not count an injected pack the registry does not know (requires cannot be read)', () => {
    expect(evaluatePackRemovability('base', registry, manifestOf('base', 'ghost'))).toEqual({ ok: true });
    expect(unresolvedInstalledPacks(registry, manifestOf('base', 'ghost'))).toEqual(['ghost']);
  });
});
