import { describe, expect, it } from 'vitest';
import {
  evaluateContractState,
  HARNESS_CONTRACT_RELATIVE_PATH,
  parseHarnessContract,
  resolveVerifyScriptRequirement,
  type ParseHarnessContractResult,
} from './harness-contract.js';

function parse(value: unknown): ParseHarnessContractResult {
  return parseHarnessContract(JSON.stringify(value));
}

describe('HARNESS_CONTRACT_RELATIVE_PATH', () => {
  it('stays under .claude/ so the injection path guard covers it', () => {
    expect(HARNESS_CONTRACT_RELATIVE_PATH).toBe('.claude/bdboard-harness.json');
  });
});

describe('parseHarnessContract', () => {
  it('parses a complete contract', () => {
    const result = parse({
      version: 1,
      verify: 'npm run verify',
      prFlow: 'pr',
      mainBranch: 'main',
      hooks: {
        denyBashPatterns: ['\\bnpm run verify:steps\\b'],
        denyBashMessages: ['use npm run verify'],
      },
    });

    expect(result).toEqual({
      ok: true,
      contract: {
        version: 1,
        verify: 'npm run verify',
        prFlow: 'pr',
        mainBranch: 'main',
        hooks: {
          denyBashPatterns: ['\\bnpm run verify:steps\\b'],
          denyBashMessages: ['use npm run verify'],
        },
      },
    });
  });

  it('reports invalid-json for text that is not JSON', () => {
    const result = parseHarnessContract('{ not json');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('invalid-json');
    expect(result.message).toContain('JSON');
  });

  it('rejects a non-object top level', () => {
    const result = parseHarnessContract('[]');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('schema');
  });

  it('rejects a version other than 1', () => {
    const result = parse({ version: 2, verify: 'npm run verify', prFlow: 'pr' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('schema');
    expect(result.message).toContain('version');
  });

  it('rejects an empty verify', () => {
    const result = parse({ version: 1, verify: '   ', prFlow: 'pr' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('verify');
  });

  it('rejects a missing verify', () => {
    const result = parse({ version: 1, prFlow: 'pr' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('verify');
  });

  it('rejects an unknown prFlow', () => {
    const result = parse({ version: 1, verify: 'npm run verify', prFlow: 'trunk' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('prFlow');
  });

  it('accepts direct and none for prFlow', () => {
    for (const prFlow of ['direct', 'none'] as const) {
      const result = parse({ version: 1, verify: 'make check', prFlow });
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.contract.prFlow).toBe(prFlow);
    }
  });

  it('defaults mainBranch to main when omitted', () => {
    const result = parse({ version: 1, verify: 'npm run verify', prFlow: 'pr' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.contract.mainBranch).toBe('main');
  });

  it('rejects an empty mainBranch', () => {
    const result = parse({
      version: 1,
      verify: 'npm run verify',
      prFlow: 'pr',
      mainBranch: '',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('mainBranch');
  });

  it('ignores unknown keys for forward compatibility', () => {
    const result = parse({
      version: 1,
      verify: 'npm run verify',
      prFlow: 'pr',
      futureKnob: { deeply: ['nested'] },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.contract.verify).toBe('npm run verify');
  });

  it('leaves hooks null when omitted', () => {
    const result = parse({ version: 1, verify: 'npm run verify', prFlow: 'pr' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.contract.hooks).toBeNull();
  });

  it('fills missing hook arrays with empty lists', () => {
    const result = parse({
      version: 1,
      verify: 'npm run verify',
      prFlow: 'pr',
      hooks: { denyBashPatterns: ['x'] },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.contract.hooks).toEqual({
      denyBashPatterns: ['x'],
      denyBashMessages: [],
    });
  });

  it('rejects hook arrays that are not string arrays', () => {
    const result = parse({
      version: 1,
      verify: 'npm run verify',
      prFlow: 'pr',
      hooks: { denyBashPatterns: [1, 2] },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('denyBashPatterns');
  });

  it('rejects a non-object hooks value', () => {
    const result = parse({
      version: 1,
      verify: 'npm run verify',
      prFlow: 'pr',
      hooks: 'yes',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('hooks');
  });
});

describe('resolveVerifyScriptRequirement', () => {
  it('resolves npm run <script> against the project root', () => {
    expect(resolveVerifyScriptRequirement('npm run verify')).toEqual({
      packageDir: '.',
      script: 'verify',
    });
  });

  it('resolves npm --prefix <dir> run <script> against that directory', () => {
    expect(resolveVerifyScriptRequirement('npm --prefix web run build:web')).toEqual({
      packageDir: 'web',
      script: 'build:web',
    });
  });

  it('resolves the --prefix=<dir> spelling', () => {
    expect(resolveVerifyScriptRequirement('npm --prefix=packages/api run test')).toEqual({
      packageDir: 'packages/api',
      script: 'test',
    });
  });

  it('resolves pnpm and yarn run forms', () => {
    expect(resolveVerifyScriptRequirement('pnpm run check')).toEqual({
      packageDir: '.',
      script: 'check',
    });
    expect(resolveVerifyScriptRequirement('yarn run ci')).toEqual({
      packageDir: '.',
      script: 'ci',
    });
  });

  it('ignores trailing arguments after the script name', () => {
    expect(resolveVerifyScriptRequirement('npm run verify -- --silent')).toEqual({
      packageDir: '.',
      script: 'verify',
    });
  });

  it('does not inspect non-npm commands', () => {
    expect(resolveVerifyScriptRequirement('make verify')).toBeNull();
    expect(resolveVerifyScriptRequirement('python -c "from x import run_all; run_all()"')).toBeNull();
    expect(resolveVerifyScriptRequirement('./scripts/verify.sh')).toBeNull();
  });

  it('does not inspect composed shell commands', () => {
    expect(resolveVerifyScriptRequirement('npm run build && npm run test')).toBeNull();
  });

  it('does not inspect npm invocations that are not run', () => {
    expect(resolveVerifyScriptRequirement('npm test')).toBeNull();
    expect(resolveVerifyScriptRequirement('npm ci')).toBeNull();
  });

  it('refuses a prefix that escapes the project root', () => {
    expect(resolveVerifyScriptRequirement('npm --prefix ../other run verify')).toBeNull();
    expect(resolveVerifyScriptRequirement('npm --prefix /etc run verify')).toBeNull();
  });
});

describe('evaluateContractState', () => {
  const okParsed = parse({ version: 1, verify: 'npm run verify', prFlow: 'pr' });

  it('reports missing when the file does not exist', () => {
    expect(evaluateContractState(null, { verifyPackageScripts: null })).toEqual({
      state: 'missing',
    });
  });

  it('reports invalid with the parse message', () => {
    const state = evaluateContractState(parseHarnessContract('nope'), {
      verifyPackageScripts: null,
    });

    expect(state.state).toBe('invalid');
    if (state.state !== 'invalid') return;
    expect(state.message).toContain('JSON');
  });

  it('reports ok when the npm script exists', () => {
    expect(
      evaluateContractState(okParsed, { verifyPackageScripts: ['build', 'verify'] }),
    ).toEqual({
      state: 'ok',
      verify: 'npm run verify',
      prFlow: 'pr',
      mainBranch: 'main',
    });
  });

  it('reports command-missing when the npm script is absent', () => {
    expect(
      evaluateContractState(okParsed, { verifyPackageScripts: ['build'] }),
    ).toEqual({
      state: 'command-missing',
      script: 'verify',
      verify: 'npm run verify',
    });
  });

  it('reports command-missing for a package.json with no scripts at all', () => {
    expect(evaluateContractState(okParsed, { verifyPackageScripts: [] }).state).toBe(
      'command-missing',
    );
  });

  it('does not inspect the command for non-npm verify commands', () => {
    const parsed = parse({ version: 1, verify: 'make verify', prFlow: 'direct' });

    expect(evaluateContractState(parsed, { verifyPackageScripts: [] })).toEqual({
      state: 'ok',
      verify: 'make verify',
      prFlow: 'direct',
      mainBranch: 'main',
    });
  });

  it('stays ok when the package.json could not be read', () => {
    expect(evaluateContractState(okParsed, { verifyPackageScripts: null }).state).toBe(
      'ok',
    );
  });

  it('resolves npm --prefix web run x against the scripts handed in for that directory', () => {
    const parsed = parse({
      version: 1,
      verify: 'npm --prefix web run build:web',
      prFlow: 'pr',
    });

    expect(
      evaluateContractState(parsed, { verifyPackageScripts: ['build:web'] }).state,
    ).toBe('ok');
    expect(
      evaluateContractState(parsed, { verifyPackageScripts: ['build'] }),
    ).toEqual({
      state: 'command-missing',
      script: 'build:web',
      verify: 'npm --prefix web run build:web',
    });
  });
});
