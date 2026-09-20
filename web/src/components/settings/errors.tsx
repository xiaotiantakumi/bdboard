// bdboard-sso1.10 (PR-A): SettingsPanel.tsx から保存失敗時のエラー文言組み立て
// ヘルパーと関連定数を移動しただけのファイル。挙動は一切変えていない。
import { Fragment, type ReactNode } from 'react';
import { ApiError } from '../../api';
import { describeWriteError } from '../../writeAccessMessage';

/** サーバー(scan-roots-routes.ts)がこの 400 で使う error 文字列。 */
export const DANGEROUS_SCAN_ROOT_ERROR = 'dangerous scan root rejected';
/**
 * details.rejected が期待した形で来なかった場合(S5)や空配列の場合(N2)のフォールバック文言。
 * 生の英語エラー文字列 (DANGEROUS_SCAN_ROOT_ERROR) をそのまま UI に出さないための保険。
 */
export const DANGEROUS_SCAN_ROOT_FALLBACK_MESSAGE =
  '危険なスキャンルートが含まれているため保存できませんでした';
/** rejected を全件羅列すると長くなりすぎるため、先頭何件までを表示するか(N3/N4)。 */
export const REJECTED_PATHS_DISPLAY_LIMIT = 5;
/** 保存前の軽量チェックに引っかかったスキャンルート行に出す、確定形の警告文(S4)。 */
export const DANGEROUS_SCAN_ROOT_ROW_WARNING = 'このパスは保存時にサーバーに拒否されます';
/**
 * 409(楽観ロック競合)専用の文言(S2)。onError 側で setDirty(false) + refetch しており、
 * 画面上のスキャンルート/除外パス入力はサーバーの最新値に置き換わる(=編集内容は破棄される)。
 * その仕様を隠さず、何が起きたかとやり直し方をここで明示する。
 */
export const CONFLICT_WRITE_MESSAGE =
  '他のセッションが先に変更したため保存できませんでした。入力内容は最新の設定で置き換えられました。内容を確認してからやり直してください。';

export const INVALID_BOARD_THRESHOLDS_ERROR = 'invalid board thresholds';
export const INVALID_HYGIENE_THRESHOLDS_ERROR = 'invalid hygiene thresholds';
export const INVALID_AI_QUOTA_ALERT_THRESHOLD_ERROR = 'invalid ai quota alert threshold';

function isBoardThresholdErrors(details: unknown): details is { errors: string[] } {
  if (typeof details !== 'object' || details === null || !('errors' in details)) {
    return false;
  }
  const errors = details.errors;
  return Array.isArray(errors) && errors.every((entry) => typeof entry === 'string');
}

export function describeBoardThresholdWriteError(error: unknown): ReactNode {
  if (
    error instanceof ApiError &&
    error.status === 400 &&
    error.errorMessage === INVALID_BOARD_THRESHOLDS_ERROR &&
    isBoardThresholdErrors(error.details)
  ) {
    return (
      <ul className="settings-panel-error-list">
        {error.details.errors.map((message) => (
          <li key={message}>{message}</li>
        ))}
      </ul>
    );
  }
  if (error instanceof ApiError && error.status === 409) {
    return CONFLICT_WRITE_MESSAGE;
  }
  return describeWriteError(error, '閾値設定を保存できませんでした');
}

export function describeHygieneThresholdWriteError(error: unknown): ReactNode {
  if (
    error instanceof ApiError &&
    error.status === 400 &&
    error.errorMessage === INVALID_HYGIENE_THRESHOLDS_ERROR &&
    isBoardThresholdErrors(error.details)
  ) {
    return (
      <ul className="settings-panel-error-list">
        {error.details.errors.map((message) => (
          <li key={message}>{message}</li>
        ))}
      </ul>
    );
  }
  if (error instanceof ApiError && error.status === 409) {
    return CONFLICT_WRITE_MESSAGE;
  }
  return describeWriteError(error, '健全性閾値を保存できませんでした');
}

export function describeAiQuotaAlertWriteError(error: unknown): ReactNode {
  if (
    error instanceof ApiError &&
    error.status === 400 &&
    error.errorMessage === INVALID_AI_QUOTA_ALERT_THRESHOLD_ERROR &&
    isBoardThresholdErrors(error.details)
  ) {
    return (
      <ul className="settings-panel-error-list">
        {error.details.errors.map((message) => (
          <li key={message}>{message}</li>
        ))}
      </ul>
    );
  }
  if (error instanceof ApiError && error.status === 409) {
    return CONFLICT_WRITE_MESSAGE;
  }
  return describeWriteError(error, 'AIクォータ通知閾値を保存できませんでした');
}

export function describeAgentRunWriteError(error: unknown): ReactNode {
  if (error instanceof ApiError && error.status === 409) {
    return CONFLICT_WRITE_MESSAGE;
  }
  return describeWriteError(error, 'エージェント実行設定を保存できませんでした');
}

function isRejectedScanRootDetails(
  details: unknown,
): details is { rejected: string[] } {
  if (typeof details !== 'object' || details === null || !('rejected' in details)) {
    return false;
  }
  const rejected = details.rejected;
  return Array.isArray(rejected) && rejected.every((path) => typeof path === 'string');
}

/**
 * details.rejected を先頭 REJECTED_PATHS_DISPLAY_LIMIT 件まで、1 パス 1 `<code>` 要素として
 * 表示するメッセージを組み立てる(N3/N4: 区切りをカンマ文字列でなく要素境界で明示する)。
 * 空配列は呼び出し側(describeScanRootWriteError)でフォールバック文言に落とすため、ここには来ない。
 */
function buildRejectedScanRootsMessage(rejected: readonly string[]): ReactNode {
  const shown = rejected.slice(0, REJECTED_PATHS_DISPLAY_LIMIT);
  const remaining = rejected.length - shown.length;
  return (
    <>
      危険なスキャンルートのため拒否されました:{' '}
      {shown.map((path, index) => (
        <Fragment key={path}>
          {index > 0 && ', '}
          <code>{path}</code>
        </Fragment>
      ))}
      {remaining > 0 && `、他 ${remaining} 件`}
    </>
  );
}

/**
 * 保存失敗時のフィードバック文言(S5: 2段フォールバック)。
 * 1. 400 dangerous scan root rejected かつ details.rejected が非空配列 → 拒否パス一覧を表示
 * 2. 400 dangerous scan root rejected だが details が想定形でない/空配列(N2) → 定型フォールバック
 * 3. 409(楽観ロック競合) → 入力内容が破棄されることまで伝える専用文言(S2)
 * 4. それ以外 → 既存の describeWriteError() に委ねる
 */
export function describeScanRootWriteError(error: unknown): ReactNode {
  if (
    error instanceof ApiError &&
    error.status === 400 &&
    error.errorMessage === DANGEROUS_SCAN_ROOT_ERROR
  ) {
    if (isRejectedScanRootDetails(error.details) && error.details.rejected.length > 0) {
      return buildRejectedScanRootsMessage(error.details.rejected);
    }
    return DANGEROUS_SCAN_ROOT_FALLBACK_MESSAGE;
  }
  if (error instanceof ApiError && error.status === 409) {
    return CONFLICT_WRITE_MESSAGE;
  }
  return describeWriteError(error, '設定を保存できませんでした');
}
