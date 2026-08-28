// bdboard-2yp: npm-command.mjs (npm run spawn 引数) のテスト。
import { describe, expect, it } from 'vitest';

import { npmRunSpawnSpec } from './npm-command.mjs';

describe('npmRunSpawnSpec', () => {
  it('uses npm.cmd with shell on win32', () => {
    const { command, args, options } = npmRunSpawnSpec('verify:steps', { platform: 'win32' });
    expect(command).toBe('npm.cmd');
    expect(args).toEqual(['run', 'verify:steps']);
    expect(options.shell).toBe(true);
  });

  it('uses npm without shell key on darwin', () => {
    const { command, args, options } = npmRunSpawnSpec('verify:steps', { platform: 'darwin' });
    expect(command).toBe('npm');
    expect(args).toEqual(['run', 'verify:steps']);
    expect('shell' in options).toBe(false);
  });

  it('uses npm without shell key on linux', () => {
    const { command, args, options } = npmRunSpawnSpec('verify:steps', { platform: 'linux' });
    expect(command).toBe('npm');
    expect(args).toEqual(['run', 'verify:steps']);
    expect('shell' in options).toBe(false);
  });

  it('reflects the script name in args', () => {
    const { args } = npmRunSpawnSpec('build', { platform: 'darwin' });
    expect(args).toEqual(['run', 'build']);
  });

  it('falls back to process.platform when platform is omitted', () => {
    const { command } = npmRunSpawnSpec('verify:steps');
    const expected = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    expect(command).toBe(expected);
  });
});
