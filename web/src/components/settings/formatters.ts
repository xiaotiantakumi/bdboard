// bdboard-sso1.10 (PR-A): SettingsPanel.tsx から純粋な表示整形ヘルパーを
// 移動しただけのファイル。挙動は一切変えていない。

export function msToHours(ms: number): string {
  return String(ms / (60 * 60 * 1000));
}

export function msToMinutes(ms: number): string {
  return String(ms / (60 * 1000));
}

export function msToDays(ms: number): string {
  return String(ms / (24 * 60 * 60 * 1000));
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
