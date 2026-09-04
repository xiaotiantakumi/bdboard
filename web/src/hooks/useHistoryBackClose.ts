import { useCallback, useEffect, useRef } from 'react';

const PANEL_STATE_KEY = 'bdboardPanel';
const PANEL_TOKEN_KEY = 'bdboardPanelToken';

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
  releaseHistoryEntry: () => void;
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
   * 履歴エントリを back() せずに手放す。onClose は呼ばない (呼び出し側が制御する)。
   *
   * パレットのように閉じると同時に別の履歴エントリを積む遷移を起こすパネル向け。
   * requestClose() の back() だと、遷移先が pushState した直後のエントリを pop して
   * しまうため、行の実行経路ではこちらを使う。
   */
  const releaseHistoryEntry = useCallback(() => {
    closedRef.current = true;

    if (!pushedRef.current) {
      return;
    }

    pushedRef.current = false;

    const currentState = readHistoryState();
    if (
      PANEL_STATE_KEY in currentState ||
      PANEL_TOKEN_KEY in currentState
    ) {
      const cleaned = { ...currentState };
      delete cleaned[PANEL_STATE_KEY];
      delete cleaned[PANEL_TOKEN_KEY];
      window.history.replaceState(cleaned, '');
    }
  }, []);

  return { requestClose, releaseHistoryEntry };
}
