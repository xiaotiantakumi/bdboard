// bdboard-sso1.35: TunnelControl.tsx の tunnelQuery (useQuery 呼び出しそのもの)
// だけを、挙動を変えずにこのフックへ抽出したもの。queryKey・retry・
// refetchInterval は移動前と同一。呼び出し位置は元の tunnelQuery と同じ
// (最初の hook 呼び出し) なので、他の hook との発火順は変わらない。
//
// TUNNEL_QUERY_KEY はこのファイルで定義してここから export する(唯一の
// 定義)。web/src/boardChangedQueryKeys.test.ts の静的スキャナが `queryKey:`
// の root を「同じファイル内のリテラル、または同じファイル内で定義した
// const」でしか解決できないため(他の web/src/components/**/use*.ts の
// queryKey もすべて同様にインラインリテラル)。setQueryData 側
// (useTunnelPublish.ts 等) はこのスキャナの対象外(パターンが `queryKey:` に
// マッチしない)なので、そちらは export されたこの定数をそのまま import して
// 使う — 2箇所に同じ文字列リテラルを重複定義して値がずれるリスクを避ける。
import { useQuery } from '@tanstack/react-query';
import { fetchTunnel } from '../../api';
import { isLocalOnlyError, POLL_INTERVAL_MS } from './tunnelHelpers';

export const TUNNEL_QUERY_KEY = ['tunnel'] as const;

export function useTunnelStatus() {
  return useQuery({
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
}
