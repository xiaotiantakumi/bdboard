// bdboard-sso1.35: TunnelControl.tsx の「公開(トンネル開始)」に関する
// state + mutation + handler 一式を、挙動を変えずにこのフックへ抽出したもの。
// useTicketQuickActions.ts (bdboard-sso1.5, PR-K) と同じ抽出パターン:
// 確認ダイアログの state・ref・mutation・handler をひとつのフックにまとめる。
//
// このフックには confirmPanelRef 用の useFocusTrap を含めていない —
// 親 (TunnelControl) には modalPanelRef 用の useFocusTrap もあり、
// enabled の一方が publishPhase に依存して互いに排他的に切り替わるため、
// 2つの useFocusTrap 呼び出しの相対順序(cleanup → setup の順)は
// フォーカス復帰の挙動に直結する(useFocusTrap.ts の previousFocusRef)。
// 安全側に倒し、両方の useFocusTrap 呼び出しは元の位置のまま親に残し、
// このフックは ref とハンドラだけを返す。TunnelControl.tsx のコメント参照。
import { useCallback, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { startTunnel, type TunnelDto } from '../../api';
import { TUNNEL_QUERY_KEY } from './tunnelHelpers';

export interface UseTunnelPublishOptions {
  onMutationError: (error: unknown) => void;
  clearActionError: () => void;
}

export function useTunnelPublish({
  onMutationError,
  clearActionError,
}: UseTunnelPublishOptions) {
  const queryClient = useQueryClient();
  const [passwordInput, setPasswordInput] = useState('');
  const [validationError, setValidationError] = useState<string | null>(null);
  const [publishPhase, setPublishPhase] = useState<'idle' | 'confirming'>(
    'idle',
  );
  const cancelPublishRef = useRef<HTMLButtonElement>(null);
  const confirmPanelRef = useRef<HTMLDivElement>(null);

  const startMutation = useMutation({
    mutationFn: (password?: string) => startTunnel(password),
    onSuccess: (data: TunnelDto) => {
      queryClient.setQueryData(TUNNEL_QUERY_KEY, data);
      setPasswordInput('');
      setValidationError(null);
      clearActionError();
      setPublishPhase('idle');
    },
    onError: onMutationError,
  });

  const handlePasswordChange = useCallback((value: string) => {
    setPasswordInput(value);
    setValidationError(null);
    setPublishPhase('idle');
  }, []);

  const handleRequestPublish = useCallback(() => {
    setValidationError(null);
    clearActionError();

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
  }, [clearActionError, passwordInput]);

  const handleConfirmPublish = useCallback(() => {
    const trimmed = passwordInput.trim();
    startMutation.mutate(trimmed.length > 0 ? trimmed : undefined);
  }, [passwordInput, startMutation]);

  const handleCancelPublish = useCallback(() => {
    setPublishPhase('idle');
  }, []);

  return {
    passwordInput,
    validationError,
    publishPhase,
    cancelPublishRef,
    confirmPanelRef,
    startMutation,
    handlePasswordChange,
    handleRequestPublish,
    handleConfirmPublish,
    handleCancelPublish,
  };
}
