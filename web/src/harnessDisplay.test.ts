import { describe, expect, it } from 'vitest';
import type {
  ProjectHarnessContractDto,
  ProjectHarnessPackStatusDto,
} from './api';
import {
  buildHarnessDriftMessage,
  buildHarnessHooksMessage,
  buildHarnessInjectSuccessMessage,
  formatHarnessContractDetail,
  formatHarnessContractLabel,
  formatHarnessHooksDetail,
  formatHarnessHooksLabel,
  formatHarnessPackStatusLabel,
  harnessContractNeedsAttention,
  harnessHooksNeedAttention,
  harnessInjectButtonLabel,
  harnessPackNeedsAction,
} from './harnessDisplay';

function makePack(
  overrides: Partial<ProjectHarnessPackStatusDto> = {},
): ProjectHarnessPackStatusDto {
  return {
    name: 'bdboard-harness',
    availableVersion: '0.2.0',
    installedVersion: null,
    drift: false,
    hooksState: 'none-declared',
    missingHooks: [],
    ...overrides,
  };
}

describe('harnessDisplay', () => {
  it('shows 未導入 when pack is not installed', () => {
    const pack = makePack();
    expect(formatHarnessPackStatusLabel(pack)).toBe('未導入');
    expect(harnessPackNeedsAction(pack)).toBe(true);
    expect(harnessInjectButtonLabel(pack)).toBe('注入');
  });

  it('shows installed version when up to date', () => {
    const pack = makePack({
      installedVersion: '0.2.0',
      drift: false,
    });
    expect(formatHarnessPackStatusLabel(pack)).toBe('v0.2.0');
    expect(harnessPackNeedsAction(pack)).toBe(false);
  });

  it('shows drift label when installed version is older than available', () => {
    const pack = makePack({
      installedVersion: '0.1.0',
      drift: true,
    });
    expect(formatHarnessPackStatusLabel(pack)).toBe('要更新 (0.1.0→0.2.0)');
    expect(harnessPackNeedsAction(pack)).toBe(true);
    expect(harnessInjectButtonLabel(pack)).toBe('更新');
    expect(buildHarnessDriftMessage(pack)).toBe(
      'bdboard-harness: v0.1.0 → v0.2.0 に更新が必要です',
    );
  });

  it('builds inject success messages for install and update', () => {
    expect(
      buildHarnessInjectSuccessMessage('bdboard-harness', makePack()),
    ).toBe('ハーネス bdboard-harness を注入しました');
    expect(
      buildHarnessInjectSuccessMessage(
        'bdboard-harness',
        makePack({ installedVersion: '0.1.0', drift: true }),
      ),
    ).toBe('ハーネス bdboard-harness を v0.2.0 に更新しました');
  });
});

describe('harness contract display', () => {
  const contracts: Record<string, ProjectHarnessContractDto> = {
    ok: {
      state: 'ok',
      verify: 'npm run verify',
      prFlow: 'pr',
      mainBranch: 'main',
    },
    missing: { state: 'missing' },
    invalid: { state: 'invalid', message: 'verify は空でない文字列である必要があります' },
    commandMissing: {
      state: 'command-missing',
      script: 'verify',
      verify: 'npm run verify',
    },
    notApplicable: { state: 'not-applicable' },
  };

  it('treats missing / invalid / command-missing as problems', () => {
    expect(harnessContractNeedsAttention(contracts.missing!)).toBe(true);
    expect(harnessContractNeedsAttention(contracts.invalid!)).toBe(true);
    expect(harnessContractNeedsAttention(contracts.commandMissing!)).toBe(true);
  });

  it('does not warn for ok or for uninjected projects', () => {
    expect(harnessContractNeedsAttention(contracts.ok!)).toBe(false);
    expect(harnessContractNeedsAttention(contracts.notApplicable!)).toBe(false);
  });

  it('renders nothing at all for uninjected projects', () => {
    expect(formatHarnessContractLabel(contracts.notApplicable!)).toBeNull();
    expect(formatHarnessContractDetail(contracts.notApplicable!)).toBeNull();
  });

  it('keeps badge labels short and puts the detail in the tooltip', () => {
    expect(formatHarnessContractLabel(contracts.missing!)).toBe('検証ループ未定義');
    expect(formatHarnessContractDetail(contracts.missing!)).toContain(
      '.claude/bdboard-harness.json',
    );

    expect(formatHarnessContractLabel(contracts.invalid!)).toBe('検証コントラクト不正');
    expect(formatHarnessContractDetail(contracts.invalid!)).toContain(
      'verify は空でない文字列である必要があります',
    );

    expect(formatHarnessContractLabel(contracts.commandMissing!)).toBe(
      '検証コマンド未定義',
    );
    expect(formatHarnessContractDetail(contracts.commandMissing!)).toContain(
      'npm script verify が無い',
    );
  });

  it('shows what actually runs when the contract is ok', () => {
    expect(formatHarnessContractLabel(contracts.ok!)).toBe('検証: npm run verify');
    expect(formatHarnessContractDetail(contracts.ok!)).toBe(
      '検証: npm run verify / PR 必須 / main: main',
    );
  });
});

describe('harnessDisplay hooks state', () => {
  const MISSING = ['bash "$CLAUDE_PROJECT_DIR/.claude/skills/bdboard-harness/hooks/a.sh"'];

  it('ignores none-declared and ok', () => {
    expect(
      harnessHooksNeedAttention(
        makePack({ installedVersion: '0.2.0', hooksState: 'none-declared' }),
      ),
    ).toBe(false);
    expect(
      harnessHooksNeedAttention(makePack({ installedVersion: '0.2.0', hooksState: 'ok' })),
    ).toBe(false);
  });

  it('warns for missing and partial on an installed pack', () => {
    for (const hooksState of ['missing', 'partial'] as const) {
      expect(
        harnessHooksNeedAttention(
          makePack({ installedVersion: '0.2.0', hooksState, missingHooks: MISSING }),
        ),
      ).toBe(true);
    }
  });

  it('stays quiet for a pack that is not installed', () => {
    expect(
      harnessHooksNeedAttention(
        makePack({ installedVersion: null, hooksState: 'missing', missingHooks: MISSING }),
      ),
    ).toBe(false);
  });

  it('offers 再注入 for an up-to-date pack whose hooks are gone', () => {
    const pack = makePack({
      installedVersion: '0.2.0',
      drift: false,
      hooksState: 'missing',
      missingHooks: MISSING,
    });
    expect(harnessPackNeedsAction(pack)).toBe(true);
    expect(harnessInjectButtonLabel(pack)).toBe('再注入');
  });

  it('labels the badge with the missing count and explains the fix', () => {
    const pack = makePack({
      installedVersion: '0.2.0',
      hooksState: 'missing',
      missingHooks: MISSING,
    });
    expect(formatHarnessHooksLabel(pack)).toBe('hook 未登録 (1)');
    expect(formatHarnessHooksDetail(pack)).toContain('再注入');
    expect(formatHarnessHooksDetail(pack)).toContain('.claude/settings.json');
    expect(buildHarnessHooksMessage(pack)).toBe(
      'bdboard-harness: hook 1 件が .claude/settings.json に未登録です (再注入で解消)',
    );
  });
});
