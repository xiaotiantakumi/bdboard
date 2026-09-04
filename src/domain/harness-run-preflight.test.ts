import { describe, expect, it } from 'vitest';
import type { ContractState } from './harness-contract.js';
import type {
  ProjectHarnessPackStatus,
  ProjectHarnessStatus,
} from './harness-pack.js';
import {
  evaluateRunPreflight,
  HARNESS_DRIFT_WARNING,
  RUN_REQUIRED_PACK_NAME,
} from './harness-run-preflight.js';

const OK_CONTRACT: ContractState = {
  state: 'ok',
  verify: 'npm run verify',
  prFlow: 'pr',
  mainBranch: 'main',
};

function pack(
  overrides: Partial<ProjectHarnessPackStatus> = {},
): ProjectHarnessPackStatus {
  return {
    name: RUN_REQUIRED_PACK_NAME,
    availableVersion: '1.2.0',
    installedVersion: '1.2.0',
    drift: false,
    hooksState: 'ok',
    missingHooks: [],
    ...overrides,
  };
}

function status(
  packOverrides: Partial<ProjectHarnessPackStatus> = {},
  contract: ContractState = OK_CONTRACT,
): ProjectHarnessStatus {
  return { packs: [pack(packOverrides)], contract };
}

describe('evaluateRunPreflight', () => {
  it('accepts an injected pack with hooks registered and a valid contract', () => {
    expect(evaluateRunPreflight(status())).toEqual({
      ok: true,
      warnings: [],
      verify: 'npm run verify',
      prFlow: 'pr',
      mainBranch: 'main',
    });
  });

  it('rejects a project without the pack at all', () => {
    const outcome = evaluateRunPreflight({ packs: [], contract: { state: 'not-applicable' } });
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toBe('harness-not-injected');
  });

  it('rejects a pack that is available but not installed', () => {
    const outcome = evaluateRunPreflight(
      status({ installedVersion: null }, { state: 'not-applicable' }),
    );
    expect(outcome.ok === false && outcome.reason).toBe('harness-not-injected');
  });

  it('reports missing hooks before looking at the contract', () => {
    const outcome = evaluateRunPreflight(
      status(
        { hooksState: 'partial', missingHooks: ['bd-pre-bash-guard.sh'] },
        { state: 'missing' },
      ),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('harness-hooks-missing');
    expect(outcome.missingHooks).toEqual(['bd-pre-bash-guard.sh']);
    expect(outcome.detail).toContain('bd-pre-bash-guard.sh');
  });

  it('treats hooksState none-declared as satisfied', () => {
    expect(evaluateRunPreflight(status({ hooksState: 'none-declared' })).ok).toBe(true);
  });

  it('rejects a missing contract', () => {
    const outcome = evaluateRunPreflight(status({}, { state: 'missing' }));
    expect(outcome.ok === false && outcome.reason).toBe('harness-contract-missing');
  });

  it('rejects an invalid contract and carries its message', () => {
    const outcome = evaluateRunPreflight(
      status({}, { state: 'invalid', message: 'verify は空でない文字列である必要があります' }),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('harness-contract-invalid');
    expect(outcome.detail).toContain('verify は空でない文字列である必要があります');
  });

  it('folds command-missing into harness-contract-invalid with the script name', () => {
    const outcome = evaluateRunPreflight(
      status({}, { state: 'command-missing', script: 'verify', verify: 'npm run verify' }),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('harness-contract-invalid');
    expect(outcome.detail).toContain('npm script verify');
  });

  it('warns but does not block on version drift', () => {
    const outcome = evaluateRunPreflight(
      status({ installedVersion: '1.0.0', availableVersion: '1.2.0', drift: true }),
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.ok === true && outcome.warnings).toEqual([HARNESS_DRIFT_WARNING]);
  });

  it('ignores packs other than the required one', () => {
    const outcome = evaluateRunPreflight({
      packs: [pack({ name: 'other-pack', installedVersion: null })],
      contract: OK_CONTRACT,
    });
    expect(outcome.ok === false && outcome.reason).toBe('harness-not-injected');
  });
});
