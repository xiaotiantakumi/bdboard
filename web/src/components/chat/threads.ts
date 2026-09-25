// bdboard-sso1.2: ChatPanel.tsx から純粋ヘルパーを移動しただけのファイル。
// 挙動は一切変えていない。formatThreadUpdatedAt は ChatPanel.tsx から
// re-export され、外部 import パス (ChatPanel.test.tsx 含む) は変わらない。
import type { ChatThreadDto } from '../../api';
import { getBoardTimeZone } from '../../boardTimeZone';

export function buildThreadById(threads: readonly ChatThreadDto[]): Map<string, ChatThreadDto> {
  return new Map(threads.map((thread) => [thread.sessionId, thread]));
}

export function summarizeTitle(content: string): string {
  const chars = Array.from(content.trim());
  return chars.length > 40 ? `${chars.slice(0, 40).join('')}…` : chars.join('');
}

const threadUpdatedAtFormatters = new Map<string, Intl.DateTimeFormat>();

function getThreadUpdatedAtFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = threadUpdatedAtFormatters.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      month: 'numeric',
      day: 'numeric',
    });
    threadUpdatedAtFormatters.set(timeZone, formatter);
  }
  return formatter;
}

// bdboard チャット改善(Chat Redesign 1b): スレッド一覧ドロワーの各行に出す
// 更新日時の短縮表示。「N分前」のような相対表記は Date.now() 依存でテストが
// 時刻に脆くなるため避け、月/日の絶対表記だけを返す決定的な実装にしている。
// 暦日はボード設定 TZ 基準(activityFeedFormatting と同様、see bdboard-3tw.75)。
export function formatThreadUpdatedAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const parts = getThreadUpdatedAtFormatter(getBoardTimeZone()).formatToParts(date);
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;
  if (month === undefined || day === undefined) return '';
  return `${month}/${day}`;
}

// スレッド一覧の並び順(bdboard-3tw.154)。更新の新しい順。
//
// ピン留めはここでは見ない。ドロワーは「ピン留め」節と「開いている/閉じた」節に
// pinned で振り分けてから描画しており、振り分けは filter なので相対順序を保つ。
// つまりピン留め優先はこの比較関数を通さずに成立していて、ここに pinned を足すと
// 表示に出ない分岐が増えるだけになる。
//
// 更新日時が読めないスレッドは 0 として最後尾に落とす。ここに来るのは
// 「開いてはいるがスレッド一覧の再取得がまだ届いていない」極短い窓
// (CLIセッションの再開直後など)だけで、次の再取得で正しい位置へ移る。
// NaN をそのまま比較に流すと比較関数が非推移的になり、並びが入力順で変わる。
function threadRecency(thread: ChatThreadDto | undefined): number {
  if (thread === undefined) return 0;
  const at = Date.parse(thread.updatedAt);
  return Number.isNaN(at) ? 0 : at;
}

export function compareThreadsNewestFirst(
  a: ChatThreadDto | undefined,
  b: ChatThreadDto | undefined,
): number {
  return threadRecency(b) - threadRecency(a);
}

// bdboard-sso1.83 第4段: ChatPanel.tsx から純関数を移動しただけ。挙動は変えていない。
export function chatSettingsSummaryParts(
  projectName: string | undefined,
  currentThreadTitle: string,
  agentLabel: string | undefined,
): string[] {
  return ['チャット設定', projectName, currentThreadTitle, agentLabel].filter(
    (part): part is string => part !== undefined && part !== '',
  );
}

export interface ThreadDrawerRowPartition {
  pinnedOpen: string[];
  unpinnedOpen: string[];
  pinnedClosed: ChatThreadDto[];
  unpinnedClosed: ChatThreadDto[];
}

// bdboard-sso1.83 第6段: ChatPanel.tsx から純関数を移動しただけ。挙動は変えていない。
// 開いている/閉じたスレッドのどちらに属していても、ピン留めされていれば
// 「ピン留め」節へ寄せ、開いている/閉じた節には残さない(mutual exclusion)。
// displayedOpen/closed は呼び出し側で既に新しい順にソート済みで、ピン留め優先は
// この filter が担う(filter は相対順序を保つので、節の中は新しい順のまま)。
export function partitionThreadDrawerRows(
  displayedOpen: readonly string[],
  closed: readonly ChatThreadDto[],
  threadById: ReadonlyMap<string, ChatThreadDto>,
): ThreadDrawerRowPartition {
  return {
    pinnedOpen: displayedOpen.filter((sessionId) => threadById.get(sessionId)?.pinned === true),
    unpinnedOpen: displayedOpen.filter((sessionId) => threadById.get(sessionId)?.pinned !== true),
    pinnedClosed: closed.filter((thread) => thread.pinned === true),
    unpinnedClosed: closed.filter((thread) => thread.pinned !== true),
  };
}
