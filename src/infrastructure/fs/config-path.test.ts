import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveConfigFilePath } from './config-path.js';

describe('resolveConfigFilePath', () => {
  it.each(['darwin', 'linux'] as const)('%s uses ~/.config', (platform) => {
    const home = path.join(os.tmpdir(), 'bdboard-home');
    expect(resolveConfigFilePath({ platform, homedir: home })).toBe(
      path.join(home, '.config', 'bdboard', 'config.json'),
    );
  });

  it('uses APPDATA on Windows when provided', () => {
    const appData = path.join(os.tmpdir(), 'bdboard-appdata');
    expect(resolveConfigFilePath({ platform: 'win32', homedir: 'C:\\Users\\test', appData })).toBe(
      path.join(appData, 'bdboard', 'config.json'),
    );
  });

  it('falls back to the Windows roaming directory when APPDATA is blank', () => {
    const home = path.join(os.tmpdir(), 'bdboard-home');
    expect(resolveConfigFilePath({ platform: 'win32', homedir: home, appData: '  ' })).toBe(
      path.join(home, 'AppData', 'Roaming', 'bdboard', 'config.json'),
    );
  });
});
