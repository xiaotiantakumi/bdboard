// bdboard-sso1.35: 公開(トンネル開始)の state + mutation + handler。
// bdboard-y2qx: 確認ダイアログを廃止した (メニュー/ヘッダーのボタンを押すこと自体が明示操作)。
import { useCallback, useState } from 'react';
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

  const startMutation = useMutation({
    mutationFn: (password?: string) => startTunnel(password),
    onSuccess: (data: TunnelDto) => {
      queryClient.setQueryData(TUNNEL_QUERY_KEY, data);
      setPasswordInput('');
      setValidationError(null);
      clearActionError();
    },
    onError: onMutationError,
  });

  const handlePasswordChange = useCallback((value: string) => {
    setPasswordInput(value);
    setValidationError(null);
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
    startMutation.mutate(trimmed.length > 0 ? trimmed : undefined);
  }, [clearActionError, passwordInput, startMutation]);

  // bdboard-y2qx: ダイアログを開いた時点で、自動生成パスワードで公開を始める。
  const startWithGeneratedPassword = useCallback(() => {
    clearActionError();
    startMutation.mutate(undefined);
  }, [clearActionError, startMutation]);

  return {
    passwordInput,
    validationError,
    startMutation,
    handlePasswordChange,
    handleRequestPublish,
    startWithGeneratedPassword,
  };
}
