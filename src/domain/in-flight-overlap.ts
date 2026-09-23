// src/domain/in-flight-overlap.ts は bdboard-sso1.76 でモジュール分割された。実体は
// ./in-flight-overlap/ 配下。このファイルは import 側 (application/board・domain/hygiene・
// interface/http/* 等) を書き換えないための re-export 入口としてのみ残す。挙動・型は
// 一切変えていない (移動のみ)。
//
// `export *` を使うと cross-module 専用に export した非公開ヘルパー (entryKey) まで
// 公開エクスポート面に漏れてしまう。よって公開面は分割前の export 一覧のとおり名前を
// 明示して re-export する (board.ts の分割 (PR #595) / harness-hooks.ts の分割と同じ方式。
// 回帰ガードは in-flight-overlap.exportSurface.test.ts /
// in-flight-overlap-type-export-surface.check.ts)。
export type { InFlightFileEntry, InFlightOverlap, InFlightOverlapPeer } from './in-flight-overlap/types.js';
export { OVERLAP_MESSAGE_FILE_LIMIT } from './in-flight-overlap/types.js';

export { computeInFlightOverlaps, overlapPeersForTicket } from './in-flight-overlap/compute.js';

export { formatOverlapFiles, formatOverlapPeers } from './in-flight-overlap/format.js';

export type { InFlightOverlapGroup } from './in-flight-overlap/group-by-ticket.js';
export { collectOverlapPeersByTicket } from './in-flight-overlap/group-by-ticket.js';

export type { InFlightWorktree } from './in-flight-overlap/worktrees.js';
export { selectInFlightWorktrees } from './in-flight-overlap/worktrees.js';
