import { useQuery } from '@tanstack/react-query';
import { fetchUpdateCheck } from '../api';

/**
 * 新しいリリースがあるときだけ、控えめに知らせる (bdboard-70z.7)。
 *
 * 最新版のとき・確認できなかったとき・確認が無効化されているときは何も描かない。
 * 「最新です」を出す価値より、常時ノイズを出さないことを優先している。
 * 取得失敗も同様に無言 — ローカル完結のツールが外部サービスの都合でエラーを
 * 見せる理由が無い。
 */
export function UpdateNotice() {
  const query = useQuery({
    queryKey: ['update-check'],
    queryFn: fetchUpdateCheck,
    // サーバー側が6時間キャッシュしているので、クライアントから急かしても意味が無い。
    staleTime: 60 * 60 * 1000,
    retry: false,
  });

  const data = query.data;
  if (data === undefined || data.state !== 'update-available') {
    return null;
  }

  return (
    <a
      className="update-notice"
      href={data.releaseUrl}
      target="_blank"
      rel="noreferrer noopener"
    >
      新しいバージョン {data.latestVersion} が公開されています
    </a>
  );
}
