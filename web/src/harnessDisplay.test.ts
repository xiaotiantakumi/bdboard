import { describe, expect, it } from 'vitest';
import type { ProjectHarnessPackStatusDto } from './api';
import {
  buildHarnessDriftMessage,
  buildHarnessInjectSuccessMessage,
  formatHarnessPackStatusLabel,
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
