import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Fragment, useEffect, useState, type ReactNode } from 'react';
import { ApiError, fetchScanRootsConfig, postRefresh, putScanRootsConfig } from '../api';
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

  useEffect(() => {
    if (query.data !== undefined && !dirty) {
      setScanRoots(query.data.scanRoots);
      setExcludePaths(query.data.excludePaths);
      setVersion(query.data.version);
    }
  }, [dirty, query.data]);

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

  if (query.isPending) {
    return (
      <section className="settings-panel" aria-label="設定">
        読み込み中…
      </section>
    );
  }
  if (query.isError || query.data === undefined) {
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
