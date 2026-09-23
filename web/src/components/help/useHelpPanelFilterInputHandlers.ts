// bdboard-sso1.67: useHelpPanelFilter.ts から、絞り込み入力欄 (IME 合成を含む)
// のハンドラ一式を move-only で切り出したフック。useCallback の依存配列・本体は
// 移動前から変えていない。
import { useCallback } from 'react';
import type {
  ChangeEvent,
  CompositionEvent,
  Dispatch,
  KeyboardEvent,
  MutableRefObject,
  SetStateAction,
} from 'react';

export interface UseHelpPanelFilterInputHandlersParams {
  readonly filterQuery: string;
  readonly isComposingRef: MutableRefObject<boolean>;
  readonly setFilterQuery: Dispatch<SetStateAction<string>>;
  readonly setAppliedQuery: Dispatch<SetStateAction<string>>;
}

export function useHelpPanelFilterInputHandlers({
  filterQuery,
  isComposingRef,
  setFilterQuery,
  setAppliedQuery,
}: UseHelpPanelFilterInputHandlersParams) {
  const handleFilterBlur = useCallback(() => {
    isComposingRef.current = false;
  }, []);

  const handleFilterChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const value = event.target.value;
      setFilterQuery(value);
      // nativeEvent は Event 型だが、一部環境では compositionstart より先に input が来る
      const nativeEvent = event.nativeEvent as Event & { isComposing?: boolean };
      if (nativeEvent.isComposing === false) {
        isComposingRef.current = false;
      }
      if (!isComposingRef.current && nativeEvent.isComposing !== true) {
        setAppliedQuery(value);
      }
    },
    [],
  );

  const handleCompositionStart = useCallback(() => {
    isComposingRef.current = true;
  }, []);

  const handleCompositionEnd = useCallback(
    (event: CompositionEvent<HTMLInputElement>) => {
      isComposingRef.current = false;
      const value = event.currentTarget.value;
      setFilterQuery(value);
      setAppliedQuery(value);
    },
    [],
  );

  // useFocusTrap は <aside> にネイティブ keydown（バブル）を付ける。React の onKeyDown も
  // ルート委譲のバブルなので、input → aside ネイティブ → root React バブル の順になり
  // stopPropagation() では trap 側を止められない。onKeyDownCapture + preventDefault() で
  // useFocusTrap の defaultPrevented バイパスを先に効かせ、入力あり時だけパネル閉じを抑止する。
  const handleFilterKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key !== 'Escape') {
        return;
      }
      if (isComposingRef.current || event.nativeEvent.isComposing === true) {
        // 合成中 Escape は主要ブラウザでは key: "Process" で届かず到達不能だが、
        // 万一届いた場合は preventDefault してパネル閉じを抑止する。トレードオフ:
        // IME キャンセルが効かない代わりに「パネルが消えて文脈ごと失われる」を防ぐ。
        // IME キャンセルは選択削除で回避できるが、パネル消失は 1 打鍵で不可逆。
        event.preventDefault();
        return;
      }
      if (filterQuery !== '') {
        event.preventDefault();
        setFilterQuery('');
        setAppliedQuery('');
      }
    },
    [filterQuery],
  );

  return {
    handleFilterBlur,
    handleFilterChange,
    handleCompositionStart,
    handleCompositionEnd,
    handleFilterKeyDown,
  };
}
