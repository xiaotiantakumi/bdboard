// bdboard-sso1.35: TunnelControl.tsx の「公開(トンネル開始)」に関する
// state + mutation + handler 一式を、挙動を変えずにこのフックへ抽出したもの。
// useTicketQuickActions.ts (bdboard-sso1.5, PR-K) と同じ抽出パターン:
// 確認ダイアログの state・ref・mutation・handler をひとつのフックにまとめる。
//
// このフックには confirmPanelRef 用の useFocusTrap を含めていない —
// 親 (TunnelControl) には modalPanelRef 用の useFocusTrap もあり、enabled は
// 互いに publishPhase に依存して排他的に切り替わる。React はコミットの
// cleanup を全て走らせてから setup を全て走らせるので、両者の呼び出し順
// 自体は(こちらが先でも後でも)フォーカス復帰の連鎖に影響しない —
// ただし連鎖自体(一方の cleanup が previousFocusRef へ戻す→他方の setup が
// その時点の activeElement を自分の previousFocusRef として捕まえる、
// useFocusTrap.ts 参照)は実際の挙動であり、2つの呼び出しを別ファイルへ
// 分割して片方だけ先に評価されるような形(例: 早期 return を挟む)にしない
// 限り安全に保たれる。安全側に倒し、両方の useFocusTrap 呼び出しは元の
// 位置のまま親に残し、このフックは ref とハンドラだけを返す。
import { useCallback, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { startTunnel, type TunnelDto } from '../../api';
import { TUNNEL_QUERY_KEY } from './useTunnelStatus';

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
