/**
 * bdboard-sso1.9: src/main.ts (composition root) から起動時の env 読み取りヘルパーを
 * 移動しただけ (move only, 挙動変更ゼロ)。
 *
 * `src/bootstrap/` は application/infrastructure/interface のどの層にも属さない
 * composition root 側のコード置き場 (main.ts と同じ立ち位置)。
 * dependency-cruiser の層ルール (`application-no-infrastructure` 等) は
 * `^src/(application|infrastructure|interface)` にしかマッチしないため、この置き場は
 * IMPORT SOURCE としては無制約 — main.ts が元々そうだったのと同じ扱い。ただし
 * bdboard-sso1.14 で追加した `no-upstream-deps-on-bootstrap` ルールにより、
 * IMPORT TARGET としては他の4層から参照できない (詳細は .dependency-cruiser.cjs)。
 *
 * `envString`/`envInt` の実体は `src/infrastructure/env.ts` に統合した
 * (bdboard-sso1.14, sso1.9 レビュー指摘の解消)。このファイルは main.ts 側の
 * 既存呼び出し( `envString(name, default)` のように `process.env` を暗黙に読む形 )を
 * 変えないための薄いラッパーとして残す。
 * `src/infrastructure/chat/chat-agent-registry-builder.ts` はこのラッパーではなく
 * `src/infrastructure/env.ts` を直接 import する(bootstrap は他層から参照できないため)。
 */

import {
  envBool as sharedEnvBool,
  envFloat as sharedEnvFloat,
  envInt as sharedEnvInt,
  envString as sharedEnvString,
} from '../infrastructure/env.js';

export function envString(name: string, defaultValue: string): string {
  return sharedEnvString(process.env, name, defaultValue);
}

/** 未設定・空文字のとき undefined。health の instanceNonce など「無いときフィールド自体を出さない」用途向け。 */
export function envOptionalString(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === '') {
    return undefined;
  }
  return raw;
}

export function envBool(name: string): boolean {
  return sharedEnvBool(process.env, name);
}

export function envBoolDefaultTrue(name: string): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') {
    return true;
  }

  return raw !== '0' && raw.toLowerCase() !== 'false';
}

export function envInt(name: string, defaultValue: number): number {
  return sharedEnvInt(process.env, name, defaultValue);
}

// 負値/0 を受理すると chat-routes.ts 経由のログ・descriptor 表示に「実態と異なる重み」が
// そのまま載ってしまう(chat-rate-limit.ts の normalizeWeight による <=0 クランプは
// limiter.consume() 時にしか効かない)。ここで弾いて既定へフォールバックさせる
// (bdboard-3tw.104.11 Opus レビュー N4、chat-agent-registry-builder.ts の envFloat と同じ判断)。
export function envFloat(name: string, defaultValue: number): number {
  return sharedEnvFloat(process.env, name, defaultValue);
}
