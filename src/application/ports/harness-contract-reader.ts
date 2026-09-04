/**
 * 注入先プロジェクトの検証コントラクト (`.claude/bdboard-harness.json`) と、
 * `verify` が指す package.json の scripts を読むポート。
 *
 * どちらも「読めなければ null」で、例外は投げない。ここでの読み取り失敗は
 * ハーネス状態の表示を諦める理由にはなるが、ボード全体を落とす理由ではない。
 */
export interface HarnessContractReaderPort {
  /** `<projectRootPath>/.claude/bdboard-harness.json` の本文。無い/読めないときは null。 */
  readContract(projectRootPath: string): Promise<string | null>;
  /**
   * `<packageRootPath>/package.json` の scripts キー一覧。
   *
   * `scripts` が無い package.json は空配列 (= 「その script は無い」と判定できる)、
   * package.json 自体が無い/壊れているときだけ null (= 判定できない) を返す。
   * 引数はプロジェクトルートとは限らない — `npm --prefix web run x` のような
   * コントラクトでは、その `web/` を渡して解決する。
   */
  readPackageScripts(packageRootPath: string): Promise<readonly string[] | null>;
}
