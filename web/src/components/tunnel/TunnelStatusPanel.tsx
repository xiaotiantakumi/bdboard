// bdboard-sso1.78: TunnelControl.tsx に残っていた状態表示ディスパッチ(ローカル限定
// 通知 / 取得エラー / 通常パネル)を移動しただけの表示専用コンポーネント。state・
// mutation は親 (TunnelControl / useTunnelStatus 他) に残し、値とハンドラを props
// で受け取る。JSX・className・aria属性・文言・DOM構造・分岐の順序は移動前から
// 変えていない(status.error/status.data を props 経由で受け取るための識別子名の
// 変更のみ: statusError/statusData)。
import type { ReactNode } from 'react';
import type { TunnelDto } from '../../api';
import { isLocalOnlyError } from './tunnelHelpers';
import { TunnelUnavailableNotice } from './TunnelUnavailableNotice';
import { TunnelInterruptedNotice } from './TunnelInterruptedNotice';
import { TunnelPublishForm } from './TunnelPublishForm';
import { TunnelPublishConfirmDialog } from './TunnelPublishConfirmDialog';
import { TunnelOnPanel } from './TunnelOnPanel';
import type { useTunnelPublish } from './useTunnelPublish';
import type { useTunnelQr } from './useTunnelQr';
import type { useTunnelStop } from './useTunnelStop';
import type { useTunnelDismiss } from './useTunnelDismiss';

export interface TunnelStatusPanelProps {
  localOnlyNotice: boolean;
  statusError: unknown;
  statusData: TunnelDto | undefined;
  isMutating: boolean;
  dismiss: ReturnType<typeof useTunnelDismiss>;
  publish: ReturnType<typeof useTunnelPublish>;
  qr: ReturnType<typeof useTunnelQr>;
  stop: ReturnType<typeof useTunnelStop>;
  actionError: string | null;
}

export function TunnelStatusPanel({
  localOnlyNotice,
  statusError,
  statusData,
  isMutating,
  dismiss,
  publish,
  qr,
  stop,
  actionError,
}: TunnelStatusPanelProps) {
  let panelBody: ReactNode;

  if (localOnlyNotice || (statusError !== null && isLocalOnlyError(statusError))) {
    panelBody = (
      <p className="tunnel-local-only">
        この操作はローカルの画面からのみ実行できます
      </p>
    );
  } else if (statusError !== null) {
    const message =
      statusError instanceof Error
        ? statusError.message
        : 'トンネル状態の取得に失敗しました';
    panelBody = <p className="tunnel-error-message">{message}</p>;
  } else {
    const data = statusData;
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

  return panelBody;
}
