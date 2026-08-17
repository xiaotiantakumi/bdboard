import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Fragment, useEffect, useState, type ReactNode } from 'react';
import { ApiError, fetchAiQuotaAlertConfig, fetchBoardThresholdsConfig, fetchDbStats, fetchScanRootsConfig, postRefresh, putAiQuotaAlertConfig, putBoardThresholdsConfig, putScanRootsConfig } from '../api';
import { describeWriteError } from '../writeAccessMessage';

const SAVE_FEEDBACK_MS = 2000;
const ABSOLUTE_WINDOWS_PATH = /^[A-Za-z]:[\\/]/;

/** サーバー(scan-roots-routes.ts)がこの 400 で使う error 文字列。 */
const DANGEROUS_SCAN_ROOT_ERROR = 'dangerous scan root rejected';
/**
 * details.rejected が期待した形で来なかった場合(S5)や空配列の場合(N2)のフォールバック文言。
 * 生の英語エラー文字列 (DANGEROUS_SCAN_ROOT_ERROR) をそのまま UI に出さないための保険。
 */
const DANGEROUS_SCAN_ROOT_FALLBACK_MESSAGE =
  '危険なスキャンルートが含まれているため保存できませんでした';
/** rejected を全件羅列すると長くなりすぎるため、先頭何件までを表示するか(N3/N4)。 */
const REJECTED_PATHS_DISPLAY_LIMIT = 5;
/** 保存前の軽量チェックに引っかかったスキャンルート行に出す、確定形の警告文(S4)。 */
const DANGEROUS_SCAN_ROOT_ROW_WARNING = 'このパスは保存時にサーバーに拒否されます';
/**
 * 409(楽観ロック競合)専用の文言(S2)。onError 側で setDirty(false) + refetch しており、
 * 画面上のスキャンルート/除外パス入力はサーバーの最新値に置き換わる(=編集内容は破棄される)。
 * その仕様を隠さず、何が起きたかとやり直し方をここで明示する。
 */
const CONFLICT_WRITE_MESSAGE =
  '他のセッションが先に変更したため保存できませんでした。入力内容は最新の設定で置き換えられました。内容を確認してからやり直してください。';

const INVALID_BOARD_THRESHOLDS_ERROR = 'invalid board thresholds';
const INVALID_AI_QUOTA_ALERT_THRESHOLD_ERROR = 'invalid ai quota alert threshold';

function msToHours(ms: number): string {
  return String(ms / (60 * 60 * 1000));
}

function msToMinutes(ms: number): string {
  return String(ms / (60 * 1000));
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function parseHours(value: string): number | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed <= 0) return undefined;
  return parsed * 60 * 60 * 1000;
}

function parseMinutes(value: string): number | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed <= 0) return undefined;
  return parsed * 60 * 1000;
}

function isBoardThresholdErrors(details: unknown): details is { errors: string[] } {
  if (typeof details !== 'object' || details === null || !('errors' in details)) {
    return false;
  }
  const errors = details.errors;
  return Array.isArray(errors) && errors.every((entry) => typeof entry === 'string');
}

function describeBoardThresholdWriteError(error: unknown): ReactNode {
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

function describeAiQuotaAlertWriteError(error: unknown): ReactNode {
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
function describeScanRootWriteError(error: unknown): ReactNode {
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

/**
 * 保存前の軽量な事前チェック(S1: pathHint 相乗りをやめ、リスト項目に直接紐付ける形にしたため
 * ここでは true/false の判定のみを返す)。
 *
 * これは完全な検証ではなくサーバー側(scan-root-policy.ts)の判定に委ねる。
 * ここでは明白な誤操作(FSルート丸ごと指定など)を保存前に軽く警告するだけ。
 */
function looksObviouslyDangerous(path: string): boolean {
  return path === '/' || /^[A-Za-z]:[\\/]?$/.test(path);
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || ABSOLUTE_WINDOWS_PATH.test(path);
}

export function SettingsPanel() {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ['scan-roots-config'], queryFn: fetchScanRootsConfig });
  const thresholdsQuery = useQuery({
    queryKey: ['board-thresholds-config'],
    queryFn: fetchBoardThresholdsConfig,
  });
  const aiQuotaAlertQuery = useQuery({
    queryKey: ['ai-quota-alert-config'],
    queryFn: fetchAiQuotaAlertConfig,
  });
  const dbStatsQuery = useQuery({
    queryKey: ['db-stats'],
    queryFn: fetchDbStats,
  });
  const [scanRoots, setScanRoots] = useState<string[]>([]);
  const [excludePaths, setExcludePaths] = useState<string[]>([]);
  const [version, setVersion] = useState('');
  const [newPath, setNewPath] = useState('');
  const [newExcludePath, setNewExcludePath] = useState('');
  const [feedback, setFeedback] = useState<ReactNode>('');
  const [feedbackIsError, setFeedbackIsError] = useState(false);
  const [pathHint, setPathHint] = useState('');
  const [excludePathHint, setExcludePathHint] = useState('');
  const [dirty, setDirty] = useState(false);
  const [stalledHours, setStalledHours] = useState('');
  const [activeMinutes, setActiveMinutes] = useState('');
  const [idleMinutes, setIdleMinutes] = useState('');
  const [staleHours, setStaleHours] = useState('');
  const [thresholdsVersion, setThresholdsVersion] = useState('');
  const [thresholdsFeedback, setThresholdsFeedback] = useState<ReactNode>('');
  const [thresholdsFeedbackIsError, setThresholdsFeedbackIsError] = useState(false);
  const [thresholdsDirty, setThresholdsDirty] = useState(false);
  const [aiQuotaThresholdPercent, setAiQuotaThresholdPercent] = useState('');
  const [aiQuotaAlertVersion, setAiQuotaAlertVersion] = useState('');
  const [aiQuotaAlertFeedback, setAiQuotaAlertFeedback] = useState<ReactNode>('');
  const [aiQuotaAlertFeedbackIsError, setAiQuotaAlertFeedbackIsError] = useState(false);
  const [aiQuotaAlertDirty, setAiQuotaAlertDirty] = useState(false);

  useEffect(() => {
    if (query.data !== undefined && !dirty) {
      setScanRoots(query.data.scanRoots);
      setExcludePaths(query.data.excludePaths);
      setVersion(query.data.version);
    }
  }, [dirty, query.data]);

  useEffect(() => {
    if (thresholdsQuery.data !== undefined && !thresholdsDirty) {
      setStalledHours(msToHours(thresholdsQuery.data.stalledAfterMs));
      setActiveMinutes(msToMinutes(thresholdsQuery.data.livenessActiveMs));
      setIdleMinutes(msToMinutes(thresholdsQuery.data.livenessIdleMs));
      setStaleHours(msToHours(thresholdsQuery.data.livenessStaleMs));
      setThresholdsVersion(thresholdsQuery.data.version);
    }
  }, [thresholdsDirty, thresholdsQuery.data]);

  useEffect(() => {
    if (aiQuotaAlertQuery.data !== undefined && !aiQuotaAlertDirty) {
      setAiQuotaThresholdPercent(String(aiQuotaAlertQuery.data.thresholdPercent));
      setAiQuotaAlertVersion(aiQuotaAlertQuery.data.version);
    }
  }, [aiQuotaAlertDirty, aiQuotaAlertQuery.data]);

  const saveMutation = useMutation({
    mutationFn: () =>
      putScanRootsConfig({
        scanRoots,
        excludePaths,
        version,
      }),
    onSuccess: async (data) => {
      // S3: the PUT response carries the version the server actually persisted this write as —
      // use it directly instead of waiting on the subsequent GET (invalidateQueries still runs,
      // to keep scanRoots/excludePaths in sync with the server's canonical trimmed/normalized
      // values, but the version itself doesn't need to round-trip through a refetch).
      setVersion(data.version);
      await queryClient.invalidateQueries({ queryKey: ['scan-roots-config'] });
      setDirty(false);
      try {
        await postRefresh();
      } catch (error) {
        console.warn('Failed to refresh board after saving scan roots', error);
      }
      await queryClient.invalidateQueries({ queryKey: ['projects'] });
      setFeedbackIsError(false);
      setFeedback('設定を保存しました');
      window.setTimeout(() => setFeedback(''), SAVE_FEEDBACK_MS);
    },
    onError: (error) => {
      setFeedbackIsError(true);
      setFeedback(describeScanRootWriteError(error));
      if (error instanceof ApiError && error.status === 409) {
        setDirty(false);
        void queryClient.invalidateQueries({ queryKey: ['scan-roots-config'] });
      }
    },
  });

  const saveThresholdsMutation = useMutation({
    mutationFn: () => {
      const stalledAfterMs = parseHours(stalledHours);
      const livenessActiveMs = parseMinutes(activeMinutes);
      const livenessIdleMs = parseMinutes(idleMinutes);
      const livenessStaleMs = parseHours(staleHours);
      if (
        stalledAfterMs === undefined ||
        livenessActiveMs === undefined ||
        livenessIdleMs === undefined ||
        livenessStaleMs === undefined
      ) {
        throw new Error('invalid local threshold input');
      }
      return putBoardThresholdsConfig({
        stalledAfterMs,
        livenessActiveMs,
        livenessIdleMs,
        livenessStaleMs,
        version: thresholdsVersion,
      });
    },
    onSuccess: async (data) => {
      setThresholdsVersion(data.version);
      await queryClient.invalidateQueries({ queryKey: ['board-thresholds-config'] });
      setThresholdsDirty(false);
      try {
        await postRefresh();
      } catch (error) {
        console.warn('Failed to refresh board after saving board thresholds', error);
      }
      setThresholdsFeedbackIsError(false);
      setThresholdsFeedback('閾値設定を保存しました');
      window.setTimeout(() => setThresholdsFeedback(''), SAVE_FEEDBACK_MS);
    },
    onError: (error) => {
      setThresholdsFeedbackIsError(true);
      setThresholdsFeedback(describeBoardThresholdWriteError(error));
      if (error instanceof ApiError && error.status === 409) {
        setThresholdsDirty(false);
        void queryClient.invalidateQueries({ queryKey: ['board-thresholds-config'] });
      }
    },
  });

  const saveAiQuotaAlertMutation = useMutation({
    mutationFn: () => {
      const thresholdPercent = Number(aiQuotaThresholdPercent.trim());
      if (!Number.isInteger(thresholdPercent)) {
        throw new Error('invalid local ai quota threshold input');
      }
      return putAiQuotaAlertConfig({
        thresholdPercent,
        version: aiQuotaAlertVersion,
      });
    },
    onSuccess: async (data) => {
      setAiQuotaAlertVersion(data.version);
      await queryClient.invalidateQueries({ queryKey: ['ai-quota-alert-config'] });
      setAiQuotaAlertDirty(false);
      setAiQuotaAlertFeedbackIsError(false);
      setAiQuotaAlertFeedback('AIクォータ通知閾値を保存しました');
      window.setTimeout(() => setAiQuotaAlertFeedback(''), SAVE_FEEDBACK_MS);
    },
    onError: (error) => {
      setAiQuotaAlertFeedbackIsError(true);
      setAiQuotaAlertFeedback(describeAiQuotaAlertWriteError(error));
      if (error instanceof ApiError && error.status === 409) {
        setAiQuotaAlertDirty(false);
        void queryClient.invalidateQueries({ queryKey: ['ai-quota-alert-config'] });
      }
    },
  });

  if (query.isPending || thresholdsQuery.isPending || aiQuotaAlertQuery.isPending) {
    return (
      <section className="settings-panel" aria-label="設定">
        読み込み中…
      </section>
    );
  }
  if (
    query.isError ||
    query.data === undefined ||
    thresholdsQuery.isError ||
    thresholdsQuery.data === undefined ||
    aiQuotaAlertQuery.isError ||
    aiQuotaAlertQuery.data === undefined
  ) {
    return (
      <section className="settings-panel" aria-label="設定">
        <p className="settings-panel-error">設定を読み込めませんでした</p>
      </section>
    );
  }

  const currentRoots = query.data.envOverride
    ? query.data.envScanRoots
    : query.data.scanRoots.length > 0
      ? query.data.scanRoots
      : query.data.defaultScanRoots;
  const currentLabel = query.data.envOverride
    ? '環境変数'
    : query.data.scanRoots.length > 0
      ? 'ユーザー設定'
      : 'OS既定';

  function addPath() {
    const path = newPath.trim();
    if (path.length === 0 || !isAbsolutePath(path)) {
      setPathHint(
        '絶対パスを入力してください (例: /Users/you/projects, C:\\Users\\you\\projects)',
      );
      return;
    }
    if (scanRoots.includes(path)) {
      setPathHint('既に追加されています');
      return;
    }
    setScanRoots((roots) => [...roots, path]);
    setDirty(true);
    setNewPath('');
    setPathHint('');
  }

  function removePath(path: string) {
    setScanRoots((roots) => roots.filter((root) => root !== path));
    setDirty(true);
  }

  function addExcludePath() {
    // Discovery matches `excluded` itself or the `excluded + '/'` prefix, so a trailing
    // separator would silently disable the exclusion — strip it before validating/saving.
    const path = newExcludePath.trim().replace(/[\\/]+$/, '');
    if (path.length === 0 || !isAbsolutePath(path)) {
      setExcludePathHint(
        '絶対パスを入力してください (例: /Users/you/projects, C:/Users/you/projects)',
      );
      return;
    }
    if (excludePaths.includes(path)) {
      setExcludePathHint('既に追加されています');
      return;
    }
    setExcludePaths((paths) => [...paths, path]);
    setDirty(true);
    setNewExcludePath('');
    setExcludePathHint('');
  }

  function removeExcludePath(path: string) {
    setExcludePaths((paths) => paths.filter((currentPath) => currentPath !== path));
    setDirty(true);
  }

  return (
    <section className="settings-panel" aria-label="設定">
      <div className="settings-panel-header">
        <h2 className="settings-panel-title">設定</h2>
        <p className="settings-panel-subtitle">
          プロジェクトを探索するスキャンルートと除外パスを設定します。
        </p>
      </div>
      {query.data.envOverride && (
        <div className="settings-panel-warning" role="alert">
          環境変数 BDBOARD_SCAN_ROOTS が設定されているため、この画面での設定は現在無視されています
        </div>
      )}
      <section className="settings-panel-section" aria-labelledby="effective-scan-roots-title">
        <div className="settings-panel-section-header">
          <h3 id="effective-scan-roots-title">現在有効なスキャンルート</h3>
          <span className="settings-panel-badge">{currentLabel}</span>
        </div>
        {currentRoots.length > 0 ? (
          <ul className="settings-panel-root-list">
            {currentRoots.map((path) => (
              <li key={path}>{path}</li>
            ))}
          </ul>
        ) : (
          <p className="settings-panel-empty">有効なスキャンルートがありません</p>
        )}
      </section>
      <section className="settings-panel-section" aria-labelledby="user-scan-roots-title">
        <h3 id="user-scan-roots-title">
          {query.data.envOverride ? '保存済み設定(現在は無効)' : 'ユーザー設定ルート'}
        </h3>
        {scanRoots.length > 0 ? (
          <ul className="settings-panel-edit-list settings-panel-scan-root-list">
            {scanRoots.map((path) => (
              <li key={path}>
                <div className="settings-panel-edit-row">
                  <span>{path}</span>
                  <button
                    type="button"
                    onClick={() => removePath(path)}
                    disabled={saveMutation.isPending}
                    aria-label={`スキャンルート ${path} を削除`}
                  >
                    削除
                  </button>
                </div>
                {looksObviouslyDangerous(path) && (
                  <p className="settings-panel-path-danger" role="alert">
                    {DANGEROUS_SCAN_ROOT_ROW_WARNING}
                  </p>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="settings-panel-empty">ユーザー設定ルートはありません</p>
        )}
        <form
          className="settings-panel-add-form"
          onSubmit={(event) => {
            event.preventDefault();
            addPath();
          }}
        >
          <label htmlFor="settings-scan-root-input">パスを追加</label>
          <div className="settings-panel-add-row">
            <input
              id="settings-scan-root-input"
              type="text"
              value={newPath}
              disabled={saveMutation.isPending}
              onChange={(event) => setNewPath(event.target.value)}
            />
            <button type="submit" disabled={saveMutation.isPending}>
              追加
            </button>
          </div>
          {pathHint && <p className="settings-panel-path-hint">{pathHint}</p>}
        </form>
      </section>
      <section className="settings-panel-section" aria-labelledby="exclude-paths-title">
        <h3 id="exclude-paths-title">
          {query.data.envOverride ? '除外パス(現在は無効)' : '除外パス'}
        </h3>
        <p className="settings-panel-subtitle">
          {query.data.envOverride
            ? '環境変数 BDBOARD_SCAN_ROOTS が有効なため、保存済みの除外パスは現在スキャンに適用されません。'
            : 'ここに追加した絶対パス配下のプロジェクトはスキャン時に除外されます。'}
        </p>
        {excludePaths.length > 0 ? (
          <ul className="settings-panel-edit-list">
            {excludePaths.map((path) => (
              <li key={path}>
                <span>{path}</span>
                <button
                  type="button"
                  onClick={() => removeExcludePath(path)}
                  disabled={saveMutation.isPending}
                  aria-label={`除外パス ${path} を削除`}
                >
                  削除
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="settings-panel-empty">除外パスはありません</p>
        )}
        <form
          className="settings-panel-add-form"
          onSubmit={(event) => {
            event.preventDefault();
            addExcludePath();
          }}
        >
          <label htmlFor="settings-exclude-path-input">除外パスを追加</label>
          <div className="settings-panel-add-row">
            <input
              id="settings-exclude-path-input"
              type="text"
              value={newExcludePath}
              disabled={saveMutation.isPending}
              onChange={(event) => setNewExcludePath(event.target.value)}
            />
            <button type="submit" disabled={saveMutation.isPending}>
              追加
            </button>
          </div>
          {excludePathHint && <p className="settings-panel-path-hint">{excludePathHint}</p>}
        </form>
      </section>
      <section className="settings-panel-section" aria-labelledby="board-thresholds-title">
        <h3 id="board-thresholds-title">滞留・liveness 閾値</h3>
        <p className="settings-panel-subtitle">
          チケットの滞留判定とセッションの liveness 帯域を調整します。保存後、次回のボード取得から反映されます。
        </p>
        <form
          className="settings-panel-thresholds-form"
          onSubmit={(event) => {
            event.preventDefault();
            saveThresholdsMutation.mutate();
          }}
        >
          <label htmlFor="settings-stalled-hours">滞留判定 (時間)</label>
          <input
            id="settings-stalled-hours"
            type="number"
            min={1}
            step={1}
            value={stalledHours}
            placeholder={msToHours(thresholdsQuery.data.defaults.stalledAfterMs)}
            disabled={saveThresholdsMutation.isPending}
            onChange={(event) => {
              setStalledHours(event.target.value);
              setThresholdsDirty(true);
            }}
          />
          <label htmlFor="settings-active-minutes">liveness active (分)</label>
          <input
            id="settings-active-minutes"
            type="number"
            min={1}
            step={1}
            value={activeMinutes}
            placeholder={msToMinutes(thresholdsQuery.data.defaults.livenessActiveMs)}
            disabled={saveThresholdsMutation.isPending}
            onChange={(event) => {
              setActiveMinutes(event.target.value);
              setThresholdsDirty(true);
            }}
          />
          <label htmlFor="settings-idle-minutes">liveness idle (分)</label>
          <input
            id="settings-idle-minutes"
            type="number"
            min={1}
            step={1}
            value={idleMinutes}
            placeholder={msToMinutes(thresholdsQuery.data.defaults.livenessIdleMs)}
            disabled={saveThresholdsMutation.isPending}
            onChange={(event) => {
              setIdleMinutes(event.target.value);
              setThresholdsDirty(true);
            }}
          />
          <label htmlFor="settings-stale-hours">liveness stale (時間)</label>
          <input
            id="settings-stale-hours"
            type="number"
            min={1}
            step={1}
            value={staleHours}
            placeholder={msToHours(thresholdsQuery.data.defaults.livenessStaleMs)}
            disabled={saveThresholdsMutation.isPending}
            onChange={(event) => {
              setStaleHours(event.target.value);
              setThresholdsDirty(true);
            }}
          />
          <div className="settings-panel-footer">
            <button
              type="submit"
              className="settings-panel-save"
              disabled={!thresholdsDirty || saveThresholdsMutation.isPending}
            >
              {saveThresholdsMutation.isPending ? '保存中…' : '閾値を保存'}
            </button>
            <div
              className="settings-panel-feedback"
              aria-live="polite"
              role={thresholdsFeedbackIsError ? 'alert' : undefined}
            >
              {thresholdsFeedback}
            </div>
          </div>
        </form>
      </section>
      <section className="settings-panel-section" aria-labelledby="ai-quota-alert-title">
        <h3 id="ai-quota-alert-title">AIクォータ通知閾値</h3>
        <p className="settings-panel-subtitle">
          AIクォータ残量がこの値(%)を下回ったらイベントセンターに通知します。
        </p>
        <form
          className="settings-panel-thresholds-form"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            saveAiQuotaAlertMutation.mutate();
          }}
        >
          <label htmlFor="settings-ai-quota-threshold-percent">クォータ通知閾値 (%)</label>
          <input
            id="settings-ai-quota-threshold-percent"
            type="number"
            min={1}
            max={99}
            step={1}
            value={aiQuotaThresholdPercent}
            placeholder={String(aiQuotaAlertQuery.data.defaults.thresholdPercent)}
            disabled={saveAiQuotaAlertMutation.isPending}
            onChange={(event) => {
              setAiQuotaThresholdPercent(event.target.value);
              setAiQuotaAlertDirty(true);
            }}
          />
          <div className="settings-panel-footer">
            <button
              type="submit"
              className="settings-panel-save"
              disabled={!aiQuotaAlertDirty || saveAiQuotaAlertMutation.isPending}
            >
              {saveAiQuotaAlertMutation.isPending ? '保存中…' : '閾値を保存'}
            </button>
            <div
              className="settings-panel-feedback"
              aria-live="polite"
              role={aiQuotaAlertFeedbackIsError ? 'alert' : undefined}
            >
              {aiQuotaAlertFeedback}
            </div>
          </div>
        </form>
      </section>
      <section className="settings-panel-section" aria-labelledby="db-stats-title">
        <h3 id="db-stats-title">ローカルDB統計</h3>
        <p className="settings-panel-subtitle">
          SQLiteキャッシュのファイルサイズとテーブル別件数です。CFDスナップショット等は起動時・定期処理で保持期間に応じて整理されます。
        </p>
        {dbStatsQuery.isPending ? (
          <p>読み込み中…</p>
        ) : dbStatsQuery.isError || dbStatsQuery.data === undefined ? (
          <p className="settings-panel-error">DB統計を読み込めませんでした</p>
        ) : (
          <>
            <p>DBサイズ: {formatBytes(dbStatsQuery.data.sizeBytes)}</p>
            <table className="model-stats-table">
              <thead>
                <tr>
                  <th scope="col">テーブル</th>
                  <th scope="col">件数</th>
                </tr>
              </thead>
              <tbody>
                {dbStatsQuery.data.tables.map((table) => (
                  <tr key={table.name}>
                    <td>{table.name}</td>
                    <td>{table.rowCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </section>
      <div className="settings-panel-footer">
        <button
          type="button"
          className="settings-panel-save"
          disabled={!dirty || saveMutation.isPending}
          onClick={() => saveMutation.mutate()}
        >
          {saveMutation.isPending ? '保存中…' : '保存'}
        </button>
        <p
          className="settings-panel-feedback"
          aria-live="polite"
          role={feedbackIsError ? 'alert' : undefined}
        >
          {feedback}
        </p>
      </div>
    </section>
  );
}
