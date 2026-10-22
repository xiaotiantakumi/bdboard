// bdboard-fac0: モバイルの細い固定バーが「チケットID」と「短縮タイトル」を切り替える
// ための判定。タイトル要素が画面上端の固定バー(48px)の下へスクロールして見えなく
// なったら true。IntersectionObserver が無い環境では常に false (= ID 表示のまま)。
import { useEffect, useState, type RefObject } from 'react';

export const MOBILE_BAR_HEIGHT_PX = 48;

export function mobileBarLabel(
  titleOutOfView: boolean,
  ticketId: string,
  title: string | undefined,
): string {
  if (!titleOutOfView || title === undefined || title.trim() === '') {
    return ticketId;
  }
  return title;
}

export function useTitleOutOfView(
  ref: RefObject<Element | null>,
  resetKey: string,
): boolean {
  const [outOfView, setOutOfView] = useState(false);
  useEffect(() => {
    setOutOfView(false);
    const el = ref.current;
    if (el === null || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry === undefined) return;
        // 上へ抜けたときだけ true (下側にはみ出している間は ID のまま)
        setOutOfView(!entry.isIntersecting && entry.boundingClientRect.top < 0);
      },
      { rootMargin: `-${MOBILE_BAR_HEIGHT_PX}px 0px 0px 0px` },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, resetKey]);
  return outOfView;
}
