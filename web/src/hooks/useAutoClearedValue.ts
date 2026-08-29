import { useCallback, useEffect, useRef, useState } from 'react';

export interface AutoClearedValue<T> {
  /** 現在値。何も出ていないときは emptyValue。 */
  readonly value: T;
  /** 表示して delayMs 後に自動で空へ戻す。アンマウント後は no-op。 */
  readonly show: (next: T) => void;
  /** 表示するが自動では消さない。アンマウント後は no-op。 */
  readonly hold: (next: T) => void;
  /** 即座に空へ戻し、待機中の自動消去も捨てる。 */
  readonly clear: () => void;
}

/**
 * 一時的な表示値と、その自動消去タイマーをまとめて持つ。
 *
 * bdboard-ifff で useSaveFeedback として入れた仕掛けを、フィードバック文言以外
 * (コピー結果の aria-live、修復ステータス、コマンドのコピー表示) にも使えるように
 * 一般化したもの (bdboard-ty72)。守っているのは次の2つで、**両方揃って初めて安全**
 * になる:
 *
 * 1. タイマーIDを ref で持ち、(a) アンマウント時 (b) 次の表示を出すとき の両方で
 *    必ずクリアする。持たないと、生き残ったタイマーが後から setState を呼び、
 *    テストでは破棄済みの jsdom で `window is not defined` を投げる。vitest は
 *    これを「テスト環境破棄後の未捕捉エラー」として扱うので、**個々のテストは
 *    全て pass しているのにプロセスが exit 1 で落ちる**。
 * 2. アンマウント後は show / hold 自体を no-op にする。1 だけでは足りない:
 *    呼び出し側はたいてい `await copyTextToClipboard(...)` や
 *    `await invalidateQueries(...)` の**継続**から表示を出すので、その継続は
 *    クリーンアップの後に解決しうる。そこで新しいタイマーを仕掛けると、
 *    もう誰も片付けられない。
 *
 * bdboard-ifff の一次調査は 1 だけを見て 2 を見落とし、HygienePanel /
 * DailyDigest / TicketDetailPanel / UndoSnackbar の5箇所を素通りさせた
 * (bdboard-ty72)。判定基準は「タイマーIDを ref に持っているか」ではなく
 * 「**await / then の継続からタイマーを武装していないか**」。
 *
 * 注意: マウント判定はこのフック自身の effect で立てるので、**初回レンダー中から
 * 最初の effect が走るまでの間**は show / hold / clear が黙って捨てられる。
 * 現在の呼び出し元はすべてイベントハンドラか非同期継続からなので該当しないが、
 * useLayoutEffect から呼ぶと表示が出ない。
 *
 * @param emptyValue 何も出ていない状態の値。**初回レンダー時の値だけ**を使う
 *   (自動消去先を毎レンダー差し替えると、消去のタイミングによって戻り先が変わって
 *   しまうため)。呼び出し側は定数を渡すこと。
 * @param delayMs show からの自動消去までのミリ秒。
 */
export function useAutoClearedValue<T>(
  emptyValue: T,
  delayMs: number,
): AutoClearedValue<T> {
  const [value, setValue] = useState<T>(emptyValue);
  const emptyRef = useRef(emptyValue);
  const timerRef = useRef<number | undefined>(undefined);
  const mountedRef = useRef(false);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== undefined) {
      window.clearTimeout(timerRef.current);
      timerRef.current = undefined;
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearTimer();
    };
  }, [clearTimer]);

  const show = useCallback(
    (next: T) => {
      if (!mountedRef.current) {
        return;
      }
      clearTimer();
      setValue(next);
      timerRef.current = window.setTimeout(() => {
        timerRef.current = undefined;
        setValue(emptyRef.current);
      }, delayMs);
    },
    [clearTimer, delayMs],
  );

  const hold = useCallback(
    (next: T) => {
      if (!mountedRef.current) {
        return;
      }
      clearTimer();
      setValue(next);
    },
    [clearTimer],
  );

  const clear = useCallback(() => {
    // タイマーの後始末はマウント状態に関わらず行う。setValue のほうだけは
    // show / hold と同じ理由でマウント中に限る。
    clearTimer();
    if (!mountedRef.current) {
      return;
    }
    setValue(emptyRef.current);
  }, [clearTimer]);

  return { value, show, hold, clear };
}
