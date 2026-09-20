import { describe, expect, it } from 'vitest';
import * as cliChatAgent from './cli-chat-agent.js';

/**
 * bdboard-sso1.32: src/infrastructure/chat/cli-chat-agent.ts を機能別モジュール
 * (./cli-chat-agent/*.ts) へ分割した際の、実行時エクスポート面の回帰ガード。
 *
 * このリストは分割前 (分割 PR のベース、main の cli-chat-agent.ts) から
 * `grep -nE '^export ' src/infrastructure/chat/cli-chat-agent.ts` で機械的に採取した値
 * エクスポート名 (1件) をそのままハードコードしている。`export interface` は
 * TypeScript の型のみの宣言で実行時のバインディングを持たない (コンパイルで消える) ため、
 * `Object.keys()` には現れずこのリストにも含めていない — 型エクスポート面は
 * cli-chat-agent-type-export-surface.check.ts が tsc (`npm run build`) で固定する
 * (dto.ts 分割, PR #540 / claude-runner.ts 分割, PR #580 と同じ方式)。
 *
 * 分割後の cli-chat-agent.ts は各サブモジュールからの named re-export のみになる。
 * ここが崩れる (関数の移し忘れ・名前の変更・re-export の欠落、または内部ヘルパーの
 * 意図しない re-export による面の拡大) と、この一覧との差分としてすぐ検出できる。
 */
const EXPECTED_VALUE_EXPORTS = ['createCliChatAgent'].sort();

describe('cli-chat-agent.ts export surface (bdboard-sso1.32 module split regression guard)', () => {
  it('re-exports exactly the same runtime bindings as the pre-split file', () => {
    const actual = Object.keys(cliChatAgent).sort();
    expect(actual).toEqual(EXPECTED_VALUE_EXPORTS);
  });
});
