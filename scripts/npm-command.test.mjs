// bdboard-2yp: npm-command.mjs (npm run spawn 引数) のテスト。
import { describe, expect, it } from 'vitest';

import { npmRunSpawnSpec } from './npm-command.mjs';

describe('npmRunSpawnSpec', () => {
  it('uses shell on win32', () => {
    const { command, args, options } = npmRunSpawnSpec('verify:steps', { platform: 'win32' });
    expect(command).toBe('npm');
    expect(args).toEqual(['run', 'verify:steps']);
    // キー集合ごと固定する。将来 cwd や stdio を返すようになると verify.mjs 側の
    // 後置スプレッドで既存の値を黙って上書きしてしまうため。
    expect(options).toEqual({ shell: true });
  });

  it('does not pass any spawn option on darwin', () => {
    const { command, args, options } = npmRunSpawnSpec('verify:steps', { platform: 'darwin' });
    expect(command).toBe('npm');
    expect(args).toEqual(['run', 'verify:steps']);
    // shell: undefined すら混入させない = POSIX の spawn 引数が従来と厳密に同一。
    expect('shell' in options).toBe(false);
    expect(options).toEqual({});
  });

  it('does not pass any spawn option on linux', () => {
    const { command, args, options } = npmRunSpawnSpec('verify:steps', { platform: 'linux' });
    expect(command).toBe('npm');
    expect(args).toEqual(['run', 'verify:steps']);
    expect('shell' in options).toBe(false);
    expect(options).toEqual({});
  });

  it('reflects the script name in args', () => {
    const { args } = npmRunSpawnSpec('build', { platform: 'darwin' });
    expect(args).toEqual(['run', 'build']);
  });

  it('falls back to process.platform when platform is omitted', () => {
    const { options } = npmRunSpawnSpec('verify:steps');
    const expected = process.platform === 'win32' ? { shell: true } : {};
    expect(options).toEqual(expected);
  });
});
