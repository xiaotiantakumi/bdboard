import { Hono } from 'hono';
import { respondBdError } from './bd-error-response.js';
import { readProjectHarnessStatus } from '../../application/harness/get-project-harness-status.js';
import { fileHarnessContractTicket } from '../../application/harness/file-harness-contract-ticket.js';
import { BdError } from '../../application/ports/issue-repository.js';
import type { HarnessRoutesDeps } from './harness-routes-deps.js';
import { extractProjectIdFromHarnessPath, toContractJson } from './harness-routes-shared.js';

// harness-routes.ts (旧347行) の分割 (bdboard-sso1.56) で、
// POST /api/projects/*/harness/contract-ticket をここへ切り出した (move only,
// 挙動変更ゼロ)。

export interface HarnessContractTicketRoutesParams {
  readonly now: () => Date;
}

export function createHarnessContractTicketRoutes(
  deps: HarnessRoutesDeps,
  { now }: HarnessContractTicketRoutesParams,
): Hono {
  const app = new Hono();

  app.post('/api/projects/*/harness/contract-ticket', async (c) => {
    const projectId = extractProjectIdFromHarnessPath(c.req.path);
    if (projectId === undefined) {
      return c.notFound();
    }

    const cached = deps.cache.getProject(projectId);
    if (cached === undefined) {
      return c.json({ error: 'project not found' }, 404);
    }

    // create/findOpenTicketByLabel/setMetadata は IssueWriterPort 上 optional
    // (issue-writer.ts の doc コメント参照)。addComment は必須。narrow してから
    // ユースケースへ渡す — 呼び出し先で undefined チェックを繰り返させない
    // (bdboard-13mp: state 遷移の追記に setMetadata も要るため narrow 対象に追加)。
    const { create, findOpenTicketByLabel, setMetadata } = deps.issueWriter ?? {};
    const addComment = deps.issueWriter?.addComment;
    if (
      create === undefined ||
      findOpenTicketByLabel === undefined ||
      setMetadata === undefined ||
      addComment === undefined
    ) {
      return c.json({ error: 'ticket creation not supported' }, 501);
    }

    const rootPath = cached.project.rootPath;
    const status = await readProjectHarnessStatus(deps, rootPath, now());

    // 'missing' のときだけ、プロジェクトルートの package.json から verify 候補を
    // 推測する (他の状態は ContractState 自身が必要な情報 (script/verify/message) を
    // 持っている)。
    const rootPackageScripts =
      status.contract.state === 'missing'
        ? await deps.contractReader.readPackageScripts(rootPath)
        : null;

    try {
      const result = await fileHarnessContractTicket(
        { create, findOpenTicketByLabel, addComment, setMetadata },
        rootPath,
        status.contract,
        rootPackageScripts,
      );

      if (!result.ok) {
        return c.json(
          { error: 'contract does not need a ticket', reason: result.reason },
          409,
        );
      }

      // bdboard-13mp: 新規作成だけでなく、既存チケットへのコメント追記/メタデータ
      // 更新 (stateAppend: 'appended') もキャッシュ済みの comment 件数・metadata を
      // 古いままにする書き込みなので、同じくリフレッシュが要る (bdboard-6qs6 と同じ理由 —
      // routes.ts の POST /api/tickets/:id/comment が addComment 後に必ず
      // refreshAfterWrite するのと揃える)。
      if (
        (result.created || result.stateAppend === 'appended') &&
        deps.refreshProjectByRootPath !== undefined
      ) {
        try {
          await deps.refreshProjectByRootPath(rootPath);
        } catch (error: unknown) {
          const detail = error instanceof Error ? error.message : String(error);
          console.error(`post-write refresh failed (rootPath=${rootPath}): ${detail}`);
        }
      }

      return c.json({
        ticketId: result.ticketId,
        created: result.created,
        stateAppend: result.stateAppend,
        // bdboard-13mp: サーバーがこのリクエストで実際に読んだ contract をそのまま返す。
        // フロントは (ポーリングで持っている可能性のある古い) 自分のキャッシュ済み
        // contract ではなく、これを使って「現在の状態」の文言を組み立てる —
        // でないとこのチケット自体が直そうとした「古い状態を表示する」問題が
        // クライアント側に移るだけになる (レビュー指摘)。
        contract: toContractJson(status.contract),
      });
    } catch (error: unknown) {
      if (error instanceof BdError && error.kind === 'not-a-beads-project') {
        // 設計メモ通り: bd 未導入のプロジェクトではボタンを出さない想定だが、
        // discovery が .beads/ を前提にプロジェクトを列挙するため実運用では
        // ほぼ起きない (bdboard-p5l.25 参照)。万一のズレ (削除競合等) はここで
        // 502 に潰さず、明確な理由を返す。
        return c.json(
          { error: 'bd not initialized for this project', detail: error.detail },
          422,
        );
      }
      return respondBdError(c, 'failed to file harness contract ticket', error);
    }
  });

  return app;
}
