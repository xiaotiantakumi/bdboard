/**
 * bdboard-sso1.9: src/main.ts (composition root) から起動時の env 読み取りヘルパーを
 * 移動しただけ (move only, 挙動変更ゼロ)。
 *
 * `src/bootstrap/` は application/infrastructure/interface のどの層にも属さない
 * composition root 側のコード置き場 (main.ts と同じ立ち位置)。
 * dependency-cruiser の層ルール (`application-no-infrastructure` 等) は
 * `^src/(application|infrastructure|interface)` にしかマッチしないため、この置き場は
 * 無制約 — main.ts が元々そうだったのと同じ扱い (詳細は .dependency-cruiser.cjs)。
 *
 * `src/infrastructure/chat/chat-agent-registry-builder.ts` にも同名関数の独自コピーが
 * あるが、この PR は move-only なのでそちらは触らない (重複解消は別チケット)。
 */

export function envString(name: string, defaultValue: string): string {
  const raw = process.env[name];
  if (raw === undefined || raw === '') {
    return defaultValue;
  }
  return raw;
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
  const raw = process.env[name];
  if (raw === undefined || raw === '') {
    return false;
  }

  return raw === '1' || raw.toLowerCase() === 'true';
}

export function envBoolDefaultTrue(name: string): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') {
    return true;
  }

  return raw !== '0' && raw.toLowerCase() !== 'false';
}

export function envInt(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') {
    return defaultValue;
  }

  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    return defaultValue;
  }

  return parsed;
}

export function envFloat(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') {
    return defaultValue;
  }

  const parsed = Number.parseFloat(raw);
  // 負値/0 を受理すると chat-routes.ts 経由のログ・descriptor 表示に「実態と異なる重み」が
  // そのまま載ってしまう(chat-rate-limit.ts の normalizeWeight による <=0 クランプは
  // limiter.consume() 時にしか効かない)。ここで弾いて既定へフォールバックさせる
  // (bdboard-3tw.104.11 Opus レビュー N4、chat-agent-registry-builder.ts の envFloat と同じ判断)。
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return defaultValue;
  }

  return parsed;
}
