// bdboard-sso1.35: TunnelControl.tsx の「停止」に関する mutation 一式を、
// 挙動を変えずにこのフックへ抽出したもの。停止成功時に QR
// state をリセットする必要があるため(元の stopMutation.onSuccess の挙動を
// そのまま維持)、useTunnelQr が返す resetForStop() を受け取って呼ぶ。
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { stopTunnel, type TunnelDto } from '../../api';
import { TUNNEL_QUERY_KEY } from './tunnelHelpers';

export interface UseTunnelStopOptions {
  onMutationError: (error: unknown) => void;
  clearActionError: () => void;
  resetQr: () => void;
}

export function useTunnelStop({
  onMutationError,
  clearActionError,
  resetQr,
}: UseTunnelStopOptions) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: stopTunnel,
    onSuccess: (data: TunnelDto) => {
      queryClient.setQueryData(TUNNEL_QUERY_KEY, data);
      clearActionError();
      resetQr();
    },
    onError: onMutationError,
  });
}
