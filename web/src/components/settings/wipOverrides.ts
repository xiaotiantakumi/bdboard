// bdboard-sso1.10 (PR-A): SettingsPanel.tsx から WIP上限のプロジェクト別上書き行を
// 変換する純粋ヘルパーと型を移動しただけのファイル。挙動は一切変えていない。
import { parseWipLimit } from './validators';

export interface ProjectWipOverrideRow {
  projectId: string;
  limit: string;
}

export function projectWipOverridesFromConfig(
  byProject: Record<string, number>,
): ProjectWipOverrideRow[] {
  return Object.entries(byProject).map(([projectId, limit]) => ({
    projectId,
    limit: String(limit),
  }));
}

export function projectWipOverridesToConfig(
  rows: readonly ProjectWipOverrideRow[],
): Record<string, number> | undefined {
  const entries: [string, number][] = [];
  for (const row of rows) {
    const limit = parseWipLimit(row.limit);
    if (row.projectId.trim() !== '' && limit !== undefined) {
      entries.push([row.projectId, limit]);
    }
  }
  return entries.length > 0 ? Object.fromEntries(entries) : {};
}
