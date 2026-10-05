import { ApiError } from '../../api';
import { NETWORK_FETCH_HELP, isNetworkFetchError, writeAccessErrorMessage } from '../../writeAccessMessage';
import { draftStatusLabel } from './issueDraftText';

/**
 * 不具合報告の編集・見送りの失敗を、利用者に分かる言葉にする (bdboard-4y8q.3.2)。
 * 文字列はサーバー (src/interface/http/issue-report-edit-routes.ts / issue-report-routes.ts) の応答と対になっている。
 * web/ から src/ は import できないので、`code` の値は意図的に二重定義する。
 */

/** 題名・本文の文字数の上限 (サーバーの ISSUE_DRAFT_TITLE_MAX_CHARS / ISSUE_DRAFT_BODY_MAX_CHARS と同じ値)。 */
export const ISSUE_DRAFT_TITLE_MAX_CHARS = 256;
export const ISSUE_DRAFT_BODY_MAX_CHARS = 65_536;
/** 説明の文字数上限 (サーバーの ISSUE_DRAFT_FREE_TEXT_MAX_CHARS と同じ値)。 */
export const ISSUE_DRAFT_MANUAL_DESCRIPTION_MAX_CHARS = 8_000;
/** 見送りの理由の上限 (サーバーの ISSUE_DRAFT_DISMISS_REASON_MAX_CHARS と同じ値)。 */
export const ISSUE_DRAFT_DISMISS_REASON_MAX_CHARS = 200;

const CODE_TOO_LONG = 'too-long';
const CODE_DRAFT_TOO_LARGE = 'draft-too-large';
export const CODE_MANUAL_RATE_LIMITED = 'manual-rate-limited';

export const DRAFT_NOT_FOUND_HELP = 'この下書きは見つかりませんでした。一覧を読み直してください。';
export const STORAGE_FULL_HELP =
  '不具合報告の保存場所が容量の上限に達しているため、保存できませんでした。見送り・投稿済みの古い下書きが期限で片付くまで待つか、PC で保存場所の容量を確かめてください。';
export const DRAFT_TOO_LARGE_HELP =
  '下書き全体が保存できる大きさを超えます (手元のエラー本文を詰めても収まりませんでした)。本文を短くしてから保存してください。';
export const REQUEST_TOO_LARGE_HELP = '送った内容が大きすぎます。本文を短くしてから保存してください。';
export const MANUAL_RATE_LIMITED_HELP = '手で書く報告は、1 時間あたりの上限 (20 件) に達しました。しばらく時間をおいてから、もう一度送ってください。入力はそのまま残しています。';
export const MANUAL_LOCAL_ONLY_HELP = 'ローカルで開いたときだけ書けます。PC のブラウザで localhost のボードを開いてから、もう一度お試しください (スマホやトンネル経由では、書き込みを許可していても書けません)。';
export const MANUAL_REQUEST_TOO_LARGE_HELP = '送った内容が大きすぎます。説明を短くしてから、もう一度送ってください。';
export const MANUAL_BAD_REQUEST_HELP = '題名は 1 行で、改行・タブなどの制御文字や見えない書式文字を含めないでください。題名と説明には、それぞれ見える文字が必要です。';
/**
 * 412 (bdboard-mqoa・bdboard-q5pj): 読んだあとに、ほかの画面・端末で題名・本文 (直した文と「直した」印) が変わっていた (新しい発生・画像・pack の版の変化では出ない)。画面は最新を読み直し (入力は残す)、
 * 利用者には内容を確かめてからやり直してもらう。保存と「自動の文に戻す」の両方で出す。
 */
export const DRAFT_CHANGED_ELSEWHERE_HELP =
  'この下書きは、ほかの場所で変更されました。最新の内容を読み込み直しました。入力はそのまま残しています。内容を確かめてから、もう一度やり直してください。';
/** 保存の上限に収めるため手元のエラー本文の末尾を詰めたときの説明 (保存と、自動の文へ戻す操作の両方で出す)。 */
export const ERROR_TEXT_TRIMMED_NOTE = '保存の上限に収めるため、手元のエラー本文の末尾を詰めました (投稿される内容は変わりません)。';

function parsedBody(error: ApiError): Record<string, unknown> {
  if (error.body === undefined) return {};
  try {
    const value: unknown = JSON.parse(error.body);
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function notPendingMessage(error: ApiError): string {
  const status = parsedBody(error).status;
  const statusText = typeof status === 'string' ? ` (今の状態: ${draftStatusLabel(status)})` : '';
  return `この下書きはもう未処理ではないため、変更できません${statusText}。一覧を読み直してください。`;
}

function tooLongMessage(error: ApiError): string {
  const body = parsedBody(error);
  const maxTitle = numberOr(body.maxTitleChars, ISSUE_DRAFT_TITLE_MAX_CHARS);
  const maxBody = numberOr(body.maxBodyChars, ISSUE_DRAFT_BODY_MAX_CHARS);
  return `長すぎて保存できません。題名は ${maxTitle} 文字、本文は ${maxBody} 文字までです。`;
}

/** 403・通信の失敗など、編集と見送りに共通の説明。当てはまらなければ null。 */
function commonMessage(error: unknown): string | null {
  const access = writeAccessErrorMessage(error);
  if (access !== null) return access;
  if (isNetworkFetchError(error)) return NETWORK_FETCH_HELP;
  if (!(error instanceof ApiError)) return null;
  if (error.status === 404) return DRAFT_NOT_FOUND_HELP;
  if (error.status === 409) return notPendingMessage(error);
  if (error.status === 507) return STORAGE_FULL_HELP;
  return null;
}

/** PATCH drafts/:id (題名・本文の編集) の失敗。 */
export function describeIssueDraftEditError(error: unknown): string {
  const common = commonMessage(error);
  if (common !== null) return common;
  if (error instanceof ApiError) {
    if (error.status === 412) return DRAFT_CHANGED_ELSEWHERE_HELP;
    if (error.status === 413) {
      if (error.code === CODE_TOO_LONG) return tooLongMessage(error);
      if (error.code === CODE_DRAFT_TOO_LARGE) return DRAFT_TOO_LARGE_HELP;
      return REQUEST_TOO_LARGE_HELP;
    }
    // 見える文字が無い題名は 400 ではなく自動生成へ戻る (bdboard-ov0t)。400 は、改行・制御文字・見えない書式文字を含む題名のとき。
    if (error.status === 400) return '題名は 1 行で、改行・タブなどの制御文字や見えない書式文字を含めないでください。';
    return `保存できませんでした (HTTP ${error.status})。`;
  }
  return '保存できませんでした。';
}

/** PATCH drafts/:id/dismiss (見送り) の失敗。 */
export function describeIssueDraftDismissError(error: unknown): string {
  const common = commonMessage(error);
  if (common !== null) return common;
  if (error instanceof ApiError) {
    if (error.status === 400) {
      return `理由は 1 行で、見える文字を含めて ${ISSUE_DRAFT_DISMISS_REASON_MAX_CHARS} 文字以内にしてください。`;
    }
    if (error.status === 413) return '理由が長すぎます。';
    return `見送りにできませんでした (HTTP ${error.status})。`;
  }
  return '見送りにできませんでした。';
}

/** 手書き下書きの POST の失敗。 */
export function describeIssueDraftManualError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 429 && error.code === CODE_MANUAL_RATE_LIMITED) return MANUAL_RATE_LIMITED_HELP;
    if (error.status === 403 && error.errorMessage === 'local access only') return MANUAL_LOCAL_ONLY_HELP;
  }
  const common = commonMessage(error);
  if (common !== null) return common;
  if (error instanceof ApiError) {
    if (error.status === 413) return MANUAL_REQUEST_TOO_LARGE_HELP;
    if (error.status === 400) return MANUAL_BAD_REQUEST_HELP;
    return `作れませんでした (HTTP ${error.status})。`;
  }
  return '作れませんでした。';
}
