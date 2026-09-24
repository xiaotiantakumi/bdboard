import { compareStrings } from '../../domain/compare.js';
import type { PrBadge } from '../../domain/pr-link.js';
import type { BoardCache, CachedProject } from '../ports/board-cache.js';
import type { CommentReader } from '../ports/comment-reader.js';
import type { PrStatusReader } from '../ports/pr-status-reader.js';
import type { Ticket } from '../../domain/ticket.js';
import { describeFetchFailures, type FetchFailure } from './fetch-failure-log.js';
import type { PrBadgeCommentCache } from './pr-badge-comment-cache.js';
import type { PrBadgeStatusCache } from './pr-badge-status-cache.js';
import { resolvePrStatus, type PrStatusBudget } from './resolve-pr-status.js';
import { resolvePrCommentUrl } from './resolve-pr-comment-url.js';
import { raceWithOverallTimeout } from './race-with-overall-timeout.js';

// 後方互換のため re-export する (hygiene-routes.ts / hygiene-status-routes.ts /
// pr-links-routes.ts / get-close-evidence.ts / テストがこのファイルから import
// している。bdboard-se3v で pr-badge-comment-cache.ts / pr-badge-status-cache.ts に
// 分割したが、呼び出し側の import パスは変えていない)。
export { PrBadgeCommentCache } from './pr-badge-comment-cache.js';
export { PrBadgeStatusCache, type PrBadgeStatusCacheOptions } from './pr-badge-status-cache.js';
// bdboard-sgpa: commentGate/statusGate 型と生成関数は行数上限対応で pr-badge-gates.ts に
// 切り出した (move only)。pr-links-routes.ts / テストがこのファイルから import している
// ため、後方互換で re-export する。
export { createPrBadgeGates, type PrBadgeGates } from './pr-badge-gates.js';
import { createPrBadgeGates, type PrBadgeGates } from './pr-badge-gates.js';

export interface GetPrBadgesOptions {
  readonly projectIds?: readonly string[];
  /** 取得失敗の警告ログ。未指定なら console.warn (discover-projects と同じ注入流儀)。 */
  readonly logWarn?: (message: string) => void;
  /** コメントから抽出した PR URL のインメモリキャッシュ。未指定なら毎回フルフェッチ。 */
  readonly commentCache?: PrBadgeCommentCache;
  /** gh pr view 由来の PR 状態インメモリキャッシュ。未指定なら毎回フルフェッチ。 */
  readonly statusCache?: PrBadgeStatusCache;
  /**
   * 1回の呼び出しで新規に gh を起動する上限 (in-flight 共有で乗っかれるものは含まない)。
   * 上限に達した分は今回は URL のみのバッジで妥協し、次回の呼び出し (board.changed の
   * たびに来る) に回す (bdboard-7ln6 #6)。未指定なら DEFAULT_MAX_NEW_FETCHES_PER_CALL。
   *
   * **`overallTimeoutMs` を指定した呼び出しではこのオプションは無視される
   * (bdboard-ksed)。** 応答時間は `overallTimeoutMs` 自体と `statusGate` の同時実行数
   * 上限で既に守られており、この総数上限を重ねて掛ける意味が無い —— それどころか
   * 実測では、commentCache が呼び出しをまたいで温まっているとほぼ全チケットが
   * マイクロタスク単位で resolvePrStatus に到達するため、応答がタイムアウトする
   * ずっと前にこの上限を使い切ってしまい、残りは今回の呼び出しでは二度と試みられ
   * ない (「タイムアウト後だけ上限を外す」設計は、予算を使い切るタイミングが
   * タイムアウトよりずっと早いため効果が無かった)。`overallTimeoutMs` 指定時は
   * `statusGate`/`statusFetchConcurrency` の同時起動数上限とサーキットブレーカー
   * だけで絞る (gh の同時起動数が無制限になるわけではない)。`overallTimeoutMs`
   * 未指定 (完了まで同期的に待つ呼び出し) では、このオプションは従来通り効く。
   */
  readonly maxNewFetchesPerCall?: number;
  /**
   * PR ステータス取得 (gh pr view 起動) 専用の並列数。コメント取得 (bd 経由・ローカル)
   * とは独立した上限を持つ (bdboard-se3v)。以前はコメント取得とステータス取得が同じ
   * worker 内で直列に実行され、事実上ステータス取得もコメント取得と同じ並列数
   * (COMMENT_FETCH_CONCURRENCY=3) でしか起動できなかった。gh はネットワーク越しの
   * プロセス起動でボトルネックの本体なので、ここだけ高い並列数を持たせて短縮する
   * (際限なく並列にはしない —— 上限は残す)。`gates` を渡した場合はそちらの並列数が
   * 優先され、このオプションは無視される (bdboard-sgpa)。未指定なら
   * DEFAULT_STATUS_FETCH_CONCURRENCY。
   */
  readonly statusFetchConcurrency?: number;
  /**
   * この呼び出し全体 (コメント解決 + ステータス取得) の時間予算 (ms)。超過した時点で、
   * その時点までに分かっている分だけを返す (未解決分は status:null のまま —— 既存の
   * 「取得できていない」という意味を変えずに使い回す。bdboard-se3v)。超過後も内部の
   * 取得処理はキャンセルせず裏で走らせ続け、各キャッシュ (commentCache/statusCache) を
   * 温めて次回の呼び出しに備える。未指定ならタイムアウトなし (完了まで待つ、従来通り)。
   */
  readonly overallTimeoutMs?: number;
  /**
   * commentGate/statusGate をリクエストをまたいで共有するための注入口 (bdboard-sgpa)。
   * 未指定なら呼び出しごとに新しい Semaphore ペアを作る (従来通り — テストや単発呼び出し
   * はこれで十分)。/api/pr-links のように短い間隔で重なりうる呼び出し元は、
   * createPrBadgeGates() で1組だけ作ってルートの寿命で使い回すこと。そうしないと、
   * 重なった呼び出しそれぞれが独立した Semaphore を持ってしまい、意図した同時実行上限が
   * 「1呼び出しあたり」にしか効かなくなる (重なった呼び出しの数だけ実質的な gh/bd 起動数
   * の上限が掛け算される)。
   */
  readonly gates?: PrBadgeGates;
}

// 1回の getPrBadges 呼び出しで新規に起動する gh の上限 (bdboard-7ln6 #6)。
// in-flight 共有で乗っかれるものはこの上限を消費しない。
const DEFAULT_MAX_NEW_FETCHES_PER_CALL = 20;

interface CommentFetchItem {
  readonly entry: CachedProject;
  readonly ticket: Ticket;
}

export async function getPrBadges(
  cache: BoardCache,
  commentReader: CommentReader,
  prStatusReader: PrStatusReader,
  options?: GetPrBadgesOptions,
): Promise<readonly PrBadge[]> {
  const projectIdFilter = options?.projectIds;
  const allEntries = cache.listProjects();
  let entries = allEntries;

  if (projectIdFilter !== undefined) {
    const filterSet = new Set(projectIdFilter);
    entries = entries.filter((entry) => filterSet.has(entry.project.id));
  }

  const workItems: CommentFetchItem[] = entries.flatMap((entry) =>
    entry.tickets
      .filter((ticket) => ticket.commentCount > 0)
      .map((ticket) => ({ entry, ticket })),
  );

  const commentCache = options?.commentCache;
  const statusCache = options?.statusCache;
  const maxNewFetchesPerCall = options?.maxNewFetchesPerCall ?? DEFAULT_MAX_NEW_FETCHES_PER_CALL;
  const overallTimeoutMs = options?.overallTimeoutMs;
  const logWarn = options?.logWarn ?? ((message: string) => console.warn(message));

  // フィルタ後の workItems ではなく盤面全体 (allEntries) の commentCount>0 集合で
  // pruning する。フィルタ済みの集合を使うと、projectIds でプロジェクトを絞った
  // 呼び出しのたびにフィルタ対象外プロジェクトのキャッシュエントリが間引かれ、
  // 複数プロジェクトを行き来する通常利用でキャッシュが定着しない
  // (bdboard-fwse レビュー指摘)。
  if (commentCache !== undefined) {
    const allTicketIds = new Set(
      allEntries.flatMap((entry) =>
        entry.tickets.filter((ticket) => ticket.commentCount > 0).map((ticket) => ticket.id),
      ),
    );
    commentCache.prune(allTicketIds);
  }

  // ticketId をキーにする (配列 push ではなく) —— URL 解決が終わった時点で status:null の
  // プレースホルダを入れ、ステータス解決が完了したら上書きする。全体タイムアウトで早期に
  // 打ち切っても、この Map をそのままスナップショットすれば「PR は分かっているがステータス
  // 未取得」を素直に表現できる (status:null は元々失敗/rate-limit/予算切れでも使っていた
  // 値であり、意味は変えない)。
  const badgesByTicket = new Map<string, PrBadge>();

  // bdboard-3znc: commentCount>0 の全チケットに、処理開始前に「未取得」プレースホルダ
  // (url:null, status:null) をあらかじめ置いておく。以前は URL 解決が終わったチケットに
  // だけ Map エントリが入る設計だったため、全体タイムアウトがコメント走査の完了前
  // (ゲート待ちで一度も bd を起動できていない段階) に来たチケットは Map に一切
  // エントリが無いまま応答へスナップショットされ、「PR が無いチケット」と応答上
  // 区別が付かなかった。runTicket は解決が終わり次第このプレースホルダを実際の結果で
  // 上書きするか (PR あり)、削除する (PR 無し/コメント取得失敗) —— 何もしなければ
  // 「commentCount>0 だが時間内に走査できなかった」ことがそのまま url:null として
  // 応答に残る。url:null は「PR が無い」ではなく「まだ分からない」を表す新しい意味で、
  // 既存の status:null (「URL は分かっているが状態が未取得」) の意味は変えていない。
  for (const { entry, ticket } of workItems) {
    badgesByTicket.set(ticket.id, {
      ticketId: ticket.id,
      projectId: entry.project.id,
      url: null,
      status: null,
    });
  }

  // 握り潰しの理由と、1行にまとめる理由は fetch-failure-log.ts を参照 (bdboard-fxxk)。
  const commentFailures: FetchFailure[] = [];
  const statusFailures: FetchFailure[] = [];
  let statusAttempts = 0;
  // bdboard-ksed: overallTimeoutMs を指定する呼び出し元 (/api/pr-links) は、応答時間
  // そのものは overallTimeoutMs 自体と statusGate の同時実行上限で既に守られている。
  // maxNewFetchesPerCall はそれとは別の「1回の呼び出しで新規に起動してよい gh の
  // 総数」という上限だが、実測 (このチケットのレビューで確認) では効かない —— この
  // ルートは commentCache をリクエストをまたいで共有するため、2回目以降の呼び出しは
  // ほぼ全チケットが resolvePrStatus に到達するまでの URL 解決がキャッシュヒットで
  // 一瞬 (マイクロタスク単位) に終わり、応答がタイムアウトするずっと前に
  // maxNewFetchesPerCall 件ぶんの予算を使い切って残り全部を見送ってしまう。
  // (「タイムアウト後だけ上限を外す」という設計を最初に試したが、上記の理由で
  // ほぼ意味を持たないことが実験で分かった —— 予算はタイムアウトよりずっと前に
  // 尽きているため、タイムアウト時点で外しても手遅れ。)
  // そのため overallTimeoutMs 指定時は最初から総数上限を掛けず、同時起動数
  // (statusGate) とサーキットブレーカー (isCircuitOpen) だけで絞る —— 応答時間の
  // 保護という maxNewFetchesPerCall の役目は overallTimeoutMs 自体が既に果たして
  // いるので、二重の制限を掛ける理由が無い。overallTimeoutMs 未指定 (完了まで
  // 同期的に待つ呼び出し) では、1回の呼び出しで大量の gh を (concurrency の枠内で
  // 順々にでも) 起動し尽くすのを避けるため、従来通り maxNewFetchesPerCall で絞る。
  const statusBudget: PrStatusBudget = {
    remaining: overallTimeoutMs !== undefined ? Number.POSITIVE_INFINITY : maxNewFetchesPerCall,
  };
  let deferredFetchCount = 0;
  // bdboard-sgpa: 呼び出し元が gates を渡していれば (/api/pr-links のようにリクエストを
  // またいで共有したい場合) それを使う。渡さなければ従来通りこの呼び出し専用の
  // Semaphore ペアを作る (テストや単発呼び出しはこちらで十分 —— 挙動は分割前と同じ)。
  const { commentGate, statusGate } =
    options?.gates ??
    createPrBadgeGates({ statusFetchConcurrency: options?.statusFetchConcurrency });

  const logCompletionWarnings = (): void => {
    if (commentFailures.length > 0) {
      logWarn(
        '[pr-links] could not load comments for some tickets; their PR badges are missing. ' +
          describeFetchFailures(commentFailures, workItems.length),
      );
    }
    if (statusFailures.length > 0) {
      logWarn(
        '[pr-links] could not load PR status for some links; those badges show no status. ' +
          describeFetchFailures(statusFailures, statusAttempts),
      );
    }
    if (deferredFetchCount > 0) {
      logWarn(
        `[pr-links] deferred ${deferredFetchCount} PR status fetch(es) to a later refresh ` +
          `(reached the limit of ${maxNewFetchesPerCall} new gh launches for this request).`,
      );
    }
  };

  // 1チケットぶんの処理単位: URL 解決 (bd 経由・resolve-pr-comment-url.ts) → 分かれば
  // ステータス解決 (gh 経由) を直列に行うが、どちらも専用のセマフォで別々に同時実行数を
  // 絞るだけで、全チケットの worker 自体は最初から並行に起動する (bdboard-se3v)。以前は
  // 「全チケットのURL解決 (Pass 1) が終わってから全チケットのステータス解決 (Pass 2) を
  // 始める」という2段構成だったが、実データで計測すると Pass 1 だけで overallTimeoutMs を
  // 使い切ってしまい、gh が1件も起動できないまま毎回タイムアウトするケースが確認できた。
  // commentGate/statusGate それぞれの acquire は実際に gh/bd を起動する側だけが行う
  // (bdboard-ksed: 相乗りする呼び出しはゲートに触れない)。キャッシュ/予算の判定は
  // ゲート取得より前に行われ、サーキットブレーカーの状態だけはゲート取得の直後にも
  // もう一度確認する (ゲート待ちの間にトリップした場合を拾うため。
  // resolve-pr-status.ts 参照)。
  const runTicket = async ({ entry, ticket }: CommentFetchItem): Promise<void> => {
    let url: string | null;
    try {
      url = await resolvePrCommentUrl(entry, ticket, { commentReader, commentCache, commentGate });
    } catch (error) {
      // コメントが読めないチケットは飛ばす。そのチケットのバッジは出ない (bdboard-3znc の
      // プレースホルダも「未取得」ではなくここで削除する —— 失敗は「まだ分からない」では
      // なく既存契約通り「バッジ無し」のまま)。
      commentFailures.push({ id: ticket.id, error });
      badgesByTicket.delete(ticket.id);
      return;
    }

    if (url === null) {
      // コメント走査は終わったが PR は無かった —— 「未取得」ではなく「バッジ無し」
      // なので、プレースホルダを消す (bdboard-3znc)。
      badgesByTicket.delete(ticket.id);
      return;
    }

    badgesByTicket.set(ticket.id, {
      ticketId: ticket.id,
      projectId: entry.project.id,
      url,
      status: null,
    });

    // ステータスキャッシュに既にヒットしている場合は statusGate を消費しない
    // (commentGate のキャッシュヒットと同じ理由: gh を起動しないのに並列枠を
    // 1つ使うと、遅い gh 呼び出しで枠が埋まっている間、既知のステータスまで
    // 「未取得」に劣化して返ってしまう。opus レビューで指摘 — bdboard-se3v)。
    const cachedStatus = statusCache?.get(url);
    if (cachedStatus !== undefined) {
      badgesByTicket.set(ticket.id, {
        ticketId: ticket.id,
        projectId: entry.project.id,
        url,
        status: cachedStatus,
      });
      return;
    }

    // bdboard-ksed: statusGate の acquire/release は resolvePrStatus 自身の中 —
    // 実際に gh を起動する呼び出しだけが行う。既に in-flight の URL に相乗りする
    // だけの呼び出しはゲートを一切待たない (以前はここで無条件に acquire していた
    // ため、相乗りするだけの呼び出しもフェッチ完了までゲートの枠を占有していた —
    // bdboard-sgpa の opus レビュー指摘)。
    const status = await resolvePrStatus(url, {
      prStatusReader,
      statusCache,
      statusGate,
      budget: statusBudget,
      // bdboard-gfqz: このチケットの gh 起動が「まだ応答を待っている自分のリクエスト」
      // 由来か「応答タイムアウト後のバックグラウンド継続」由来かを、実際に
      // statusGate.acquire() する直前に都度判定する (timedOut は let なので、この
      // 呼び出し時点ではまだ false でも、ゲート待ちしている間に true へ変わりうる —
      // その場合でも判定はここではなく resolvePrStatus 内の acquire 直前で行われる)。
      getPriority: () => (timedOut ? 'low' : 'high'),
      onDeferred: () => {
        deferredFetchCount += 1;
      },
      onAttempt: () => {
        statusAttempts += 1;
      },
      onFailure: (error) => {
        statusFailures.push({ id: url, error });
      },
    });
    badgesByTicket.set(ticket.id, {
      ticketId: ticket.id,
      projectId: entry.project.id,
      url,
      status,
    });
  };

  const mainWork = Promise.all(workItems.map(runTicket)).then(() => undefined);

  let timedOut = false;
  if (overallTimeoutMs !== undefined) {
    timedOut = await raceWithOverallTimeout(mainWork, overallTimeoutMs);
  } else {
    await mainWork;
  }

  const snapshotBadges = (): PrBadge[] => {
    const badges = [...badgesByTicket.values()];
    badges.sort((a, b) => {
      const projectDiff = compareStrings(a.projectId, b.projectId);
      if (projectDiff !== 0) {
        return projectDiff;
      }
      return compareStrings(a.ticketId, b.ticketId);
    });
    return badges;
  };

  if (timedOut) {
    const partial = snapshotBadges();
    // bdboard-3znc の url:null プレースホルダ (「まだ PR の有無すら分からない」) と、
    // url は分かっているが status がまだ無いバッジ (「PR は分かっているが gh 未取得」)
    // は意味が違うので別々に数える (opus レビュー指摘: 以前は両方まとめて「status
    // 未取得」と表示しており、コメント走査すら終わっていないチケットを「PRの状態が
    // 未取得なだけ」であるかのように誤解させていた)。
    const unfetchedCount = partial.filter((badge) => badge.url === null).length;
    const statusUnresolvedCount = partial.filter(
      (badge) => badge.url !== null && badge.status === null,
    ).length;
    logWarn(
      `[pr-links] overall time budget of ${overallTimeoutMs}ms exceeded; returning ` +
        `${partial.length} badge(s) so far (${unfetchedCount} with no PR found yet, ` +
        `${statusUnresolvedCount} with a known PR but no status yet). ` +
        'The remaining comment/status lookups keep running in the background and will warm ' +
        'the cache for the next refresh.',
    );
    // mainWork は止めない (キャッシュを温め続けさせる)。この応答はもう使わないので、
    // 完了時の失敗ログだけ後追いで出す。想定外の reject に備えて拾っておく。
    mainWork.then(logCompletionWarnings, (error: unknown) => {
      logWarn(
        `[pr-links] background continuation after timeout failed unexpectedly: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
    return partial;
  }

  logCompletionWarnings();
  return snapshotBadges();
}
