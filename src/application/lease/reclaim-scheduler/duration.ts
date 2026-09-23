// bdboard-sso1.51: reclaim-scheduler.ts のモジュール分割。回収の猶予窓(interval/olderThan)の
// 既定値と、bd の duration 文字列パーサをまとめたモジュール (move only, 挙動変更ゼロ)。

export const DEFAULT_RECLAIM_INTERVAL_MS = 5 * 60_000;

/**
 * lease 失効からこの猶予窓を過ぎたチケットだけを回収する。
 *
 * **10m から 2h へ引き上げた (bdboard-hybu)。** 旧既定は bd 側の「猶予は claim TTL の
 * 約2倍」という説明をそのまま採ったものだったが、TTL(≈5分) の2倍という尺度は
 * 「heartbeat が動いていれば失効しない」という前提の上でしか意味を持たない。実際には
 * heartbeat は打たれておらず、2026-09-05 に **生存セッションのチケット4件が作業中に
 * 回収された** (bdboard-okdh / 53my / s0o7 / s1vj)。いずれも claim から 15〜19 分後に
 * open へ戻され、その直後に当人が PR を出しているため、`bd ready` が「PR が飛んでいる
 * チケット」を空きとして提示した。
 *
 * 猶予窓が守るべきなのは TTL の倍数ではなく **1チケットの実作業時間** である。実測の
 * 15〜19 分はごく短い部類で、レビュー往復や verify 待ちを含む通常のチケットは数時間
 * かかる。**2h でもその全部は覆えない** — 覆えるのは実測された被害帯に 6 倍以上の余裕を
 * 持たせるところまでで、数時間かかるチケットは heartbeat が生きていることに依存し続ける。
 * それでも 2h を採るのは、本来の目的 (死んだセッションのチケットが永久に in_progress で
 * 塩漬けになるのを防ぐ) を最大 2h10m の遅延 (猶予窓 2h + 巡回間隔 5m + lease TTL 5m) で
 * 維持したまま、実測の事故を確実に外せる最小の値だから。
 *
 * これは**対症療法**である。恒久対策は「生存証拠を見てから回収する」(bdboard-6aci) で、
 * そちらが入れば猶予窓は本来の役割 (死活判定の遅延吸収) に戻せる。
 */
export const DEFAULT_RECLAIM_OLDER_THAN = '2h';

/**
 * 猶予窓の下限 (ミリ秒)。`DEFAULT_RECLAIM_OLDER_THAN` がこれを下回ると
 * 「作業中のチケットを回収する」既定に逆戻りするため、テストで固定している。
 */
export const MIN_SAFE_RECLAIM_OLDER_THAN_MS = 60 * 60_000;

/**
 * bd の duration 文字列 (`10m` / `2h` / `1h30m` / `90s`) をミリ秒に直す。
 * 解釈できない入力は undefined を返す — 呼び出し側が「検査できなかった」を
 * 「安全だった」と取り違えないようにするため、既定値へのフォールバックはしない。
 */
export function parseReclaimDurationMs(value: string): number | undefined {
  const trimmed = value.trim();
  // 先に全体形を固定してから足し上げる。部分一致で「検査できた」ことにすると、
  // `2 hours` のような入力が 2h として通り、下限チェックが黙って素通りする。
  if (!/^(\d+[hms])+$/.test(trimmed)) {
    return undefined;
  }
  const unitMs: Record<string, number> = { h: 3_600_000, m: 60_000, s: 1_000 };
  let total = 0;
  for (const match of trimmed.matchAll(/(\d+)([hms])/g)) {
    total += Number(match[1]) * (unitMs[match[2] as string] as number);
  }
  return total;
}
