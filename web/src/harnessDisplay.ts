import type { ProjectHarnessPackStatusDto } from './api';

export function formatHarnessPackStatusLabel(
  pack: ProjectHarnessPackStatusDto,
): string {
  if (pack.installedVersion === null) {
    return '未導入';
  }
  if (pack.drift) {
    return `要更新 (${pack.installedVersion}→${pack.availableVersion})`;
  }
  return `v${pack.installedVersion}`;
}

export function harnessPackNeedsAction(pack: ProjectHarnessPackStatusDto): boolean {
  return pack.installedVersion === null || pack.drift;
}

export function harnessInjectButtonLabel(
  pack: ProjectHarnessPackStatusDto,
): string {
  if (pack.installedVersion === null) {
    return '注入';
  }
  if (pack.drift) {
    return '更新';
  }
  return '再注入';
}

export function buildHarnessInjectSuccessMessage(
  packName: string,
  pack: ProjectHarnessPackStatusDto,
): string {
  if (pack.installedVersion === null) {
    return `ハーネス ${packName} を注入しました`;
  }
  if (pack.drift) {
    return `ハーネス ${packName} を v${pack.availableVersion} に更新しました`;
  }
  return `ハーネス ${packName} を再注入しました`;
}

export function buildHarnessDriftMessage(pack: ProjectHarnessPackStatusDto): string {
  return `${pack.name}: v${pack.installedVersion} → v${pack.availableVersion} に更新が必要です`;
}
