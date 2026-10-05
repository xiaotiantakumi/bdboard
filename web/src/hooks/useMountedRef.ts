import { useEffect, useRef } from 'react';

/**
 * 描画されている間だけ `current` が true の ref。非同期の処理 (送信など) が終わったときに、その画面がまだあるかを確かめ、
 * 閉じたあとで親へ知らせない (利用者が選び直した画面を奪わない) ために使う。描画の中では読まない (イベントや非同期の続きでだけ読む)。
 * StrictMode の effect の二重実行 (片付け → もう一度) のあとも true に戻る。
 */
export function useMountedRef(): { readonly current: boolean } {
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return mounted;
}
