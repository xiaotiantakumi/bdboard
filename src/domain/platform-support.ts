/**
 * 実行プラットフォームで使えない機能を列挙する (bdboard-70z.9)。
 *
 * Windows は「全機能対応」ではなく「機能制限 + 正直な案内」で出す方針
 * (2026-08-29 のユーザー判断)。黙って動かないのが最悪の体験なので、
 * 動かないものが動かないと分かる形にするのがここの目的。
 *
 * ここは純粋な記述だけを持つ。プラットフォームの取得 (process.platform) と、
 * 制限に基づくルーティングの判断は interface/main 側の責務。
 */

/** UI とサーバーガードで共有する機能識別子。 */
export type PlatformFeature = 'session-discovery' | 'chat';

export const PLATFORM_FEATURES: readonly PlatformFeature[] = [
  'session-discovery',
  'chat',
];

export interface PlatformLimitation {
  readonly feature: PlatformFeature;
  /** UI にそのまま出す一文。 */
  readonly reason: string;
  /** 「なぜ直せないのか」の技術的な根拠。詳細表示・API 応答用。 */
  readonly detail: string;
}

export interface PlatformSupport {
  /** Node の process.platform 値 ('win32' / 'darwin' / 'linux' など)。 */
  readonly platform: string;
  readonly limitations: readonly PlatformLimitation[];
}

// 実測の根拠は bd memory: bdboard-2026-08-29-windows-portability-gaps。
// トンネル (cloudflared.exe の解決) は bdboard-70z.10 で対応済みなので、
// ここには入れない。
const WIN32_LIMITATIONS: readonly PlatformLimitation[] = [
  {
    feature: 'session-discovery',
    reason: '稼働中のエージェントセッションの検出は Windows では利用できません。',
    detail:
      'セッション検出は ps と lsof に依存している (ps-process-scanner.ts)。' +
      'どちらも Windows には存在しないため、検出結果は常に空になる。',
  },
  {
    feature: 'chat',
    reason: 'チャットは Windows では利用できません。',
    detail:
      'エージェントの起動は shell を介さない spawn で行っている ' +
      '(node-command-runner.ts)。これはセキュリティ上意図した設計だが、' +
      'そのため npm 経由で入る claude / codex / cursor-agent の .cmd シムを ' +
      'Windows では起動できない。',
  },
];

/**
 * 与えられたプラットフォームの制限一覧を返す。未知のプラットフォームは
 * 「制限なし」とみなす — 動くかもしれないものを先回りで塞ぐより、
 * 実際に壊れたときに直す方が害が小さい。
 */
export function describePlatformSupport(platform: string): PlatformSupport {
  return {
    platform,
    limitations: platform === 'win32' ? WIN32_LIMITATIONS : [],
  };
}

/**
 * すべての制限を外した記述。BDBOARD_IGNORE_PLATFORM_LIMITS 用 —
 * 形の組み立てを domain の外へ漏らさないための構築子 (PR#115 fable レビュー nit)。
 */
export function unrestrictedPlatformSupport(platform: string): PlatformSupport {
  return { platform, limitations: [] };
}

/** 指定機能が使えるか。 */
export function isPlatformFeatureSupported(
  support: PlatformSupport,
  feature: PlatformFeature,
): boolean {
  return !support.limitations.some((limitation) => limitation.feature === feature);
}

/** 指定機能の制限。使える場合は null。 */
export function findPlatformLimitation(
  support: PlatformSupport,
  feature: PlatformFeature,
): PlatformLimitation | null {
  return (
    support.limitations.find((limitation) => limitation.feature === feature) ?? null
  );
}
