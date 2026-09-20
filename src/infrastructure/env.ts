/**
 * bdboard-sso1.14: `src/bootstrap/env.ts` と
 * `src/infrastructure/chat/chat-agent-registry-builder.ts` にそれぞれ独立していた
 * env 読み取りヘルパーの共通実装置き場(sso1.9 レビュー指摘の解消)。
 *
 * `envString`/`envInt`/`envFloat`(既定値ありの版) は複数ファイルで実装が完全に
 * 同一だったためここへ統合する。`src/bootstrap/wire-tunnel.ts` /
 * `wire-agent-run.ts` / `wire-chat.ts` / `wire-ai-quota-widget.ts` に生えていた
 * ローカル重複コピーもここへ寄せる。
 * `chat-agent-registry-builder.ts` 側の `envFloat` (既定値を持たず `undefined` を
 * 返す版) と `envStringList` は挙動が異なる/対応物が無いため統合せず、呼び出し元に
 * それぞれ残す(chat-agent-registry-builder.ts 側のコメント参照)。
 *
 * `src/infrastructure/` は onion 層のうち最も外側寄りで、domain には依存してよいが
 * application/interface には依存できない(.dependency-cruiser.cjs)。このファイルは
 * `process.env` を直接読まず呼び出し元から `env` を受け取るだけの純粋関数なので、
 * どの層からの依存も問題なく満たせる。
 */

export function envBool(env: NodeJS.ProcessEnv, name: string): boolean {
  const raw = env[name];
  if (raw === undefined || raw === '') {
    return false;
  }
  return raw === '1' || raw.toLowerCase() === 'true';
}

export function envString(env: NodeJS.ProcessEnv, name: string, defaultValue: string): string {
  const raw = env[name];
  if (raw === undefined || raw === '') {
    return defaultValue;
  }
  return raw;
}

export function envInt(env: NodeJS.ProcessEnv, name: string, defaultValue: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') {
    return defaultValue;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) ? defaultValue : parsed;
}

/**
 * 負値/0 は不正値扱いで既定値へフォールバックする(bdboard-3tw.104.11 Opus レビュー N4 と
 * 同じ判断。詳細は `src/bootstrap/env.ts` の envFloat コメント参照)。
 */
export function envFloat(env: NodeJS.ProcessEnv, name: string, defaultValue: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') {
    return defaultValue;
  }
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return defaultValue;
  }
  return parsed;
}
