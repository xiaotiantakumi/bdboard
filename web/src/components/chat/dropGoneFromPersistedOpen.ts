import {
  readPersistedChatThreads,
  resolvePersistedSelectionAfterClose,
  writePersistedChatThreadState,
} from '../../chatThreadStorage';

/**
 * bdboard-v9tz: chat/useChatSessionLifecycle.ts の handleHistorySessionGone が、選択中ではない
 * スレッドの消滅(404 / unknown chat session)を受けたとき、永続化の activeSessionIds からその id を
 * 落とす。以前はメモリの open と一覧だけが落ち、永続化に死んだ id が残っていた(選択中だった場合だけ
 * handleHistorySessionGone 自身が書いていた)。
 *
 * 基点はメモリの open ではなく永続化済みの activeSessionIds そのもの: 一覧が未復元(初回の一覧 fetch が
 * in-flight、メモリの open がまだ空)でも、他の id を巻き込まず死んだ id だけを落とせる(bdboard-4w2d)。
 * 永続化にそのプロジェクトのエントリが無い(初回訪問)ときと、エントリに死んだ id が無いときは何も書かない
 * — エントリを作ると restoreThreadView が「初回訪問ではない」と読み、サーバー一覧の全スレッドを開く
 * 既定の挙動が変わる。
 *
 * 選択は closeThread(chat/useChatThreadLists.ts)の「選択中ではないスレッドを閉じる」と同じ規則:
 * ライブの選択があればそれを、ドラフト表示中(ライブの選択なし)なら永続化済みの選択を、それが残りの open に
 * 含まれる限り引き継ぐ(chatThreadStorage.ts の resolvePersistedSelectionAfterClose、bdboard-e5cz)。
 * 呼び出し側は setState の updater の外で呼ぶこと(StrictMode の二重実行対策。書き込みは冪等だが、
 * updater の中に副作用を置かない規約に揃える)。
 */
export function dropGoneFromPersistedOpen(
  projectId: string,
  goneSessionId: string,
  liveSelectedSessionId: string | undefined,
): void {
  const persisted = readPersistedChatThreads()[projectId];
  if (persisted === undefined || !persisted.activeSessionIds.includes(goneSessionId)) return;
  const nextOpen = persisted.activeSessionIds.filter((id) => id !== goneSessionId);
  writePersistedChatThreadState(projectId, {
    activeSessionIds: nextOpen,
    selectedSessionId:
      liveSelectedSessionId ?? resolvePersistedSelectionAfterClose(projectId, nextOpen, undefined),
  });
}
