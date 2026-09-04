import type { VerifyPackageScripts } from '../../domain/harness-contract.js';

/**
 * 注入先プロジェクトの検証コントラクト (`.claude/bdboard-harness.json`) と、
 * `verify` が指す package.json の scripts を読むポート。
 *
 * 例外は投げない。ここでの読み取り失敗はハーネス状態の表示を諦める理由には
 * なるが、ボード全体を落とす理由ではない。
 */
export interface HarnessContractReaderPort {
  /** `<projectRootPath>/.claude/bdboard-harness.json` の本文。無い/読めないときは null。 */
  readContract(projectRootPath: string): Promise<string | null>;
  /**
   * `<packageRootPath>/package.json` の scripts の状態。
   *
   * 「存在しない (`'absent'`)」と「存在するが読めない (`null`)」を区別して返すこと —
   * 前者は `npm run <script>` が確実に失敗するので警告に倒せるが、後者は判定不能で
   * 警告してはいけない。`scripts` キーが無い package.json は空配列を返す
   * (「その script は無い」と判定できるため)。
   *
   * 引数はプロジェクトルートとは限らない — `npm --prefix web run x` のような
   * コントラクトでは、その `web/` を渡して解決する。
   */
  readPackageScripts(packageRootPath: string): Promise<VerifyPackageScripts>;
}
