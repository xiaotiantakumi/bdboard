import { describe, expect, it } from 'vitest';
import * as claudeSpec from './claude-spec.js';

/**
 * bdboard-sso1.45: src/infrastructure/chat/specs/claude-spec.ts を機能別モジュール
 * (./claude-spec/*.ts) へ分割した際の、実行時エクスポート面の回帰ガード。
 *
 * このリストは分割前 (分割 PR のベース、main の claude-spec.ts) から
 * `grep -nE '^export ' src/infrastructure/chat/specs/claude-spec.ts` で機械的に採取した値
 * エクスポート名 (5件) をそのままハードコードしている。`export interface` は
 * TypeScript の型のみの宣言で実行時のバインディングを持たない (コンパイルで消える) ため、
 * `Object.keys()` には現れずこのリストにも含めていない — 型エクスポート面は
 * claude-spec-type-export-surface.check.ts が tsc (`npm run build`) で固定する
 * (dto.ts 分割, PR #540 / claude-runner.ts 分割, PR #580 / cli-chat-agent.ts 分割,
 * PR #592 と同じ方式)。
 *
 * 分割後の claude-spec.ts は各サブモジュールからの named re-export のみになる。
 * ここが崩れる (関数の移し忘れ・名前の変更・re-export の欠落、または内部ヘルパーの
 * 意図しない re-export による面の拡大) と、この一覧との差分としてすぐ検出できる。
 */
const EXPECTED_VALUE_EXPORTS = [
  'CLAUDE_ENV_ALLOWLIST',
  'DEFAULT_CLAUDE_MODEL_WEIGHTS',
  'DEFAULT_CLAUDE_MODEL_IDS',
  'CLAUDE_CHAT_MODELS',
  'createClaudeSpec',
].sort();

describe('claude-spec.ts export surface (bdboard-sso1.45 module split regression guard)', () => {
  it('re-exports exactly the same runtime bindings as the pre-split file', () => {
    const actual = Object.keys(claudeSpec).sort();
    expect(actual).toEqual(EXPECTED_VALUE_EXPORTS);
  });
});
