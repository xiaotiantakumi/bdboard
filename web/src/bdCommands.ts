export type BdCommandKind =
  | 'claim'
  | 'close'
  | 'comment'
  | 'appendNotes'
  | 'defer';

/**
 * POSIX シェル向けにシングルクォートで囲む。シングルクォート自身は
 * '\'' （閉じる→エスケープ済みの ' →再度開く）に置換する。
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function formatBdPrefix(rootPath?: string): string {
  if (rootPath !== undefined && rootPath.length > 0) {
    return `bd -C ${shellQuote(rootPath)}`;
  }
  return 'bd';
}

export function buildBdCommand(
  kind: BdCommandKind,
  ticketId: string,
  rootPath?: string,
): string {
  const prefix = formatBdPrefix(rootPath);
  const quotedTicketId = shellQuote(ticketId);
  switch (kind) {
    case 'claim':
      return `${prefix} update ${quotedTicketId} --claim`;
    case 'close':
      return `${prefix} close ${quotedTicketId}`;
    case 'comment':
      return `${prefix} comment ${quotedTicketId} "<ここにコメント>"`;
    case 'appendNotes':
      return `${prefix} update ${quotedTicketId} --append-notes "<ここにメモ>"`;
    case 'defer':
      return `${prefix} update ${quotedTicketId} --defer ${shellQuote(formatDeferDate())}`;
  }
}

/**
 * The defer button hands over a ready-to-run command, so the date has to be in
 * the future: today's date would close the loop on itself (the issue comes back
 * to `bd ready` immediately) and a `<YYYY-MM-DD>` placeholder cannot be pasted
 * into a shell without editing it first. A week out is the common "not now,
 * look at it again later" horizon; edit the date after pasting for anything else.
 */
export const DEFER_DAYS = 7;

export function formatDeferDate(now: Date = new Date()): string {
  const target = new Date(now.getTime());
  target.setDate(target.getDate() + DEFER_DAYS);
  const year = target.getFullYear();
  const month = String(target.getMonth() + 1).padStart(2, '0');
  const day = String(target.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export const BD_COMMAND_DEFINITIONS: readonly {
  kind: BdCommandKind;
  label: string;
}[] = [
  { kind: 'claim', label: '着手' },
  { kind: 'close', label: '完了' },
  { kind: 'comment', label: 'コメント' },
  { kind: 'appendNotes', label: 'ノート追記' },
  { kind: 'defer', label: '1週間延期' },
];

export interface WorktreeCleanupTarget {
  readonly repoRootPath: string;
  readonly worktreePath: string | null;
  readonly branchName: string | null;
}

/**
 * 残骸 worktree / ブランチの掃除コマンドを組み立てる。
 * **実行はしない。コピー用の文字列を返すだけ**(worktree 削除は破壊的操作であり、
 * 過去に削除後の新規シェルが CPU を専有し続ける事故があったため UI から自動実行させない)。
 */
export function buildWorktreeCleanupCommands(
  target: WorktreeCleanupTarget,
): readonly string[] {
  const commands: string[] = [];
  const quotedRepoRoot = shellQuote(target.repoRootPath);

  if (target.worktreePath !== null) {
    commands.push(
      `git -C ${quotedRepoRoot} worktree remove ${shellQuote(target.worktreePath)}`,
    );
  }

  if (target.branchName !== null) {
    commands.push(
      `git -C ${quotedRepoRoot} branch -d ${shellQuote(target.branchName)}`,
    );
  }

  return commands;
}

/** buildWorktreeCleanupCommands の結果を改行で連結した、そのまま貼れる文字列 */
export function formatWorktreeCleanupScript(
  target: WorktreeCleanupTarget,
): string {
  return buildWorktreeCleanupCommands(target).join('\n');
}

export async function copyTextToClipboard(text: string): Promise<void> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText !== undefined) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall through to execCommand when clipboard API is blocked or fails.
    }
  }

  if (typeof document === 'undefined') {
    throw new Error('Clipboard is unavailable');
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.top = '0';
  textarea.style.left = '0';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();

  try {
    const successful = document.execCommand('copy');
    if (!successful) {
      throw new Error('execCommand copy failed');
    }
  } finally {
    document.body.removeChild(textarea);
  }
}
