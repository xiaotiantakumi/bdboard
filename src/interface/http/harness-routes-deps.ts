import type { BoardCache } from '../../application/ports/board-cache.js';
import type { HarnessContractReaderPort } from '../../application/ports/harness-contract-reader.js';
import type { HarnessInjectorPort } from '../../application/ports/harness-injector.js';
import type { IssueWriterPort } from '../../application/ports/issue-writer.js';
import type { PackRegistryPort } from '../../application/ports/pack-registry.js';
import type { WriteGuardDeps } from './write-guard.js';

// bdboard-tml8: HarnessRoutesDeps を harness-routes.ts から抜き出した専用ファイル。
// harness-status-routes.ts / harness-inject-routes.ts /
// harness-contract-ticket-routes.ts はこの型だけを直接 import する (harness-routes.ts
// 経由にしない)。harness-routes.ts はそれらのファイルの createXxxRoutes を import する
// 側でもあるため、型を harness-routes.ts 経由で参照する形のままだと
// 「harness-routes.ts <-> 各グループ」の型だけの import 循環が dependency-cruiser の
// no-circular に引っかかる (bdboard-tml8 の本題)。harness-routes.ts は引き続き
// `export type { HarnessRoutesDeps } from './harness-routes-deps.js'` で外部向けの
// 公開経路を保つ。

export interface HarnessRoutesDeps {
  readonly cache: BoardCache;
  readonly registry: PackRegistryPort;
  readonly injector: HarnessInjectorPort;
  readonly contractReader: HarnessContractReaderPort;
  readonly now?: () => Date;
  readonly writeAccess?: WriteGuardDeps;
  /**
   * 検証コントラクト不足のチケット起票 (`POST .../harness/contract-ticket`,
   * bdboard-p5l.25) にだけ使う。`create`/`findOpenTicketByLabel`/`setMetadata`
   * (いずれも optional) を持たない実装が渡された場合、そのルートは 501 を返す
   * (bdboard-13mp: state 遷移をまたいだ追記に setMetadata も必須化)。
   */
  readonly issueWriter?: IssueWriterPort;
  /**
   * チケット作成後にそのプロジェクトのキャッシュを強制リフレッシュするフック。
   * routes.ts の refreshAfterWrite と同じ目的・同じ fail-open 方針 (失敗しても
   * 書き込み自体は成功扱い) — 未指定ならリフレッシュしない。
   */
  readonly refreshProjectByRootPath?: (rootPath: string) => Promise<void>;
}
