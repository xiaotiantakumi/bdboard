import { useEffect, useState } from 'react';
import {
  fetchPlatformSupport,
  type PlatformFeature,
  type PlatformLimitationDto,
  type PlatformSupportDto,
} from '../api';

/**
 * サーバーの実行プラットフォームは動かないので、プロセス内で一度だけ引く。
 *
 * ここだけ react-query を使わないのは、この通知を ChatPanel のように
 * QueryClientProvider の外側でも描かれうる場所に落とせるようにするため
 * (bdboard-70z.9)。取得結果が不変である以上、キャッシュ戦略も要らない。
 */
let platformSupportPromise: Promise<PlatformSupportDto> | null = null;

function loadPlatformSupport(): Promise<PlatformSupportDto> {
  platformSupportPromise ??= fetchPlatformSupport();
  return platformSupportPromise;
}

/** テスト用。プロセス内キャッシュを捨てる。 */
export function resetPlatformSupportCache(): void {
  platformSupportPromise = null;
}

interface PlatformLimitationNoticeProps {
  feature: PlatformFeature;
}

/**
 * その機能が実行プラットフォームで使えないとき、理由付きで知らせる
 * (bdboard-70z.9)。
 *
 * 使える環境では何も描かない。黙って空リストを見せる/エラーだけ出すのが
 * 一番悪い体験なので、「動かない」ことと「なぜ動かないか」を同じ場所に出す。
 */
export function PlatformLimitationNotice({ feature }: PlatformLimitationNoticeProps) {
  const [limitation, setLimitation] = useState<PlatformLimitationDto | null>(null);

  useEffect(() => {
    let cancelled = false;

    loadPlatformSupport()
      .then((support) => {
        if (cancelled) {
          return;
        }
        setLimitation(
          support.limitations.find((entry) => entry.feature === feature) ?? null,
        );
      })
      // 制限の問い合わせに失敗したからといって、画面を壊してはいけない。
      // 分からないときは何も言わない。
      .catch(() => {
        if (!cancelled) {
          setLimitation(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [feature]);

  if (limitation === null) {
    return null;
  }

  return (
    <div className="platform-limitation-notice" role="status">
      <strong className="platform-limitation-notice-reason">{limitation.reason}</strong>
      <span className="platform-limitation-notice-detail">{limitation.detail}</span>
    </div>
  );
}
