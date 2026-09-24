// bdboard-ulxa.1: マージ手順 S1 の入口 (`npm run merge-pr -- prepare|gate|finish|verify ...`)。
//
// 背景 (設計 bdboard-ulxa、計測 bdboard-iaqg 2026-09-23): 段階1までの手順は merge-slot を
// 握ったまま rebase → CI 待ち → verify をしていたため、11 時間中 7.6 時間 (約 70%) 枠が
// 埋まり、マージ間隔が約 12 分に張り付いた。S1 では枠の中を acquire → CAS → gh pr merge →
// release の数十秒に縮め、着地後検証は枠の外で行って GitHub commit status
// (bdboard/landed-verify) に記録する。次の merger はその台帳を層3 のゲートとして読む。
//
// 手順の正本: harness/packs/bdboard-harness/references/worktree-pr-flow.md §5「S1」、
// bdboard 固有の値と事故: docs/GIT-WORKFLOW.md「Merge serialization」。
import { pathToFileURL } from 'node:url';

import { main } from './merge-pr/cli.mjs';

export { evaluateLandedStatus } from './merge-pr/landed.mjs';
export { parseGitHubSlug, parseMergeConfig } from './merge-pr/config.mjs';
export { mergeCommand } from './merge-pr/gate.mjs';

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  process.exitCode = await main(process.argv.slice(2));
}
