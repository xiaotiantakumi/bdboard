import { z } from 'zod';
import type { CommandRunner } from '../../../application/ports/command-runner.js';
import { BdError } from '../../../application/ports/issue-repository.js';
import { runBdCommandForStdout } from '../bd-cli-tool-runner.js';

// findOpenTicketByLabel の CAS 不要読み取り用。`bd list --label` の既定挙動が
// closed を除外するので、ここでは status を見ない (bd 側のフィルタに任せる)。
// metadata は optional (実測: メタデータが1つも無いチケットは `bd list --json` の
// 出力にキー自体が現れない・bdboard-13mp) なので z.record を optional で受ける。
const bdListLabelItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  // .nullish(): bd list --json は metadata が無いチケットではキーごと省略するが
  // (確認済み)、将来 bd 側の挙動が変わって明示的に null を返すようになっても
  // ルート全体が 502 に落ちないよう .optional() ではなく .nullish() にしておく
  // (bdShowDescriptionItemSchema と同じ防御方針、レビュー指摘)。
  metadata: z.record(z.unknown()).nullish(),
});

export async function readOpenTicketByLabel(
  commandRunner: CommandRunner,
  bdPath: string,
  timeoutMs: number,
  rootPath: string,
  label: string,
): Promise<
  | { readonly id: string; readonly title: string; readonly metadata: Readonly<Record<string, unknown>> }
  | null
> {
  const stdout = await runBdCommandForStdout(
    commandRunner,
    bdPath,
    timeoutMs,
    rootPath,
    ['--readonly', '-C', rootPath, 'list', '--label', label, '--json', '--limit', '0', '--no-pager'],
    // errorSubject は BdError.projectId に載る (throwBdToolFailure 参照)。ここでの
    // 「対象」は label ではなく rootPath — 他の呼び出し箇所 (reopen の CAS 読み取り等)
    // と揃え、失敗ログから実際に失敗したプロジェクトを追えるようにする (レビュー指摘)。
    rootPath,
  );

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout) as unknown;
  } catch {
    throw new BdError(
      'unknown',
      rootPath,
      `failed to parse bd list output while checking for an existing ${label} ticket`,
    );
  }

  // 配列でない出力は「該当なし」ではなく「bd の出力形式が想定と違う」ので、null を
  // 返さず即座に投げる。ここを null にすると、冪等性チェックが「既存チケットなし」と
  // 誤判定してチケットを重複作成してしまう — このチェック自体の存在理由を壊す
  // (レビュー指摘の blocker 相当)。空配列 (該当なし) だけを null として扱う。
  if (!Array.isArray(parsed)) {
    throw new BdError(
      'unknown',
      rootPath,
      `unexpected bd list output shape while checking for an existing ${label} ticket`,
    );
  }
  if (parsed.length === 0) {
    return null;
  }

  const result = bdListLabelItemSchema.safeParse(parsed[0]);
  if (!result.success) {
    throw new BdError(
      'unknown',
      rootPath,
      `bd list output missing id/title while checking for an existing ${label} ticket`,
    );
  }

  return {
    id: result.data.id,
    title: result.data.title,
    metadata: result.data.metadata ?? {},
  };
}
