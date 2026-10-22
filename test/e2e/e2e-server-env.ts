import path from 'node:path';

/**
 * e2e のサーバー (test/e2e/global-setup.ts が起動する src/main.ts) に渡す環境変数を組み立てる。
 *
 * global-setup.ts から切り出したのは、「このサーバーは本物の gh を起動しない」(bdboard-em45)・「本物の下書きの置き場に
 * 書かない」(bdboard-xpkz) のように、env が満たすべき性質を e2e を回さずに vitest (e2e-server-env.test.ts) で固定するため。
 * 値の意味と理由のコメントは、すべてここにある (切り出した時点では global-setup.ts から動かしただけで、値は変えていない)。
 */
export interface E2eServerEnvInputs {
  /** 親プロセスの env (通常は process.env)。ここへ下の値を上書きして渡す。 */
  readonly baseEnv: NodeJS.ProcessEnv;
  readonly port: string;
  readonly host: string;
  readonly dbPath: string;
  /** スキャン対象のプロジェクトのルート (使い捨てディレクトリ)。 */
  readonly scanRoots: readonly string[];
  readonly scanRootsConfigPath: string;
  /** bd / claude の stub を置いたディレクトリ。PATH の先頭に入れる。 */
  readonly binDir: string;
  readonly claudeStub: string;
  readonly listFixture: string;
  readonly webDist: string;
  readonly instanceNonce: string;
}

export function buildE2eServerEnv(inputs: E2eServerEnvInputs): NodeJS.ProcessEnv {
  return {
    ...inputs.baseEnv,
    PATH: `${inputs.binDir}${path.delimiter}${inputs.baseEnv.PATH ?? ''}`,
    BDBOARD_PORT: inputs.port,
    BDBOARD_HOST: inputs.host,
    BDBOARD_DB: inputs.dbPath,
    BDBOARD_SCAN_ROOTS: inputs.scanRoots.join(','),
    // Points the scan-roots user-config store at a throwaway path inside this test's tmp
    // root so the e2e run never reads/writes the developer's real
    // ~/.config/bdboard/config.json (bdboard-3tw.102.2).
    BDBOARD_SCAN_ROOTS_CONFIG_PATH: inputs.scanRootsConfigPath,
    // Auth is explicitly disabled (not "set fake creds and log in") so
    // this fixture never has to hold a username/password-shaped literal.
    BDBOARD_AUTH_DISABLED: '1',
    BDBOARD_AUTH_USER: '',
    BDBOARD_AUTH_PASSWORD: '',
    // Chat stays enabled for chat-mobile e2e; smoke scenarios never open the panel.
    BDBOARD_CLAUDE_PATH: inputs.claudeStub,
    BDBOARD_AI_QUOTA_DISABLED: '1',
    // 自動 reclaim ループを e2e では止める (bd スタブは list 以外を未対応で返すので、
    // 起動のたびに `Reclaim failed ... unsupported subcommand` のログノイズが出る)。
    BDBOARD_RECLAIM_ENABLED: '0',
    BDBOARD_E2E_BD_LIST_FIXTURE: inputs.listFixture,
    BDBOARD_WEB_DIST: inputs.webDist,
    // per-run nonce: waitForHealth が同一ポートの他人サーバーと自分の子を区別する (bdboard-aokz)
    BDBOARD_INSTANCE_NONCE: inputs.instanceNonce,
  };
}
