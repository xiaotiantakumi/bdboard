import { describe, expect, it } from 'vitest';
import * as inFlightOverlap from './in-flight-overlap.js';

/**
 * bdboard-sso1.76: src/domain/in-flight-overlap.ts を関心別モジュール
 * (./in-flight-overlap/*.ts) へ分割する際の、実行時エクスポート面の回帰ガード。
 *
 * このリストは分割前 (このコミット時点) の in-flight-overlap.ts から
 * `grep -nE '^export (const|function|async function) [A-Za-z0-9_]+' src/domain/in-flight-overlap.ts`
 * で機械的に採取した値エクスポート名 (6件) をそのままハードコードしている。
 * `export interface` / `export type` は TypeScript の型のみの宣言で実行時のバインディングを
 * 持たない (コンパイルで消える) ため `Object.keys()` には現れずこのリストにも含めていない —
 * 型エクスポート面は in-flight-overlap-type-export-surface.check.ts が tsc (`npm run build`)
 * で固定する。
 *
 * 分割後の in-flight-overlap.ts は名前を明示した re-export (board.ts の分割 (PR #595) /
 * harness-hooks.ts の分割と同じ方式) のみになる。ここが崩れる (関数の移し忘れ・名前の変更・
 * re-export の欠落) と、この一覧との差分としてすぐ検出できる。
 */
const EXPECTED_VALUE_EXPORTS = [
  'OVERLAP_MESSAGE_FILE_LIMIT',
  'computeInFlightOverlaps',
  'overlapPeersForTicket',
  'formatOverlapFiles',
  'collectOverlapPeersByTicket',
  'formatOverlapPeers',
  'selectInFlightWorktrees',
].sort();

describe('in-flight-overlap.ts export surface (bdboard-sso1.76 module split regression guard)', () => {
  it('re-exports exactly the same runtime bindings as the pre-split in-flight-overlap.ts', () => {
    const actual = Object.keys(inFlightOverlap).sort();
    expect(actual).toEqual(EXPECTED_VALUE_EXPORTS);
  });
});
