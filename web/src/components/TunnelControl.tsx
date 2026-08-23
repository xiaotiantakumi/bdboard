import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import {
  ApiError,
  createTunnelAccessToken,
  dismissTunnelInterruption,
  fetchTunnel,
  startTunnel,
  stopTunnel,
  type TunnelDto,
} from '../api';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { buildTunnelTokenUrl } from '../tunnelQr';
import { TUNNEL_NOT_RUNNING_HELP } from '../writeAccessMessage';

const TUNNEL_QUERY_KEY = ['tunnel'] as const;
const POLL_INTERVAL_MS = 1200;

function isLocalOnlyError(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403;
}

function accessTokenErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 409) {
      // bdboard-o2o: writeAccessMessage.ts の定数と共有し、文言の fork を防ぐ。
      return TUNNEL_NOT_RUNNING_HELP;
    }
    if (error.status === 403) {
      return 'この操作はローカルの画面からのみ実行できます';
    }
  }
  // Deliberately generic: the server's own message is not surfaced here, so a
  // token can never reach the screen through an error path.
  return 'QRコードの準備に失敗しました';
}

export interface TunnelControlProps {
  open: boolean;
  onClose: () => void;
}

export function TunnelControl({ open, onClose }: TunnelControlProps) {
  const queryClient = useQueryClient();
  const [passwordInput, setPasswordInput] = useState('');
  // The QR encodes a one-time token, so it stays hidden until explicitly
  // requested.
  const [qrVisible, setQrVisible] = useState(false);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [localOnlyNotice, setLocalOnlyNotice] = useState(false);
  const [publishPhase, setPublishPhase] = useState<'idle' | 'confirming'>('idle');
  const cancelPublishRef = useRef<HTMLButtonElement>(null);
  const confirmPanelRef = useRef<HTMLDivElement>(null);
  const modalPanelRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  const tunnelQuery = useQuery({
    queryKey: TUNNEL_QUERY_KEY,
    queryFn: fetchTunnel,
    // A 403 here is the policy answer for a board opened through the tunnel, not
    // a transient failure. Retrying it with backoff would leave the publish
    // control live on a phone for several seconds before the notice appears.
    retry: (failureCount, error) =>
      !isLocalOnlyError(error) && failureCount < 2,
    refetchInterval: (query) => {
      const data = query.state.data;
      if (data?.state === 'starting') {
        return POLL_INTERVAL_MS;
      }
      return false;
    },
  });

  const handleMutationError = useCallback((error: unknown) => {
    if (isLocalOnlyError(error)) {
      setLocalOnlyNotice(true);
      setActionError(null);
      return;
    }
    if (error instanceof ApiError) {
      setActionError(error.errorMessage ?? error.message);
      return;
    }
    if (error instanceof Error) {
      setActionError(error.message);
      return;
    }
    setActionError('操作に失敗しました');
  }, []);

  const startMutation = useMutation({
    mutationFn: (password?: string) => startTunnel(password),
    onSuccess: (data: TunnelDto) => {
      queryClient.setQueryData(TUNNEL_QUERY_KEY, data);
      setPasswordInput('');
      setValidationError(null);
      setActionError(null);
      setPublishPhase('idle');
    },
    onError: handleMutationError,
  });

  const tokenMutation = useMutation({
    mutationFn: createTunnelAccessToken,
    onSuccess: (data) => {
      setAccessToken(data.token);
    },
    onError: () => {
      setAccessToken(null);
    },
  });

  const stopMutation = useMutation({
    mutationFn: stopTunnel,
    onSuccess: (data: TunnelDto) => {
      queryClient.setQueryData(TUNNEL_QUERY_KEY, data);
      setActionError(null);
      // Don't carry "shown" across tunnel sessions — the next tunnel has
      // different credentials and should start hidden like the first one.
      setQrVisible(false);
      setAccessToken(null);
      tokenMutation.reset();
    },
    onError: handleMutationError,
  });

  const dismissMutation = useMutation({
    mutationFn: dismissTunnelInterruption,
    onSuccess: (data: TunnelDto) => {
      queryClient.setQueryData(TUNNEL_QUERY_KEY, data);
      setActionError(null);
    },
    onError: handleMutationError,
  });

  const isMutating =
    startMutation.isPending || stopMutation.isPending || dismissMutation.isPending;

  useEffect(() => {
    if (tunnelQuery.error !== null && isLocalOnlyError(tunnelQuery.error)) {
      setLocalOnlyNotice(true);
    }
  }, [tunnelQuery.error]);

  const handleRequestPublish = useCallback(() => {
    setValidationError(null);
    setActionError(null);

    const trimmed = passwordInput.trim();
    if (trimmed.length > 0) {
      if (trimmed.length < 2 || trimmed.length > 64) {
        setValidationError(
          'パスワードは2〜64文字で入力してください（トンネルURLは公開されます）',
        );
        return;
      }
    }
    setPublishPhase('confirming');
  }, [passwordInput]);

  const handleConfirmPublish = useCallback(() => {
    const trimmed = passwordInput.trim();
    startMutation.mutate(trimmed.length > 0 ? trimmed : undefined);
  }, [passwordInput, startMutation]);

  const handleCancelPublish = useCallback(() => {
    setPublishPhase('idle');
  }, []);

  const handleQrToggle = useCallback(() => {
    if (qrVisible) {
      setQrVisible(false);
      setAccessToken(null);
      tokenMutation.reset();
      return;
    }
    setQrVisible(true);
    tokenMutation.mutate();
  }, [qrVisible, tokenMutation]);

  useFocusTrap({
    containerRef: modalPanelRef,
    initialFocusRef: closeButtonRef,
    enabled: open && publishPhase !== 'confirming',
    onEscape: onClose,
  });

  useFocusTrap({
    containerRef: confirmPanelRef,
    initialFocusRef: cancelPublishRef,
    enabled: open && publishPhase === 'confirming',
    onEscape: handleCancelPublish,
  });

  if (!open) {
    return null;
  }

  let panelBody: ReactNode;

  if (localOnlyNotice || (tunnelQuery.error !== null && isLocalOnlyError(tunnelQuery.error))) {
    panelBody = (
      <p className="tunnel-local-only">
        この操作はローカルの画面からのみ実行できます
      </p>
    );
  } else if (tunnelQuery.error !== null) {
    const message =
      tunnelQuery.error instanceof Error
        ? tunnelQuery.error.message
        : 'トンネル状態の取得に失敗しました';
    panelBody = <p className="tunnel-error-message">{message}</p>;
  } else {
    const data = tunnelQuery.data;
    const unavailable = data !== undefined && !data.available;
    const authUnavailable = data !== undefined && data.authEnabled !== true;
    // Never offer the publish control before the first response has told us whether
    // cloudflared exists and whether this board is allowed to control the tunnel.
    // The error state keeps the controls visible too, so a retry does not resend a
    // password the user can no longer see.
    const showOffControls =
      data !== undefined && (data.state === 'off' || data.state === 'error');
    const isOn = data?.state === 'on';
    const interruptedAt =
      data !== undefined && data.interruptedAt !== undefined && data.state !== 'on'
        ? data.interruptedAt
        : null;

    const startDisabled =
      unavailable ||
      authUnavailable ||
      isMutating ||
      data?.state === 'starting' ||
      isOn ||
      publishPhase === 'confirming';
    const passwordDisabled =
      unavailable ||
      authUnavailable ||
      isMutating ||
      data?.state === 'starting' ||
      isOn;
    const stopDisabled = isMutating || data?.state === 'starting' || !isOn;

    panelBody = (
      <>
      {authUnavailable && (
        <p className="tunnel-help tunnel-error-message" role="status">
          Basic Authが有効でないためトンネル公開はできません。
          BDBOARD_AUTH_USERとBDBOARD_AUTH_PASSWORDを設定してください。
        </p>
      )}

      {interruptedAt !== null && (
        <div className="tunnel-interrupted-notice" role="status">
          <p className="tunnel-help">
            前回はトンネルが動作中のままサーバーが停止しました。
          </p>
          <p className="tunnel-help">
            公開していた URL は失効しています（cloudflared の URL
            は毎回変わるため、スマホ側は再読み込みでは復旧しません）。
          </p>
          <p className="tunnel-help">
            もう一度スマホから使うには、下のパスワード欄から公開し直して QR
            を取り直してください。
          </p>
          <p className="tunnel-help">
            停止時刻:{' '}
            <time dateTime={interruptedAt}>
              {new Date(interruptedAt).toLocaleString()}
            </time>
          </p>
          <button
            type="button"
            className="btn btn-small"
            onClick={() => dismissMutation.mutate()}
            disabled={dismissMutation.isPending}
          >
            閉じる
          </button>
        </div>
      )}

      {unavailable && (
        <>
          <p className="tunnel-help">
            cloudflared が見つかりません。ローカルにインストールしてください。
          </p>
          <button
            type="button"
            className="btn"
            disabled
            title="cloudflared が見つかりません"
          >
            スマホ用に公開
          </button>
        </>
      )}

      {!unavailable && showOffControls && (
        <>
          <div className="tunnel-off-row">
            <input
              type="password"
              className="tunnel-input"
              value={passwordInput}
              onChange={(event) => {
                setPasswordInput(event.target.value);
                setValidationError(null);
                setPublishPhase('idle');
              }}
              placeholder="未入力ならランダム生成"
              disabled={passwordDisabled}
              aria-label="トンネル用パスワード（任意）"
              aria-describedby="tunnel-password-write-hint"
            />
            <button
              type="button"
              className="btn"
              onClick={handleRequestPublish}
              disabled={startDisabled}
              title={
                authUnavailable
                  ? 'Basic Authが有効でないためトンネル公開はできません'
                  : undefined
              }
            >
              {startMutation.isPending ? '送信中…' : 'スマホ用に公開'}
            </button>
          </div>

          {/* bdboard-cu4: 公開してからでは遅い情報なので、公開前に出す。
              12文字未満のパスワードで公開したトンネルは読み取り専用になる。 */}
          <p id="tunnel-password-write-hint" className="tunnel-help">
            パスワードが12文字未満だと、スマホからは読み取り専用になります（空欄=自動生成なら変更もできます）。
          </p>

          {publishPhase === 'confirming' && (
            <div
              ref={confirmPanelRef}
              className="tunnel-confirm-panel"
              role="alertdialog"
              aria-labelledby="tunnel-confirm-title"
              aria-describedby="tunnel-confirm-desc"
            >
              <p id="tunnel-confirm-title" className="tunnel-confirm-title">
                公開の確認
              </p>
              <div id="tunnel-confirm-desc" className="tunnel-confirm-desc">
                <p>
                  公開すると、全プロジェクトのチケット内容がインターネットから読める状態になります。
                </p>
                <p>
                  公開先には Basic 認証が掛かります。スマホはこの画面で発行する1回限りのQRコードから認証済みセッションを開始します。
                </p>
                <p>
                  パスワードを空欄のまま公開した場合は、安全なランダムパスワードが自動生成されます。スマホでは公開後のQRコードから開きます。
                </p>
                <p>「キャンセル」を選べば、何も起きずに元の画面に戻れます。</p>
              </div>
              <div className="tunnel-confirm-actions">
                <button
                  ref={cancelPublishRef}
                  type="button"
                  className="btn tunnel-confirm-cancel"
                  onClick={handleCancelPublish}
                  disabled={startMutation.isPending}
                >
                  キャンセル
                </button>
                <button
                  type="button"
                  className="btn btn-danger-outline"
                  onClick={handleConfirmPublish}
                  disabled={startMutation.isPending}
                >
                  {startMutation.isPending ? '送信中…' : '公開する'}
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {data?.state === 'starting' && (
        <button type="button" className="btn" disabled>
          起動中…
        </button>
      )}

      {data?.state === 'on' && (
        <div className="tunnel-on-panel">
          {/* bdboard-cu4: スマホ側で「書き込めない理由」が分からず 403 トーストだけが
              出る状態だったので、公開中のトンネルが読み書きできるのかをここに出す。
              サーバーは state==='on' のとき必ず writeAccess を返す(bdboard-9rz)。
              未定義になるのは古いサーバーと話しているときだけなので、その場合は
              断定せずに何も出さない。 */}
          {data.writeAccess !== undefined && (
            <div className="tunnel-field">
              <span className="tunnel-field-label">スマホからの操作</span>
              {data.writeAccess ? (
                <p className="tunnel-write-access tunnel-write-access-on">
                  変更もできます。公開後のQRコードからスマホで開いてください。
                </p>
              ) : (
                <p className="tunnel-write-access tunnel-write-access-off">
                  読み取り専用です。パスワードが12文字未満のためチケットの変更・コメント・チャットはできません。変更もしたい場合は、いったん公開を停止して、パスワード欄を空欄（自動生成）にするか12文字以上のパスワードで公開し直してください。
                </p>
              )}
            </div>
          )}
          <div className="tunnel-field">
            <span className="tunnel-field-label">スマホで開く</span>
            <div className="tunnel-field-row">
              <button
                type="button"
                className="btn btn-small"
                onClick={handleQrToggle}
                aria-expanded={qrVisible}
              >
                {qrVisible ? 'QRを隠す' : 'QRを表示'}
              </button>
              <span className="tunnel-qr-hint">
                カメラで読むとログイン済みの状態で開けます（変更操作もこの入口からのみ）
              </span>
            </div>
            {qrVisible && (
              <div className="tunnel-qr">
                {tokenMutation.isPending && (
                  <p className="tunnel-qr-status">準備中…</p>
                )}
                {tokenMutation.isError && (
                  <p className="tunnel-error-message">
                    {accessTokenErrorMessage(tokenMutation.error)}
                  </p>
                )}
                {accessToken !== null && data.state === 'on' && (
                  <>
                    <QRCodeSVG
                      value={buildTunnelTokenUrl(data.url, accessToken)}
                      size={192}
                      level="M"
                      marginSize={2}
                      title="トンネルURL(ワンタイムトークンつき)のQRコード"
                    />
                    <p className="tunnel-qr-note">
                      1回だけ使える入場用コードです。有効期限は約5分。
                    </p>
                  </>
                )}
              </div>
            )}
          </div>
          <button
            type="button"
            className="btn"
            onClick={() => stopMutation.mutate()}
            disabled={stopDisabled}
          >
            {stopMutation.isPending ? '停止中…' : '公開を停止'}
          </button>
        </div>
      )}

      {data?.state === 'error' && (
        <div className="tunnel-error-panel">
          {/* Message only: the off-row above already renders the password field
              and the publish button, so retrying here would be a second button
              that submits a password the user cannot see. */}
          <p className="tunnel-error-message">{data.message}</p>
        </div>
      )}

      {validationError !== null && (
        <p className="tunnel-error-message">{validationError}</p>
      )}

      {actionError !== null && (
        <p className="tunnel-error-message">{actionError}</p>
      )}
      </>
    );
  }

  return (
    <div
      className="overlay tunnel-modal-overlay"
      onClick={onClose}
      role="presentation"
    >
      <aside
        ref={modalPanelRef}
        className="tunnel-modal-panel"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="tunnel-modal-title"
        tabIndex={-1}
      >
        <div className="detail-header">
          <h2 id="tunnel-modal-title" className="detail-title">
            スマホ公開
          </h2>
          <button
            ref={closeButtonRef}
            type="button"
            className="btn detail-close"
            onClick={onClose}
          >
            閉じる
          </button>
        </div>

        <div className="tunnel-modal-body">
          <div className="tunnel-control header-group">{panelBody}</div>
        </div>
      </aside>
    </div>
  );
}
