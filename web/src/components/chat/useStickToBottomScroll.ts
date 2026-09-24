import { type RefObject, useCallback, useEffect, useRef } from 'react';
import type { ChatMessage } from './messages';

// 最下部から何 px 以内なら「貼り付いている」とみなすか。ちょうど 0 で判定すると、
// 端数スクロールや sub-pixel なレイアウトで簡単に外れてしまう (bdboard-22k)。
const BOTTOM_STICK_THRESHOLD_PX = 48;

export function useStickToBottomScroll(
  containerRef: RefObject<HTMLDivElement | null>,
  resetKey: string,
  messages: ChatMessage[],
  isSending: boolean,
  streamingText: string,
): { onScroll: () => void } {
  const pinnedToBottomRef = useRef(true);

  // 直近に effect 自身が代入した scrollTop。プログラム的スクロールでも scroll
  // イベントは飛ぶので、そのイベントを「利用者が動かした」と取り違えないための
  // 目印にする (bdboard-dtr)。
  //
  // 一回限りの「プログラム的スクロール中」フラグにはしない。値が変わらず
  // イベントが飛ばなかった場合にフラグが残り、次の *本物の* 利用者スクロールを
  // 握り潰す — 上へスクロールしても引き戻される、という元バグより悪い症状に
  // なる。現在値との一致で判定すれば冪等なので、取りこぼしても次の
  // イベントで正しく判定し直せる。
  const autoScrolledToRef = useRef<number | null>(null);

  const handleMessagesScroll = useCallback(() => {
    const container = containerRef.current;
    if (container === null) {
      return;
    }
    // effect が置いた位置から動いていないなら、これは自分で起こしたスクロールの
    // 残響。ここで距離を測ると、イベントが遅れて届く間に次の delta で
    // scrollHeight が伸びていた場合に「利用者が上へスクロールした」と誤判定し、
    // 誰も触っていないのに追従が止まる (bdboard-dtr)。
    //
    // 判定を「触っていない」に倒すだけで、貼り付きを立て直しはしない。effect が
    // 代入するのは貼り付いているときだけなので、正規の残響なら既に true。
    // ここで true を書くと、マーカーと利用者のスクロール位置が偶然
    // 一致したときに勝手に貼り付きへ戻す効果しか持たない (PR#132 レビュー)。
    if (container.scrollTop === autoScrolledToRef.current) {
      return;
    }
    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    const pinned = distanceFromBottom <= BOTTOM_STICK_THRESHOLD_PX;
    pinnedToBottomRef.current = pinned;
    if (!pinned) {
      // 追うのをやめた時点でマーカーを捨てる。残したままにすると、利用者が
      // 過去ログを読んでいる間ずっと「昔の最下部の座標」が生き続け、そこへ
      // 偶然スクロールが止まったときに上のガードが誤って一致してしまう。
      autoScrolledToRef.current = null;
    }
  }, [containerRef]);

  // 会話を切り替えたら貼り付き状態に戻す。前の会話で上へスクロールしていた
  // からといって、新しい会話を途中から表示する理由は無い。
  useEffect(() => {
    pinnedToBottomRef.current = true;
    autoScrolledToRef.current = null;
  }, [resetKey]);

  useEffect(() => {
    const container = containerRef.current;
    if (container !== null && pinnedToBottomRef.current) {
      container.scrollTop = container.scrollHeight;
      // ブラウザは範囲外の代入をクランプするので、書いた値ではなく
      // 実際に落ち着いた値を覚える。
      autoScrolledToRef.current = container.scrollTop;
    }
  }, [containerRef, messages, isSending, streamingText]);

  return { onScroll: handleMessagesScroll };
}
