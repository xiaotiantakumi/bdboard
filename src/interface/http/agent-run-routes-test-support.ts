// src/interface/http/agent-run-routes-test-support.ts は bdboard-sso1.81 でモジュール
// 分割された。実体は ./agent-run-routes-test-support/ 配下:
//   - constants.ts     : 純粋なリテラル定数 (NOW/DEFAULT_REPO_ROOT/LOCAL_HOST/LOCAL_ENV/
//     CF_HEADER/SESSION_COOKIE)
//   - http-requests.ts : fetch の RequestInit を組み立てるヘルパー
//     (withLocalHost/withRemoteTunnel/postRunsInit/managedWorktreePath)
//   - board-cache.ts   : フェイク BoardCache とプロジェクト/チケットのフィクスチャ
//     (project/createFakeBoardCache/seedOpenTicket)
//   - run-deps.ts      : run 実行に関わるポートのフェイク
//     (allowingWriteAccess/makeProvisioner/makeIssueWriter/makeRunner)
//   - harness-status.ts: ハーネス状態 (preflight) のフィクスチャ
//     (READY_CONTRACT/harnessPack/readyHarnessStatus)
//   - routes.ts        : 上記を束ねて agent-run ルートを組み立てる工場 (makeRoutes)
// このファイルは import 側 (5つのリソース別テストファイル) を書き換えないための
// re-export 入口としてのみ残す (bdboard-sso1.36 で agent-run-routes.test.ts の move-only
// 分割時に新設されたときの経緯は各サブモジュールのコメントを参照)。挙動・型は一切
// 変えていない (移動のみ)。
export * from './agent-run-routes-test-support/constants.js';
export * from './agent-run-routes-test-support/http-requests.js';
export * from './agent-run-routes-test-support/board-cache.js';
export * from './agent-run-routes-test-support/run-deps.js';
export * from './agent-run-routes-test-support/harness-status.js';
export * from './agent-run-routes-test-support/routes.js';
