import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../api';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { isLocalOnlyError } from './tunnel/tunnelHelpers';
import { useTunnelStatus } from './tunnel/useTunnelStatus';
import { useTunnelPublish } from './tunnel/useTunnelPublish';
import { useTunnelQr } from './tunnel/useTunnelQr';
import { useTunnelStop } from './tunnel/useTunnelStop';
import { useTunnelDismiss } from './tunnel/useTunnelDismiss';
import { TunnelStatusPanel } from './tunnel/TunnelStatusPanel';

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
    enabled: open,
    onEscape: onClose,
  });

  // bdboard-y2qx: 開いた時点で最新の状態を取り直し、止まっていれば自動生成パスワードで
  // 公開を始め、公開中ならすぐ QR を出す (メニュー/ヘッダーのボタンを押すこと自体が明示操作)。
  const [synced, setSynced] = useState(false);
  const autoStartedRef = useRef(false);
  const qrAutoRef = useRef(false);
  const { refetch } = status;
  const { startMutation } = publish;
  const { handleQrToggle } = qr;
  const startWithGeneratedPassword = publish.startWithGeneratedPassword;

  useEffect(() => {
    if (!open) {
      setSynced(false);
      autoStartedRef.current = false;
      qrAutoRef.current = false;
      return;
    }
    let cancelled = false;
    void refetch().finally(() => {
      if (!cancelled) setSynced(true);
    });
    return () => {
      cancelled = true;
    };
  }, [open, refetch]);

  const data = status.data;
  useEffect(() => {
    if (!open || !synced || localOnlyNotice || data === undefined) return;
    if (data.state !== 'on') {
      qrAutoRef.current = false;
    }
    if (
      data.state === 'off' &&
      data.available &&
      data.authEnabled === true &&
      !autoStartedRef.current &&
      !startMutation.isPending
    ) {
      autoStartedRef.current = true;
      startWithGeneratedPassword();
    } else if (data.state === 'on' && !qrAutoRef.current) {
      qrAutoRef.current = true;
      handleQrToggle();
    }
  }, [
    open,
    synced,
    localOnlyNotice,
    data,
    startMutation.isPending,
    startWithGeneratedPassword,
    handleQrToggle,
  ]);

  if (!open) {
    return null;
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
          <div className="tunnel-control header-group">
            <TunnelStatusPanel
              localOnlyNotice={localOnlyNotice}
              statusError={status.error}
              statusData={status.data}
              isMutating={isMutating}
              dismiss={dismiss}
              publish={publish}
              qr={qr}
              stop={stop}
              actionError={actionError}
            />
          </div>
        </div>
      </aside>
    </div>
  );
}
