import { describe, expect, it } from 'vitest';
import * as bdCliHumanDecisions from './bd-cli-human-decisions.js';

/**
 * bdboard-sso1.16: src/infrastructure/bd/bd-cli-human-decisions.ts を機能別モジュール
 * (./bd-cli-human-decisions/*.ts) へ分割した際の、実行時エクスポート面の回帰ガード。
 *
 * このリストは分割前 (分割 PR のベース、main の bd-cli-human-decisions.ts) から
 * `grep -nE '^export ' src/infrastructure/bd/bd-cli-human-decisions.ts` で機械的に
 * 採取した値エクスポート名 (12件) をそのままハードコードしている。`export interface` /
 * `export type` は TypeScript の型のみの宣言で実行時のバインディングを持たない
 * (コンパイルで消える) ため、`Object.keys()` には現れずこのリストにも含めていない —
 * 型エクスポート面は bd-cli-human-decisions-type-export-surface.check.ts が
 * tsc (`npm run build`) で固定する (dto.ts 分割, PR #540 と同じ方式)。
 *
 * 分割後の bd-cli-human-decisions.ts は各サブモジュールからの named re-export のみに
 * なった。ここが崩れる (関数の移し忘れ・名前の変更・re-export の欠落、または内部
 * ヘルパーの意図しない re-export による面の拡大) と、この一覧との差分としてすぐ検出できる。
 */
const EXPECTED_VALUE_EXPORTS = [
  'bdGateListItemSchema',
  'buildGateCloseReason',
  'buildResponseCommentBody',
  'buildTicketAmbiguousGatesResponseCommentBody',
  'buildTicketOwnQuestionAmbiguousResponseCommentBody',
  'buildTicketResponseCommentBody',
  'buildUnknownKindResponseCommentBody',
  'createBdCliHumanDecisions',
  'parseShowStdoutForKind',
  'parseShowWithDependentsStdout',
  'resolveGateBlockedTicketIds',
  'resolveKind',
  'resolveKindAndBlockingGates',
].sort();

describe('bd-cli-human-decisions.ts export surface (bdboard-sso1.16 module split regression guard)', () => {
  it('re-exports exactly the same runtime bindings as the pre-split file', () => {
    const actual = Object.keys(bdCliHumanDecisions).sort();
    expect(actual).toEqual(EXPECTED_VALUE_EXPORTS);
  });
});
