// bdboard-sso1.35: TunnelControl.tsx の「中断通知を閉じる」に関する
// mutation を、挙動を変えずにこのフックへ抽出したもの。
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { dismissTunnelInterruption, type TunnelDto } from '../../api';
import { TUNNEL_QUERY_KEY } from './tunnelHelpers';

export interface UseTunnelDismissOptions {
  onMutationError: (error: unknown) => void;
  clearActionError: () => void;
}

export function useTunnelDismiss({
  onMutationError,
  clearActionError,
}: UseTunnelDismissOptions) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: dismissTunnelInterruption,
    onSuccess: (data: TunnelDto) => {
      queryClient.setQueryData(TUNNEL_QUERY_KEY, data);
      clearActionError();
    },
    onError: onMutationError,
  });
}
