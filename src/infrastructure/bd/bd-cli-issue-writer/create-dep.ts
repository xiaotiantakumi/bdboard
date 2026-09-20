import { z } from 'zod';
import type { CommandRunner } from '../../../application/ports/command-runner.js';
import { BdError } from '../../../application/ports/issue-repository.js';
import { runBdCommand, runBdWriteCommandForStdout } from '../bd-cli-tool-runner.js';
import { withLockContentionRetry } from '../bd-retry.js';
import { readOpenTicketByLabel } from './find-by-label.js';

// create の結果パース用。bd create --json は成功時オブジェクト1件を返す
// (実測: bd 1.2.1)。
const bdCreateResultSchema = z.object({
  id: z.string(),
});

// bd-tool-catalog の bd_create はチャットエージェント向けの制限 (labels 無し等)
// を持つため経由しない。bdboard 自身がサーバー側で固定文言から組み立てた
// title/description だけを渡す用途 (ハーネス契約チケットの起票、bdboard-p5l.25)
// の直叩き専用。
export async function findOpenTicketByLabel(
  commandRunner: CommandRunner,
  bdPath: string,
  timeoutMs: number,
  rootPath: string,
  label: string,
): Promise<
  | {
      readonly id: string;
      readonly title: string;
      readonly metadata: Readonly<Record<string, unknown>>;
    }
  | null
> {
  return readOpenTicketByLabel(commandRunner, bdPath, timeoutMs, rootPath, label);
}

export async function create(
  commandRunner: CommandRunner,
  bdPath: string,
  timeoutMs: number,
  rootPath: string,
  input: {
    readonly title: string;
    readonly description: string;
    readonly type: string;
    readonly priority: number;
    readonly labels: readonly string[];
    readonly metadata?: Readonly<Record<string, string>>;
  },
): Promise<{ readonly id: string }> {
  const args: string[] = [
    '-C',
    rootPath,
    'create',
    '--title',
    input.title,
    '--type',
    input.type,
    '--priority',
    String(input.priority),
    '--json',
  ];
  if (input.labels.length > 0) {
    args.push('--labels', input.labels.join(','));
  }
  // `bd create --metadata '<json>'` は作成時点でメタデータを set できる (実測
  // 確認済み・bdboard-13mp)。空オブジェクトなら渡さない (省略時と同じ挙動にする)。
  if (input.metadata !== undefined && Object.keys(input.metadata).length > 0) {
    args.push('--metadata', JSON.stringify(input.metadata));
  }
  // 説明は常に非空 (呼び出し元はサーバー側で固定テンプレートを組み立てる) 前提。
  // --allow-empty-description の分岐は持たない。
  args.push('--stdin');

  const stdout = await runBdWriteCommandForStdout(
    commandRunner,
    bdPath,
    timeoutMs,
    rootPath,
    args,
    rootPath,
    input.description,
  );

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout) as unknown;
  } catch {
    throw new BdError('unknown', rootPath, 'failed to parse bd create output');
  }

  const item = Array.isArray(parsed) ? parsed[0] : parsed;
  const result = bdCreateResultSchema.safeParse(item);
  if (!result.success) {
    throw new BdError('unknown', rootPath, 'bd create output missing id');
  }

  return { id: result.data.id };
}

// `bd update --set-metadata k=v` は代入操作 (追記系の comment と違い同じ引数で
// 何度実行しても最終状態は変わらない) なので lock-contention リトライの対象に
// 含めてよい (bd-cli-session-link-writer.ts の同種コメント参照・bdboard-13mp)。
export async function setMetadata(
  commandRunner: CommandRunner,
  bdPath: string,
  timeoutMs: number,
  rootPath: string,
  ticketId: string,
  key: string,
  value: string,
): Promise<void> {
  await withLockContentionRetry(() =>
    runBdCommand(
      commandRunner,
      bdPath,
      timeoutMs,
      rootPath,
      ['-C', rootPath, 'update', ticketId, '--set-metadata', `${key}=${value}`],
      ticketId,
    ),
  );
}
