import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ApiError } from '../api';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { isLocalOnlyError } from './tunnel/tunnelHelpers';
import { useTunnelStatus } from './tunnel/useTunnelStatus';
import { useTunnelPublish } from './tunnel/useTunnelPublish';
import { useTunnelQr } from './tunnel/useTunnelQr';
import { useTunnelStop } from './tunnel/useTunnelStop';
import { useTunnelDismiss } from './tunnel/useTunnelDismiss';
import { TunnelUnavailableNotice } from './tunnel/TunnelUnavailableNotice';
import { TunnelInterruptedNotice } from './tunnel/TunnelInterruptedNotice';
import { TunnelPublishForm } from './tunnel/TunnelPublishForm';
import { TunnelPublishConfirmDialog } from './tunnel/TunnelPublishConfirmDialog';
import { TunnelOnPanel } from './tunnel/TunnelOnPanel';

export interface TunnelControlProps {
  open: boolean;
  onClose: () => void;
}

export function TunnelControl({ open, onClose }: TunnelControlProps) {
  const [actionError, setActionError] = useState<string | null>(null);
  const [localOnlyNotice, setLocalOnlyNotice] = useState(false);
  const modalPanelRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  const status = useTunnelStatus();

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

  const clearActionError = useCallback(() => setActionError(null), []);

  const publish = useTunnelPublish({
    onMutationError: handleMutationError,
    clearActionError,
  });

  const qr = useTunnelQr();

  const stop = useTunnelStop({
    onMutationError: handleMutationError,
    clearActionError,
    resetQr: qr.reset,
  });

  const dismiss = useTunnelDismiss({
    onMutationError: handleMutationError,
    clearActionError,
  });

  const isMutating =
    publish.startMutation.isPending || stop.isPending || dismiss.isPending;

  useEffect(() => {
    if (status.error !== null && isLocalOnlyError(status.error)) {
      setLocalOnlyNotice(true);
    }
  }, [status.error]);

  useFocusTrap({
    containerRef: modalPanelRef,
    initialFocusRef: closeButtonRef,
    enabled: open && publish.publishPhase !== 'confirming',
    onEscape: onClose,
  });

  useFocusTrap({
    containerRef: publish.confirmPanelRef,
    initialFocusRef: publish.cancelPublishRef,
    enabled: open && publish.publishPhase === 'confirming',
    onEscape: publish.handleCancelPublish,
  });

  if (!open) {
    return null;
  }

  let panelBody: ReactNode;

  if (localOnlyNotice || (status.error !== null && isLocalOnlyError(status.error))) {
    panelBody = (
      <p className="tunnel-local-only">
        この操作はローカルの画面からのみ実行できます
      </p>
    );
  } else if (status.error !== null) {
    const message =
      status.error instanceof Error
        ? status.error.message
        : 'トンネル状態の取得に失敗しました';
    panelBody = <p className="tunnel-error-message">{message}</p>;
  } else {
    const data = status.data;
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
      publish.publishPhase === 'confirming';
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
        <TunnelInterruptedNotice
          interruptedAt={interruptedAt}
          onDismiss={() => dismiss.mutate()}
          dismissPending={dismiss.isPending}
        />
      )}

      {unavailable && <TunnelUnavailableNotice />}

      {!unavailable && showOffControls && (
        <>
          <TunnelPublishForm
            passwordInput={publish.passwordInput}
            onPasswordChange={publish.handlePasswordChange}
            passwordDisabled={passwordDisabled}
            startDisabled={startDisabled}
            authUnavailable={authUnavailable}
            onRequestPublish={publish.handleRequestPublish}
            startPending={publish.startMutation.isPending}
          />

          {publish.publishPhase === 'confirming' && (
            <TunnelPublishConfirmDialog
              confirmPanelRef={publish.confirmPanelRef}
              cancelPublishRef={publish.cancelPublishRef}
              startPending={publish.startMutation.isPending}
              onCancel={publish.handleCancelPublish}
              onConfirm={publish.handleConfirmPublish}
            />
          )}
        </>
      )}

      {data?.state === 'starting' && (
        <button type="button" className="btn" disabled>
          起動中…
        </button>
      )}

      {data?.state === 'on' && (
        <TunnelOnPanel
          writeAccess={data.writeAccess}
          qrVisible={qr.qrVisible}
          onQrToggle={qr.handleQrToggle}
          tokenPending={qr.tokenMutation.isPending}
          tokenIsError={qr.tokenMutation.isError}
          tokenError={qr.tokenMutation.error}
          tunnelUrl={data.url}
          accessToken={qr.accessToken}
          onStop={() => stop.mutate()}
          stopDisabled={stopDisabled}
          stopPending={stop.isPending}
        />
      )}

      {data?.state === 'error' && (
        <div className="tunnel-error-panel">
          {/* Message only: the off-row above already renders the password field
              and the publish button, so retrying here would be a second button
              that submits a password the user cannot see. */}
          <p className="tunnel-error-message">{data.message}</p>
        </div>
      )}

      {publish.validationError !== null && (
        <p className="tunnel-error-message">{publish.validationError}</p>
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
