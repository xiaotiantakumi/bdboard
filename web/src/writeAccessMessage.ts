import { ApiError } from './api';

/**
 * 書き込み/チャットが 403 で弾かれたときに、理由と次の行動を日本語で説明する
 * (bdboard-cu4)。
 *
 * スマホ(トンネル経由)からだと、サーバーの生メッセージ 'local access only' が
 * そのままトーストに出るだけで、ユーザーには何が起きたのか分からなかった。
 * サーバー側の 403 は次の 2 系統しかないので、ここで行動可能な文言に変換する。
 *
 * 文字列はサーバー(src/interface/http/write-guard.ts / chat-routes.ts)の定数と
 * 対になっている。web/ から src/ は import できない(別 tsconfig・レイヤ境界)ので
 * 意図的な二重定義。サーバー側を変えるならここも変える。
 */
const SERVER_NOT_AUTHORIZED = 'local access only';
const SERVER_CSRF_BLOCKED = 'cross-site write blocked';
const SERVER_CHAT_NOT_AUTHORIZED =
  'chat requires local access or an authorized tunnel session';
const SERVER_CHAT_CSRF_BLOCKED = 'cross-site chat request blocked';
const SERVER_REMOTE_RUNS_DISABLED = 'remote agent runs are disabled';

/**
 * 409 を返すが「他セッションによる変更」ではないサーバーエラー文字列(bdboard-o2o)。
 * 文字列はサーバー側の定数と対になっている(上の 403 定数と同じ理由で二重定義)。
 *
 * - tunnel-routes.ts の /api/tunnel/access-token: トンネルが起動していない。
 * - chat-routes.ts: 同一プロジェクトの別メッセージを処理中。
 *
 * これら以外の 409 (issue-writer 系の楽観ロック競合など) は CONFLICT_WRITE_HELP に
 * フォールバックする — 呼び出し側(ChatPanel.tsx / TunnelControl.tsx など)は今のところ
 * これらの 409 を describeWriteError 経由で表示していない(独自の文言を持つ)ため、この
 * ディスパッチは describeWriteError の将来の呼び出し元/回帰に対する保険。
 */
const SERVER_TUNNEL_NOT_RUNNING = 'tunnel is not running';
const SERVER_CHAT_BUSY = 'chat is busy for this project';

/** トンネル経由で書き込めないときの説明。理由が 2 つあるので両方を出す。 */
export const TUNNEL_WRITE_HELP =
  'この画面からは変更できません。スマホから操作するには、PCの「スマホ公開」パネルで発行するQRコードから開き直してください。トンネルのパスワードが12文字未満のときも読み取り専用になります。';

// リモートからの実行可否を切り替える PUT /api/settings/agent-runs は local-only なので、
// この画面の利用者に「設定を変えてください」と案内してはいけない (403 になる)。
// 切り替えは PC のローカル画面でしか行えない、と正確に伝える。
export const REMOTE_AGENT_RUNS_DISABLED_HELP =
  'この画面（トンネル経由）からはエージェントを実行できません。PCのローカル画面で実行してください。リモートからの実行を許可したい場合も、PCのローカル画面の「設定」→「エージェント実行」から切り替える必要があります。';

export const RATE_LIMITED_HELP =
  '利用上限に達しました。しばらく時間をおいてからお試しください。';

export const CROSS_SITE_HELP =
  '別サイト経由の操作としてブロックされました。ボードのURLを直接開いてから、もう一度お試しください。';

/** fetch がネットワーク断などで失敗したときの説明(ブラウザごとの TypeError 文言を統一)。 */
export const NETWORK_FETCH_HELP =
  'サーバーに接続できませんでした。この操作は反映されていない可能性が高いです。接続を確認してからもう一度お試しください。';

/** 409: 別セッションが先に変更したときの説明。 */
export const CONFLICT_WRITE_HELP =
  '他のセッションが先に変更したため、操作できませんでした。最新の状態を確認してください。';

/**
 * 409('tunnel is not running'): トンネルが起動していないときの説明。
 * TunnelControl.tsx の accessTokenErrorMessage と共有する定数(bdboard-o2o Opus
 * レビュー should-fix)。TUNNEL_WRITE_HELP と同様、「スマホ公開」パネルを名指しして
 * 次の行動を具体的にする。
 */
export const TUNNEL_NOT_RUNNING_HELP =
  'トンネルが起動していません。「スマホ公開」パネルからトンネルを開始してください。';

/**
 * 409('chat is busy for this project'): 同一プロジェクトの別メッセージ処理中の説明。
 * ChatPanel.tsx が同じ 409 に対して表示している文言と揃えている
 * (bdboard-o2o Opus レビュー should-fix: per-project スコープが伝わる既存の方を正とする)。
 * ChatPanel.tsx 側もこの定数を import して dedupe 済み(bdboard-yzn)。
 */
export const CHAT_BUSY_HELP =
  'このプロジェクトで別のメッセージを処理中です。少し待ってから再送してください。';

/** 選択中エージェントが availability=unavailable のとき、入力欄付近に出す警告 (bdboard-nzul)。 */
export const CHAT_AGENT_UNAVAILABLE_WARNING =
  '選択中のエージェントは利用できません（CLI がインストールされていないか、認証が通っていません）。「チャット設定」で別のエージェントを選ぶか、ターミナルで CLI の認証をやり直してください。';

/**
 * チャット送信が CLI 未導入・認証切れ等で失敗したときの説明 (bdboard-nzul)。
 * サーバーは生の stderr/stdout を返さないため、利用者が取れる行動を示す。
 */
export const CHAT_AGENT_AUTH_FAILURE_HELP =
  'エージェントが応答しませんでした。CLI がインストールされていないか、認証が切れている可能性があります。ターミナルで CLI の認証状態を確認し、必要なら再ログインしてからもう一度送信してください。';

const SERVER_CHAT_AGENT_UNAVAILABLE = 'chat agent unavailable';

/**
 * チャットのエージェント失敗 (502/503) を日本語に変換する。
 * マップできない場合は null — 呼び出し側の既存フォールバックに委ねる。
 */
export function chatAgentErrorMessage(error: ApiError): string | null {
  if (
    error.status === 503 &&
    error.errorMessage === SERVER_CHAT_AGENT_UNAVAILABLE
  ) {
    return CHAT_AGENT_AUTH_FAILURE_HELP;
  }
  if (error.status === 502) {
    switch (error.code) {
      case 'agent-exit-nonzero':
      case 'agent-not-found':
        return CHAT_AGENT_AUTH_FAILURE_HELP;
      default:
        return null;
    }
  }
  return null;
}

const NETWORK_FETCH_MESSAGES = [
  'Failed to fetch',
  'Load failed',
  'NetworkError when attempting to fetch resource',
] as const;

/** ブラウザが投げるネットワーク到達不能 TypeError かどうか。 */
export function isNetworkFetchError(error: unknown): boolean {
  if (!(error instanceof TypeError)) {
    return false;
  }
  return NETWORK_FETCH_MESSAGES.some((snippet) =>
    error.message.includes(snippet),
  );
}

/**
 * 403 のうち「トンネル/CSRF の認可で弾かれた」ものと、429(利用上限)を説明文に変換する。
 * それ以外(別の 403、404、409 など)は null を返し、呼び出し側の既存の
 * エラー表示に委ねる。
 *
 * 429 を describeWriteError ではなくこちらに置いているのは、ChatPanel.tsx /
 * UndoSnackbar.tsx / dependencyEditing.ts が writeAccessErrorMessage を直接
 * 呼んでいるため(bdboard-b7n)。describeWriteError はこの関数へ委譲しているので
 * 両方の経路がカバーされる。
 */
export function writeAccessErrorMessage(error: unknown): string | null {
  // bdboard-b7n: トンネル経由チャットのレート制限は 429 で返る。
  if (error instanceof ApiError && error.status === 429) {
    return RATE_LIMITED_HELP;
  }

  if (!(error instanceof ApiError) || error.status !== 403) {
    return null;
  }

  switch (error.errorMessage) {
    case SERVER_NOT_AUTHORIZED:
    case SERVER_CHAT_NOT_AUTHORIZED:
      return TUNNEL_WRITE_HELP;
    case SERVER_CSRF_BLOCKED:
    case SERVER_CHAT_CSRF_BLOCKED:
      return CROSS_SITE_HELP;
    case SERVER_REMOTE_RUNS_DISABLED:
      return REMOTE_AGENT_RUNS_DISABLED_HELP;
    default:
      return null;
  }
}

/** 書き込み系ミューテーションのエラー表示。認可 403 / ネットワーク / 409 を日本語化する。 */
export function describeWriteError(error: unknown, fallback: string): string {
  const explained = writeAccessErrorMessage(error);
  if (explained !== null) {
    return explained;
  }
  if (isNetworkFetchError(error)) {
    return NETWORK_FETCH_HELP;
  }
  if (error instanceof ApiError && error.status === 409) {
    switch (error.errorMessage) {
      case SERVER_TUNNEL_NOT_RUNNING:
        return TUNNEL_NOT_RUNNING_HELP;
      case SERVER_CHAT_BUSY:
        return CHAT_BUSY_HELP;
      default:
        // issue-writer 系の楽観ロック競合(および未知の 409)は従来どおりここに落とす。
        return CONFLICT_WRITE_HELP;
    }
  }
  if (error instanceof ApiError && error.errorMessage !== undefined) {
    return error.errorMessage;
  }
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  return fallback;
}
