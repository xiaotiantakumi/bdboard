import type { ChatThreadDto } from '../../api';

/**
 * bdboard-znnl: スレッド一覧 effect(chat/useThreadListSync.ts の E7)の初回応答を一覧へ当てるときの
 * 合成規則。他経路(CLI セッションの採用 = chat/useChatSessionLifecycle.ts の
 * handleResumeDiscoveredSession など)が in-flight 中に restoredProjectsRef を立てた場合、E7 は
 * open と選択を復元し直さずに(open はその経路が確立した状態のまま)一覧だけを当てる。その応答は
 * 採用より前に始まった fetch の結果なので、採用の後に取り直した新しい一覧より古いことがあり、
 * そのまま置き換えると採用したセッション(まだ古い応答には載っていない)のエントリが一覧から消えて、
 * 開いているタブのタイトルが引けない「(無題)」に戻る。
 *
 * 応答 `fetched` を土台にして、いま一覧に載っている(`current`)エントリのうち、応答に無く
 * 開いているタブ(`openIds`)のものだけを足す。開いているタブは E7 が触らずに残す open 状態そのもの
 * なので、そのエントリを一覧から落とす理由が無い。閉じているスレッドの古いエントリや、応答が
 * 載せていない id は足さない(他タブでサーバー側から消えたスレッドを一覧に蘇らせない)。
 * 応答に載っている id は応答を優先する(順序も応答のまま、足すのは末尾)。
 *
 * 既知の限界: 再訪中に採用し、古い応答が採用の取り直しより先に届くと、`current` は前回訪問の
 * 一覧なので、サーバーでは消えたが永続化上は開いているタブのエントリが古いタイトルのまま一時的に残る。
 * 取り直しが届けば一覧は置き換わり、open からも pruneDeadOpenThreads が落とす。
 */
export function keepOpenThreadEntries(
  fetched: readonly ChatThreadDto[],
  current: readonly ChatThreadDto[] | undefined,
  openIds: readonly string[] | undefined,
): ChatThreadDto[] {
  if (current === undefined || openIds === undefined || openIds.length === 0) return [...fetched];
  const fetchedIds = new Set(fetched.map((thread) => thread.sessionId));
  const open = new Set(openIds);
  const kept = current.filter((thread) => open.has(thread.sessionId) && !fetchedIds.has(thread.sessionId));
  return [...fetched, ...kept];
}
