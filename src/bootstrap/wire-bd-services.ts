/**
 * bdboard-sso1.14: src/main.ts (composition root) から bd/gh CLI 経由の各種
 * ポート実装の組み立てを切り出したもの (move only, 挙動変更ゼロ)。
 *
 * `inner` (routes.ts の buildApiDeps) をはじめ、harness routes / agent-run
 * routes など複数の領域から共有される「bd 台帳・gh PR ステータス・git
 * worktree 走査」まわりの下位ポート群をまとめて組み立てる。ここに置くのは
 * 単純な `createXxx(commandRunner, options)` の呼び出しだけで、mount 順や
 * 起動時副作用は持たない。
 */
import type { CommandRunner } from '../application/ports/command-runner.js';
import {
  createBdCliCommentReader,
  createBdCliDependencyWriter,
  createBdCliHumanDecisions,
  createBdCliIssueRepository,
  createBdCliIssueWriter,
  createBdCliLeaseReader,
  createBdCliLeaseReclaimer,
  createBdCliMergeSlotReader,
  createBdCliSessionLinkWriter,
  createGhCliPrStatusReader,
  createGitWorktreeScanner,
} from '../infrastructure/index.js';

export interface WireBdServicesOptions {
  readonly bdPath: string;
  readonly ghPath: string;
}

export function wireBdServices(commandRunner: CommandRunner, options: WireBdServicesOptions) {
  const { bdPath, ghPath } = options;

  return {
    repository: createBdCliIssueRepository(commandRunner, { bdPath }),
    leaseReader: createBdCliLeaseReader(commandRunner, { bdPath }),
    mergeSlotReader: createBdCliMergeSlotReader(commandRunner, { bdPath }),
    leaseReclaimer: createBdCliLeaseReclaimer(commandRunner, { bdPath }),
    commentReader: createBdCliCommentReader(commandRunner),
    prStatusReader: createGhCliPrStatusReader(commandRunner, { ghPath }),
    humanDecisions: createBdCliHumanDecisions(commandRunner),
    worktreeScanner: createGitWorktreeScanner(commandRunner),
    issueWriter: createBdCliIssueWriter(commandRunner),
    dependencyWriter: createBdCliDependencyWriter(commandRunner),
    sessionLinkWriter: createBdCliSessionLinkWriter(commandRunner),
  };
}

export type BdServices = ReturnType<typeof wireBdServices>;
