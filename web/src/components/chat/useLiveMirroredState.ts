import { useCallback, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';

/**
 * bdboard-33jm(root): openThreadIdsRef / selectedThreadIdsRef / draftNoncesRef /
 * threadListsRef はどれも同じ「描画の写し(render-mirror)」パターンだった —
 * useState の値を useRef へ写して、非同期継続(fetch の `.then()`/`.catch()`、
 * 他ハンドラの async continuation)から stale closure なしで最新値を読むための
 * 仕掛け。だが写し先は元々「フック本体のトップレベルで
 * `ref.current = state` する」形(= 次の再レンダーまでしか追いつかない)だった
 * ため、setState の呼び出し箇所ごとに手で `ref.current = ...` を書き足す
 * 運用になり、新しい書き込み経路を増やすたびに同期を書き忘れて同じ種類の
 * バグが7回再発した(bdboard-d29q/d7on/197q/ygrg/e5cz/dqbz/4w2d)。
 * React 自身の react-hooks/refs 規則も「レンダー中の ref 更新/参照」を
 * 警告する(このパターンそのものが対象)。
 *
 * このフックは setState 相当の更新関数を1つに一本化し、その関数の内側だけで
 * (a) ref.current を同期的に書き換え、(b) React の state を更新して再レンダーを
 * スケジュールする。呼び出し側は返る `set` を setState と同じ形(値 or
 * 前の値から計算する更新関数)で呼べるので、既存の呼び出し箇所は型・呼び方を
 * 変えずに移行できる。
 *
 * 更新後の値は ref.current から計算する(setState の updater 引数の prev では
 * ない) — ref.current は set() を経由した書き込みが必ず同期的に反映済みの値
 * なので、setState 自身の内部的な eager-state 計算(バッチ処理の実装詳細)に
 * 依存せずに「最新の値から計算する」が成立する。ref への書き込みが `set` の
 * 中に一本化されているので、新しい書き込み経路を増やしても ref 同期を書き忘れる
 * 余地が無い(= 呼び出し側でこれまで個別に書いていた `xxxRef.current = {...}` は
 * 全て不要になり、消してよい)。
 */
export interface UseLiveMirroredStateResult<T> {
  value: T;
  ref: MutableRefObject<T>;
  set: Dispatch<SetStateAction<T>>;
}

export function useLiveMirroredState<T>(initial: T): UseLiveMirroredStateResult<T> {
  const [value, setValue] = useState<T>(initial);
  // ref の初期値も同じ initial から取るので、初回レンダーの前から既に同期している
  // (set() を経由しない限り以後もずれない)。
  const ref = useRef<T>(initial);

  const set = useCallback<Dispatch<SetStateAction<T>>>((update) => {
    const next =
      typeof update === 'function' ? (update as (prev: T) => T)(ref.current) : update;
    ref.current = next;
    setValue(next);
  }, []);

  return { value, ref, set };
}
