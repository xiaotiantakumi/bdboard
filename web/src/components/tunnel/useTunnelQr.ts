// bdboard-sso1.35: TunnelControl.tsx の「QR表示」に関する state + mutation +
// handler 一式を、挙動を変えずにこのフックへ抽出したもの。他の関心
// (公開/停止)への依存を持たない自己完結フック — ただし停止(useTunnelStop)
// 側は QR を新しいトンネルセッションへ引き継がせないために resetForStop()
// を呼ぶ(元の stopMutation.onSuccess がここと同じ3行を直接呼んでいたのと同じ)。
import { useCallback, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { createTunnelAccessToken } from '../../api';

export function useTunnelQr() {
  const [qrVisible, setQrVisible] = useState(false);
  const [accessToken, setAccessToken] = useState<string | null>(null);

  const tokenMutation = useMutation({
    mutationFn: createTunnelAccessToken,
    onSuccess: (data) => {
      setAccessToken(data.token);
    },
    onError: () => {
      setAccessToken(null);
    },
  });

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

  // Don't carry "shown" across tunnel sessions — the next tunnel has
  // different credentials and should start hidden like the first one.
  const resetForStop = useCallback(() => {
    setQrVisible(false);
    setAccessToken(null);
    tokenMutation.reset();
  }, [tokenMutation]);

  return {
    qrVisible,
    accessToken,
    tokenMutation,
    handleQrToggle,
    resetForStop,
  };
}
