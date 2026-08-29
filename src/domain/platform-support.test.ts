import { describe, expect, it } from 'vitest';
import {
  describePlatformSupport,
  findPlatformLimitation,
  isPlatformFeatureSupported,
  PLATFORM_FEATURES,
} from './platform-support.js';

describe('describePlatformSupport', () => {
  it.each(['darwin', 'linux', 'freebsd'])('reports no limitations on %s', (platform) => {
    const support = describePlatformSupport(platform);
    expect(support.platform).toBe(platform);
    expect(support.limitations).toEqual([]);
  });

  it('reports session discovery and chat as unavailable on win32', () => {
    const features = describePlatformSupport('win32').limitations.map((l) => l.feature);
    expect([...features].sort()).toEqual(['chat', 'session-discovery']);
  });

  it('does not report the tunnel as unavailable (bdboard-70z.10 fixed cloudflared.exe)', () => {
    // チケット bdboard-70z.9 は当初トンネルも未対応として挙げていたが、
    // 実行ファイル解決は bdboard-70z.10 で直っている。直った機能を
    // 「使えません」と表示し続けるのは、黙って動かないのと同じくらい悪い。
    const features = describePlatformSupport('win32').limitations.map((l) => l.feature);
    expect(features).not.toContain('tunnel');
  });

  it('gives every limitation a user-facing reason and a technical detail', () => {
    for (const limitation of describePlatformSupport('win32').limitations) {
      expect(limitation.reason.length).toBeGreaterThan(0);
      expect(limitation.detail.length).toBeGreaterThan(0);
      // reason はそのまま UI に出る。理由の書いていない「利用できません」は
      // 黙って落ちるのとほとんど変わらないので許さない。
      expect(limitation.reason).not.toBe(limitation.detail);
    }
  });

  it('treats an unknown platform as unrestricted', () => {
    // 動くかもしれないものを先回りで塞ぐより、壊れたときに直す方が害が小さい。
    expect(describePlatformSupport('haiku-os').limitations).toEqual([]);
  });
});

describe('isPlatformFeatureSupported / findPlatformLimitation', () => {
  it.each(PLATFORM_FEATURES)('reports %s as supported on darwin', (feature) => {
    const support = describePlatformSupport('darwin');
    expect(isPlatformFeatureSupported(support, feature)).toBe(true);
    expect(findPlatformLimitation(support, feature)).toBeNull();
  });

  it.each(PLATFORM_FEATURES)('reports %s as unsupported on win32', (feature) => {
    const support = describePlatformSupport('win32');
    expect(isPlatformFeatureSupported(support, feature)).toBe(false);
    expect(findPlatformLimitation(support, feature)?.feature).toBe(feature);
  });
});
