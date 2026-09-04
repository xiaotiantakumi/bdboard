import { computeDeferUntilDate } from './deferPeriods';

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
  return computeDeferUntilDate('1week', now);
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
 * 過去に削除後の新規シェルが CPU を専有し続ける事故 bdboard-3tw.61 があったため
 * UI から自動実行させない)。worktree 削除行は lsof で cwd が残っていないことを
 * 確認してから remove するガード付きワンライナーになる。
 */
export function buildWorktreeCleanupCommands(
  target: WorktreeCleanupTarget,
): readonly string[] {
  const commands: string[] = [];
  const quotedRepoRoot = shellQuote(target.repoRootPath);

  if (target.worktreePath !== null) {
    const quotedWorktreePath = shellQuote(target.worktreePath);
    commands.push(
      `if [ -z "$(lsof -a -d cwd +D ${quotedWorktreePath})" ]; then git -C ${quotedRepoRoot} worktree remove ${quotedWorktreePath}; else echo 'worktree still in use, skipping removal:' ${quotedWorktreePath} >&2; fi`,
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

export interface HeartbeatLoopKillTarget {
  readonly pid: number;
  readonly startedAt?: string;
}

/** ps -o command= の出力が heartbeat ループかどうかを grep -E で判定するパターン */
const HEARTBEAT_CMD_GREP_PATTERN =
  'bd-heartbeat(\\.sh)?[[:space:]]+start|(.*\\b(while|for|until)\\b.*\\bbd([[:space:]]+[^[:space:]]+)*[[:space:]]+heartbeat\\b)';

/** 先頭トークンの basename が bash/sh/zsh であること */
const HEARTBEAT_SHELL_GREP_PATTERN = '^([^[:space:]]+/)*(bash|sh|zsh)([[:space:]]|$)';

/**
 * 残骸 heartbeat ループを止めるコマンドを組み立てる。
 * **PID 指定の kill のみ**。`pkill` / `killall` のようなパターンマッチ kill は絶対に出さない
 * (failure-catalog の pkill-collateral: worktree のテストプロセスを狙った
 * `pkill -f 'tsx.*src/main.ts'` が常時稼働サーバーを巻き添えにした)。
 *
 * ボードが ps を見てから人間がコピーして実行するまでには時間差があり、その間に
 * PID が再利用されうる。そこで kill の直前に `ps -p <pid> -o command=` で
 * 「まだ heartbeat ループである」ことと、可能なら lstart の一致を確認するガードを付ける。
 * ガードが外れたときは何も殺さずメッセージだけ出す (bd-heartbeat.sh の verify_loop_identity と同じ考え方)。
 */
export function buildHeartbeatLoopKillCommands(
  target: HeartbeatLoopKillTarget,
): readonly string[] {
  const { pid, startedAt } = target;
  if (!Number.isInteger(pid) || pid <= 1) {
    return [];
  }

  const lstartGuard =
    startedAt !== undefined
      ? ` && [ "$(ps -p ${pid} -o lstart=)" = ${shellQuote(startedAt)} ]`
      : '';

  return [
    `cmd=$(ps -p ${pid} -o command=); if echo "$cmd" | grep -Eq '${HEARTBEAT_SHELL_GREP_PATTERN}' && echo "$cmd" | grep -Eq '${HEARTBEAT_CMD_GREP_PATTERN}'${lstartGuard}; then kill ${pid}; else echo 'pid ${pid} is no longer a bd heartbeat loop; skipping' >&2; fi`,
  ];
}

/** buildHeartbeatLoopKillCommands の結果を改行で連結した、そのまま貼れる文字列 */
export function formatHeartbeatLoopKillScript(
  target: HeartbeatLoopKillTarget,
): string {
  return buildHeartbeatLoopKillCommands(target).join('\n');
}

export interface DependencyCycleEdgeTarget {
  readonly issueId: string;
  readonly dependsOnId: string;
}

/**
 * 循環依存を構成する blocks エッジを切るコマンド一覧を組み立てる。
 * 実行はしない。コピー用の文字列を返すだけ(依存編集は破壊的操作であり、
 * ユーザーが確認してから手元で実行する)。
 */
export function buildDependencyCycleRemovalCommands(
  edges: readonly DependencyCycleEdgeTarget[],
  rootPath?: string,
): readonly string[] {
  const prefix = formatBdPrefix(rootPath);
  return edges.map(
    (edge) =>
      `${prefix} dep remove ${shellQuote(edge.issueId)} ${shellQuote(edge.dependsOnId)}`,
  );
}

/** buildDependencyCycleRemovalCommands の結果を改行で連結した、そのまま貼れる文字列 */
export function formatDependencyCycleRemovalScript(
  edges: readonly DependencyCycleEdgeTarget[],
  rootPath?: string,
): string {
  return buildDependencyCycleRemovalCommands(edges, rootPath).join('\n');
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
