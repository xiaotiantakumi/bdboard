import { useCallback, useEffect, useRef } from 'react';

const PANEL_STATE_KEY = 'bdboardPanel';
const PANEL_TOKEN_KEY = 'bdboardPanelToken';

/** popstate が来ない異常系でもアクションを必ず実行するためのフォールバック */
const POPSTATE_FALLBACK_MS = 500;

/** history.state に載せる bdboard パネル識別子 */
export type BdboardPanelHistoryState = Record<string, unknown> & {
  bdboardPanel?: string;
  bdboardPanelToken?: string;
};

function readHistoryState(): Record<string, unknown> {
  const state = window.history.state;
  if (state !== null && typeof state === 'object') {
    return { ...(state as Record<string, unknown>) };
  }
  return {};
}

export interface UseHistoryBackCloseOptions {
  panelId: string;
  onClose: () => void;
  enabled?: boolean;
}

/**
 * モーダルパネルを history エントリと連動させ、戻るジェスチャーで閉じられるようにする。
 * UI から閉じるときは requestClose() を使い、積んだエントリを消費する。
 */
export function useHistoryBackClose({
  panelId,
  onClose,
  enabled = true,
}: UseHistoryBackCloseOptions): {
  requestClose: () => void;
  requestCloseThen: (run: () => void) => void;
} {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // 自分が pushState で積んだエントリがまだ history スタック上に残っているか
  const pushedRef = useRef(false);
  // onClose を既に呼んだか（二重クローズ防止）
  const closedRef = useRef(false);
  // インスタンスごとに一意。リロード後の古い履歴エントリと取り違えないため
  const tokenRef = useRef('');
  if (tokenRef.current === '') {
    tokenRef.current = `${panelId}#${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  useEffect(() => {
    if (!enabled) {
      return;
    }

    closedRef.current = false;

    if (!pushedRef.current) {
      window.history.pushState(
        {
          ...readHistoryState(),
          [PANEL_STATE_KEY]: panelId,
          [PANEL_TOKEN_KEY]: tokenRef.current,
        },
        '',
      );
      pushedRef.current = true;
    }

    const onPopState = () => {
      const state = window.history.state;
      const stillOurs =
        state !== null &&
        typeof state === 'object' &&
        (state as Record<string, unknown>)[PANEL_TOKEN_KEY] === tokenRef.current;

      if (stillOurs) {
        // 我々のエントリがまだ現在地 = 上に積まれた別エントリが pop されただけ。何もしない。
        return;
      }

      // 我々のエントリは消費された
      pushedRef.current = false;
      if (closedRef.current) {
        // requestClose 由来の back() の結果。onClose は既に呼んでいるので何もしない。
        return;
      }
      closedRef.current = true;
      onCloseRef.current();
    };

    window.addEventListener('popstate', onPopState);

    return () => {
      window.removeEventListener('popstate', onPopState);

      if (pushedRef.current) {
        pushedRef.current = false;
        // history.back() は非同期(実ブラウザではpopstateの発火が次タスクまで
        // 遅延する)。React 18 StrictMode の開発モードは effect を
        // 「マウント→クリーンアップ→再マウント」の順で同一tick内に同期的に
        // 二重実行するため、ここで同期的に back() を呼ぶと、直後の再マウントが
        // 同じトークンで pushState し直した後に、遅れて発火した popstate が
        // (back() 要求後にpushされた分だけ余分に戻ってしまい)トークン不一致の
        // stateで届いてしまい、開いたばかりのパネルを誤って閉じてしまう
        // (実機のpushState/back/popstateのタイミングを計測して確認: 2026-08-24,
        // bdboard-ge1)。back() 呼び出しをマイクロタスクへ遅延し、その時点でも
        // まだ pushedRef が false のまま(=同期的な再マウントで再pushされて
        // いない、つまり本当にアンマウントされた)場合にのみ実行することで、
        // StrictMode の二重実行を安全に無視できるようにする。
        queueMicrotask(() => {
          if (!pushedRef.current) {
            window.history.back();
          }
        });
      }
    };
  }, [enabled, panelId]);

  const requestClose = useCallback(() => {
    if (closedRef.current) {
      return;
    }

    closedRef.current = true;
    onCloseRef.current();

    if (pushedRef.current) {
      pushedRef.current = false;
      window.history.back();
    }
  }, []);

  /**
   * パネルを閉じたあと `run` を実行する。`onClose()` は常に `run()` より先に呼ばれる。
   *
   * `run()` が throw したときの現れ方は hadEntry の有無で非対称:
   * - エントリ有り → popstate リスナ内で `run()` が走るので uncaught error として報告され、
   *   呼び出し元へは伝播しない。
   * - エントリ無し → `run()` は同期実行なのでクリックハンドラへそのまま伝播する。
   * どちらの場合も `onClose()` は先に呼ばれている。
   */
  const requestCloseThen = useCallback((run: () => void) => {
    if (closedRef.current) {
      return;
    }
    closedRef.current = true;

    // onClose() が同期アンマウントを起こす環境でも判定がぶれないよう、
    // エントリの有無は onClose() より前に控える。
    const hadEntry = pushedRef.current;

    // onClose を back() より前・run() より前に呼ぶ。run() が throw しても
    // パレットは必ず閉じるため、全画面パレットから脱出不能になる事故を構造的に防げる。
    onCloseRef.current();

    if (!hadEntry) {
      run();
      return;
    }
    pushedRef.current = false;

    let done = false;
    let timer = 0;

    function finish() {
      if (done) return;
      done = true;
      window.removeEventListener('popstate', finish);
      window.clearTimeout(timer);
      run();
    }

    // requestCloseThen は back() を厳密に1回しか撃たず、リスナ寿命は最大500ms。
    // 主 effect 側 onPopState の stillOurs 判定とは別: ここではトークンを見ない。
    // prod では着地先が別トークン (または state なし) なので stillOurs は元々 false で挙動不変。
    // 入れ子パネル (Chat/Help 等) もトークンが別インスタンスなので必ず不一致。
    // stillOurs が真になるのは dev StrictMode の同一トークン重複エントリのみ = 潰したいケース。
    // onClose() でパレットは即アンマウントされるが、アクションは popstate 着地後に
    // 実行される必要がある。React effect のクリーンアップでは間に合わないため、
    // リスナとタイマーは window に直接付け、finish() で明示的に外す。
    window.addEventListener('popstate', finish);
    // 実測で jsdom の back() は約4ms で popstate を発火する (実ブラウザも同オーダーの
    // 1タスク遅延)。フォールバックが正常系より先に発火すると元の回帰
    // (遷移先のエントリを pop) が再発するため、正常系より十分長く取ってある。
    timer = window.setTimeout(finish, POPSTATE_FALLBACK_MS);
    window.history.back();
  }, []);

  return { requestClose, requestCloseThen };
}
