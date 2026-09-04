import { describe, expect, it } from 'vitest';
import {
  ApiError,
  type ProjectHarnessContractDto,
  type ProjectHarnessPackStatusDto,
  type ProjectHarnessStatusDto,
} from '../api';
import {
  buildRunNextStepCommand,
  describeHarnessRunBlock,
  describeRunStartError,
  RUN_REQUIRED_HARNESS_PACK,
} from './agentRunShared';

describe('describeRunStartError', () => {
  it('maps worktree-dirty to a Japanese remediation message', () => {
    const message = describeRunStartError(
      new ApiError(
        409,
        '/tmp/worktrees/bdboard-abc.1: uncommitted changes prevent agent run',
        {
          errorMessage:
            '/tmp/worktrees/bdboard-abc.1: uncommitted changes prevent agent run',
          reason: 'worktree-dirty',
        },
      ),
    );

    expect(message).toMatch(/未コミットの変更があるため実行できません/);
    expect(message).toContain('/tmp/worktrees/bdboard-abc.1');
  });

  it('maps too many concurrent runs to a Japanese remediation message', () => {
    const message = describeRunStartError(
      new ApiError(429, 'too many concurrent runs', {
        errorMessage: 'too many concurrent runs',
      }),
    );

    expect(message).toBe(
      '同時に実行できる上限に達しています。実行中のものが終わってからお試しください。',
    );
  });
});

const OK_CONTRACT: ProjectHarnessContractDto = {
  state: 'ok',
  verify: 'npm run verify',
  prFlow: 'pr',
  mainBranch: 'main',
};

function harnessPack(
  overrides: Partial<ProjectHarnessPackStatusDto> = {},
): ProjectHarnessPackStatusDto {
  return {
    name: RUN_REQUIRED_HARNESS_PACK,
    availableVersion: '1.0.0',
    installedVersion: '1.0.0',
    drift: false,
    hooksState: 'ok',
    missingHooks: [],
    ...overrides,
  };
}

function harnessStatus(
  packOverrides: Partial<ProjectHarnessPackStatusDto> = {},
  contract: ProjectHarnessContractDto = OK_CONTRACT,
): ProjectHarnessStatusDto {
  return { packs: [harnessPack(packOverrides)], contract };
}

describe('describeRunStartError harness preflight reasons', () => {
  function preflightError(reason: string, detail?: string): ApiError {
    return new ApiError(409, 'preflight', {
      errorMessage: 'preflight',
      reason,
      detail,
    });
  }

  it('explains a missing harness injection', () => {
    expect(describeRunStartError(preflightError('harness-not-injected'))).toContain(
      'ハーネス (bdboard-harness) が注入されていない',
    );
  });

  it('explains unregistered hooks and carries the server detail', () => {
    const message = describeRunStartError(
      preflightError('harness-hooks-missing', 'hook が未登録です (guard.sh)'),
    );
    expect(message).toContain('hook');
    expect(message).toContain('guard.sh');
  });

  it('explains a missing verification contract', () => {
    expect(
      describeRunStartError(preflightError('harness-contract-missing')),
    ).toContain('.claude/bdboard-harness.json');
  });

  it('explains an invalid verification contract', () => {
    expect(
      describeRunStartError(preflightError('harness-contract-invalid', 'verify が空')),
    ).toContain('verify が空');
  });
});

describe('describeHarnessRunBlock', () => {
  it('does not block while the status is still unknown', () => {
    expect(describeHarnessRunBlock(undefined)).toBeNull();
  });

  it('does not block when the pack, hooks and contract are all in place', () => {
    expect(describeHarnessRunBlock(harnessStatus())).toBeNull();
  });

  it('does not block on version drift alone', () => {
    expect(
      describeHarnessRunBlock(
        harnessStatus({ installedVersion: '0.9.0', drift: true }),
      ),
    ).toBeNull();
  });

  it('reports an uninjected harness', () => {
    expect(describeHarnessRunBlock({ packs: [], contract: { state: 'not-applicable' } })).toBe(
      'ハーネス未注入 — Hygiene から注入',
    );
    expect(describeHarnessRunBlock(harnessStatus({ installedVersion: null }))).toBe(
      'ハーネス未注入 — Hygiene から注入',
    );
  });

  it('reports unregistered hooks before the contract', () => {
    expect(
      describeHarnessRunBlock(
        harnessStatus({ hooksState: 'partial', missingHooks: ['guard.sh'] }, { state: 'missing' }),
      ),
    ).toBe('hook 未登録 — 再注入');
  });

  it('reports a missing contract with the file to create', () => {
    expect(describeHarnessRunBlock(harnessStatus({}, { state: 'missing' }))).toBe(
      '検証ループ未定義 — .claude/bdboard-harness.json を作成',
    );
  });

  it('reports an invalid contract and a missing verify script', () => {
    expect(
      describeHarnessRunBlock(
        harnessStatus({}, { state: 'invalid', message: 'verify が空' }),
      ),
    ).toBe('検証コントラクト不正 — .claude/bdboard-harness.json を修正');
    expect(
      describeHarnessRunBlock(
        harnessStatus({}, { state: 'command-missing', script: 'verify', verify: 'npm run verify' }),
      ),
    ).toBe('検証コマンド未定義 — npm script verify を追加');
  });
});

describe('buildRunNextStepCommand', () => {
  it('cds into the worktree before running verify', () => {
    expect(
      buildRunNextStepCommand({
        verify: 'npm run verify',
        worktreePath: '/projects/bdboard/.claude/worktrees/bdboard-abc.1',
      }),
    ).toBe('cd /projects/bdboard/.claude/worktrees/bdboard-abc.1 && npm run verify');
  });
});
