import { Hono } from 'hono';
import {
  createPrBadgeGates,
  getPrBadges,
  PrBadgeStatusCache,
  type PrBadgeCommentCache,
} from '../../application/board/get-pr-badges.js';
import { toPrBadgeDto } from './dto.js';
import { parseProjectIds } from './api-route-shared.js';
import type { ApiDeps } from './routes.js';

// bdboard-sso1.61: hygiene-routes.ts (旧284行、5ルートが同居) の分割で
// GET /api/pr-links をここへ切り出した (move only, 挙動変更ゼロ)。PR コメント
// 走査キャッシュ (prBadgeCommentCache) は GET /api/hygiene
// (hygiene-status-routes.ts) の close 証拠チェックと共有する (bdboard-pkr6.16)
// ため、合成層 (hygiene-routes.ts) から明示引数で受け取る。
//
// bdboard-ye2p: PR ステータスキャッシュ (prBadgeStatusCache) は以前このルートで
// `new PrBadgeStatusCache()` として毎プロセス起動ごとに空で作っていたが、
// サーバー再起動をまたいで terminal な結果を残すため deps 経由 (bootstrap 側で
// 永続化ストアから読み込んで組み立てたインスタンス) で受け取るように変えた。
// deps.prBadgeStatusCache が未設定 (テスト等で明示的に渡していない場合) は
// 従来どおり空のインメモリキャッシュにフォールバックする。

// bdboard-se3v: /api/pr-links が (再起動直後の未キャッシュ状態で) 55秒かかっていた
// 問題への対応。gh 起動の並列度をコメント取得と切り離して上げた (get-pr-badges.ts
// 側) のに加え、ここでリクエスト全体に時間予算を持たせる —— 予算を超えたら
// その時点で分かっている分だけ返し (未解決分は status:null のまま)、残りは
// バックグラウンドで走らせ続けて次回の呼び出し (board.changed のたびに来る) で
// キャッシュヒットとして返す。
//
// bdboard-sgpa: 議長の本番計測 (#647 反映後、load avg 42 で他エージェントの verify
// と並走) では、4.5秒の予算でも連続6回のリクエストが 4.83秒→5.74秒 と単調に伸び、
// 受け入れ基準の「5秒以内」を高負荷時にわずかに超えていた。これは主に
// commentGate/statusGate が呼び出しごとに新しい Semaphore だった (bdboard-sgpa 本体
// のバグ) せいで重なったリクエストが gh/bd 起動を重複させ、レスポンス組み立てに
// 追加の遅延を乗せていたことが原因 —— gates を共有した今回の修正で伸びは止まる
// はずだが、安全側に倒して予算自体も 4.5秒→4.0秒 に縮め、レスポンスの
// シリアライズ/転送 + Hono のミドルウェア分の余裕を厚くした。
const PR_LINKS_OVERALL_TIMEOUT_MS = 4_000;

export interface PrLinksRoutesParams {
  readonly prBadgeCommentCache: PrBadgeCommentCache;
}

export function createPrLinksRoutes(
  deps: ApiDeps,
  { prBadgeCommentCache }: PrLinksRoutesParams,
): Hono {
  const app = new Hono();
  // deps.prBadgeStatusCache が無いテスト/呼び出し経路では、従来どおり
  // プロセス内だけの空キャッシュにフォールバックする (永続化なし、挙動は旧来通り)。
  const prBadgeStatusCache = deps.prBadgeStatusCache ?? new PrBadgeStatusCache();
  // bdboard-sgpa: commentGate/statusGate をルート (= プロセス) の寿命で1組だけ作り、
  // すべての /api/pr-links 呼び出しで共有する。以前は getPrBadges() が呼び出しごとに
  // 新しい Semaphore ペアを作っていたため、重なったリクエスト (30秒 staleTime の
  // window-focus 再取得、board.changed イベント、複数タブ) のそれぞれが独立した
  // 同時実行上限を持ってしまい、意図した上限 (COMMENT_FETCH_CONCURRENCY=3 / 既定の
  // statusFetchConcurrency=8) が「1リクエストあたり」にしか効かなかった (重なった
  // リクエストの数だけ実質的な gh/bd 起動数の上限が掛け算される —— 実測で3リクエスト
  // 重複時に bd 読み取りが12件で済むはずが27件、gh 起動が3件の意図上限に対し最大9件
  // 同時に起動していた)。
  const gates = createPrBadgeGates();

  app.get('/api/pr-links', async (c) => {
    if (deps.commentReader === undefined || deps.prStatusReader === undefined) {
      return c.json({ error: 'pr links not available' }, 501);
    }

    const projectIds = parseProjectIds(c.req.query('projects'));
    const badges = await getPrBadges(
      deps.cache,
      deps.commentReader,
      deps.prStatusReader,
      {
        ...(projectIds !== undefined ? { projectIds } : {}),
        commentCache: prBadgeCommentCache,
        statusCache: prBadgeStatusCache,
        overallTimeoutMs: PR_LINKS_OVERALL_TIMEOUT_MS,
        gates,
      },
    );
    return c.json(badges.map(toPrBadgeDto));
  });

  return app;
}
