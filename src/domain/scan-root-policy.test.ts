import { describe, expect, it } from 'vitest';
import {
  isDangerousScanRoot,
  stripTrailingSeparators,
  validateScanRoots,
} from './scan-root-policy.js';

describe('isDangerousScanRoot', () => {
  it.each([
    '/',
    '//',
    '/../',
    '/etc',
    '/etc/',
    '//etc',
    '/etc/../etc',
    '/usr/./',
    '/var',
    '/tmp',
    '/private',
    '/System',
    '/Library',
    '/ETC', // macOS のファイルシステムは既定で大文字小文字を区別しない
    '  /etc  ', // ルートハンドラの zod trim と独立に、ここでも trim して判定する
    // MF1: APFS firmlink。/System の deep-subpath だが実質 '/' そのものなので明示拒否。
    '/System/Volumes/Data',
    '/system/volumes/data',
    '/System/Volumes/Data/',
    '/System/./Volumes/Data',
    '/System/Volumes',
    '/system/volumes/',
    '/System/./Volumes',
    '/SYSTEM/VOLUMES',
    // S1: macOS のマウント集約点(/mnt・/media と同格)
    '/Volumes',
    '/volumes/',
    '/run',
    '/mnt',
    '/media',
    '/srv',
  ])('rejects dangerous POSIX root %j', (rawPath) => {
    expect(isDangerousScanRoot(rawPath)).toBe(true);
  });

  it.each([
    'C:\\',
    'c:/',
    'C:\\Windows',
    'C:\\Windows\\',
    'c:\\windows\\..\\windows',
    'C:\\Program Files',
    'C:\\Program Files (x86)',
    'D:\\',
    // SF5: セパレータ無しのドライブ相対ルート
    'C:',
    'c:',
    // SF5: extended-length prefix 経由のすり抜け
    '\\\\?\\C:\\',
    '\\\\?\\C:',
    '\\\\?\\C:\\Windows',
    // extended-length UNC prefix は通常の UNC ルートへ変換して判定する
    '\\\\?\\UNC\\server\\share',
    '\\\\?\\unc\\server\\share\\',
    // ドライブ相対パスは CWD 参照になるため拒否
    'C:.',
    'C:foo',
    // N1: prefix を剥いだ結果がドライブ相対へ化ける形(drive-relative 分岐の ablation 保護)
    '\\\\?\\C:.',
    '\\\\?\\C:foo',
    // SF5: UNC ルート(共有直下)単体
    '\\\\server\\share',
    '\\\\server\\share\\',
    // S2: '\\?\' を剥いだ残りがドライブ文字パスでない NT 名前空間は素性不明として拒否
    '\\\\?\\Volume{a1b2c3d4-0000-0000-0000-000000000000}\\',
    '\\\\?\\GLOBALROOT\\Device\\HarddiskVolume1',
    // S2: '\\.\' デバイス名前空間も明示的に拒否
    '\\\\.\\PhysicalDrive0',
    '\\\\.\\C:',
    // N2: UNC 正規表現に掛からない 3 セグメント形でも deviceNs 分岐で拒否される
    '\\\\.\\PIPE\\srv\\x',
    // RS2: スラッシュ形 NT 名前空間も Windows 側へ振り分けて拒否
    '//?/C:/',
    '//./C:/',
  ])('rejects dangerous Windows root %j', (rawPath) => {
    expect(isDangerousScanRoot(rawPath)).toBe(true);
  });

  it.each([
    'relative/path',
    '../..',
    '../../../etc',
    './projects',
    'projects\\src',
    '~/projects', // シェル展開は無いので readdir から見れば相対パス
  ])('rejects non-absolute path %j (M1: resolved against CWD)', (rawPath) => {
    expect(isDangerousScanRoot(rawPath)).toBe(true);
  });

  it.each([
    '/Users/example/Documents',
    '/home/user/src',
    '/usr/local/foo', // システムディレクトリの深い配下は完全一致でないので許容
    '/private/tmp/projects',
    '/etcetera',
    '/varnish',
    '/System/Volumes/Data/Users/example', // firmlink そのものではなく実ユーザーパス相当
    '/Volumes/ExternalSSD/src', // マウント集約点の深い配下は許容
    'C:\\Users\\example\\Documents',
    'C:\\Windows\\Temp\\projects', // 同上: ドライブ直下の完全一致のみ拒否
    '\\\\server\\share\\projects', // UNC の共有より深い配下は許容
    '\\\\?\\C:\\Users\\example', // prefix を剥いた結果が安全なら許容
    // RS2 裁定: POSIX の先頭 '//' は実装定義ながら合法なパスなので Windows 判定に含めず、
    // POSIX 分岐の正規化('/server/share')に委ねて accept のまま
    '//server/share',
  ])('accepts ordinary path %j', (rawPath) => {
    expect(isDangerousScanRoot(rawPath)).toBe(false);
  });
});

describe('validateScanRoots', () => {
  it('returns ok for a list of safe roots', () => {
    expect(validateScanRoots(['/Users/example/Documents', '/home/user/src'])).toEqual({
      ok: true,
      rejected: [],
    });
  });

  it('collects every dangerous root as-entered (not normalized)', () => {
    const result = validateScanRoots(['/Users/example', '/etc/../etc', '//', '/ok']);
    expect(result.ok).toBe(false);
    expect(result.rejected).toEqual(['/etc/../etc', '//']);
  });

  it('returns ok for an empty list', () => {
    expect(validateScanRoots([])).toEqual({ ok: true, rejected: [] });
  });
});

describe('stripTrailingSeparators', () => {
  it.each([
    { input: '/path/to/exclude/', expected: '/path/to/exclude' },
    { input: '/path/to/exclude//', expected: '/path/to/exclude' },
    { input: 'C:\\Users\\example\\', expected: 'C:\\Users\\example' },
    { input: 'C:/Users/example/', expected: 'C:/Users/example' },
    { input: '/no-op', expected: '/no-op' },
    // ルート/ドライブルートはそれ以上潰さない
    { input: '/', expected: '/' },
    { input: 'C:\\', expected: 'C:\\' },
    { input: 'C:/', expected: 'C:/' },
    { input: 'C:\\\\', expected: 'C:\\' },
  ])('normalizes $input to $expected', ({ input, expected }) => {
    expect(stripTrailingSeparators(input)).toBe(expected);
  });
});
