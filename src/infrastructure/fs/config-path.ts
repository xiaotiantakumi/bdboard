import os from 'node:os';
import path from 'node:path';

export function resolveConfigFilePath(opts?: {
  platform?: NodeJS.Platform;
  homedir?: string;
  appData?: string;
}): string {
  const platform = opts?.platform ?? process.platform;
  const home = opts?.homedir ?? os.homedir();
  if (platform === 'win32') {
    const appData = opts?.appData ?? process.env.APPDATA;
    const base = appData?.trim() ? appData.trim() : path.join(home, 'AppData', 'Roaming');
    return path.join(base, 'bdboard', 'config.json');
  }
  return path.join(home, '.config', 'bdboard', 'config.json');
}
