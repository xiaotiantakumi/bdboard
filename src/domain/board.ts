// src/domain/board.ts は bdboard-sso1.34 でモジュール分割された。実体は ./board/ 配下。
// このファイルは import 側 (dto・application/board・web の ticketWatch 等) を書き換えない
// ための re-export 入口としてのみ残す。挙動・型は一切変えていない (移動のみ)。
//
// 分割前は buildBlocksIndex / deriveBlocks / computeEffectivePriorities / deriveSessions
// 等の補助関数が同じファイル内の非公開関数だった。分割後はサブモジュール間の
// cross-module import のために export を付けているものがあるが、ここで `export *` を
// 使うと元は非公開だった補助関数まで公開エクスポート面に漏れてしまう。よって公開面は
// 分割前の export 一覧のとおり名前を明示して re-export する (harness-contract.ts の分割
// (PR #568) / hygiene.ts の分割 (PR #556) / dto.ts の分割 (PR #540) と同じ方式。回帰ガードは
// board.exportSurface.test.ts / board-type-export-surface.check.ts)。
export type { Board, BoardCard, BuildBoardInput } from './board/types.js';

export { buildBoard, mergeBoards } from './board/build.js';
export { compareCards } from './board/card-compare.js';
