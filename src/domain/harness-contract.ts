import { normalizeProjectRelativePath } from './harness-path.js';

/**
 * 注入先プロジェクトが宣言する「検証コントラクト」。
 *
 * bdboard 自身には `npm run verify` → PR → CI → merge-slot/CAS → main で再 verify
 * という強いフィードバックループがあるが、パックを注入した他プロジェクトでは
 * 「プロジェクト規約の検証コマンド」を CLAUDE.md から探せと言うだけで、無ければ
 * 何も起きない。注入先にこのファイルを置かせ、無ければ Hygiene に
 * 「検証ループ未定義」を出して可視化する (bdboard-pkr6.3)。
 *
 * `.claude/` 配下に置くのは、注入 API のパストラバーサルガード
 * `resolveUnderClaudeDir` の内側に収めるため。
 */
export const HARNESS_CONTRACT_RELATIVE_PATH = '.claude/bdboard-harness.json';

/** 現在サポートするコントラクトのバージョン。将来の破壊的変更でだけ上げる。 */
export const HARNESS_CONTRACT_VERSION = 1;

/** 既定のメインブランチ名 (`mainBranch` 省略時)。 */
export const DEFAULT_MAIN_BRANCH = 'main';

/** そのプロジェクトの git 運用。`pr` = PR 必須 / `direct` = main 直コミット可 / `none` = git 運用なし。 */
export type HarnessPrFlow = 'pr' | 'direct' | 'none';

export const HARNESS_PR_FLOWS: readonly HarnessPrFlow[] = ['pr', 'direct', 'none'];

/**
 * P1a の pre-bash-guard が読む、プロジェクト固有の禁止パターン。
 * ここでは型とバリデーションだけを持ち、hook 側の解釈には踏み込まない。
 */
export interface HarnessContractHooks {
  readonly denyBashPatterns: readonly string[];
  readonly denyBashMessages: readonly string[];
}

export interface HarnessContract {
  readonly version: typeof HARNESS_CONTRACT_VERSION;
  /** そのプロジェクトのフル検証コマンド。exit 0 が合格、以上の意味は持たせない。 */
  readonly verify: string;
  readonly prFlow: HarnessPrFlow;
  readonly mainBranch: string;
  readonly hooks: HarnessContractHooks | null;
}

export type HarnessContractParseFailureReason = 'invalid-json' | 'schema';

export type ParseHarnessContractResult =
  | { readonly ok: true; readonly contract: HarnessContract }
  | {
      readonly ok: false;
      readonly reason: HarnessContractParseFailureReason;
      readonly message: string;
    };

/**
 * 注入先プロジェクトの検証コントラクトの状態。
 *
 * `not-applicable` は「そもそもパックが注入されていないので問うていない」。
 * 未注入プロジェクトに一斉に警告を出さないための状態で、UI には何も出さない。
 */
export type ContractState =
  | {
      readonly state: 'ok';
      readonly verify: string;
      readonly prFlow: HarnessPrFlow;
      readonly mainBranch: string;
    }
  | { readonly state: 'missing' }
  | { readonly state: 'invalid'; readonly message: string }
  | {
      readonly state: 'command-missing';
      readonly script: string;
      readonly verify: string;
    }
  | { readonly state: 'not-applicable' };

export interface HarnessProjectFacts {
  /**
   * `verify` が指す package.json の scripts キー一覧。
   * package.json を読めない (= 判定できない) ときは null で、そのときは検査しない。
   */
  readonly verifyPackageScripts: readonly string[] | null;
}

function schemaFailure(message: string): ParseHarnessContractResult {
  return { ok: false, reason: 'schema', message };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseStringArray(
  value: unknown,
  fieldName: string,
): { readonly ok: true; readonly value: readonly string[] } | { readonly ok: false; readonly message: string } {
  if (value === undefined) {
    return { ok: true, value: [] };
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    return { ok: false, message: `${fieldName} は文字列の配列である必要があります` };
  }
  return { ok: true, value: value as readonly string[] };
}

function parseHooks(
  value: unknown,
): { readonly ok: true; readonly hooks: HarnessContractHooks | null } | { readonly ok: false; readonly message: string } {
  if (value === undefined) {
    return { ok: true, hooks: null };
  }
  if (!isPlainObject(value)) {
    return { ok: false, message: 'hooks はオブジェクトである必要があります' };
  }

  const patterns = parseStringArray(value.denyBashPatterns, 'hooks.denyBashPatterns');
  if (!patterns.ok) {
    return { ok: false, message: patterns.message };
  }
  const messages = parseStringArray(value.denyBashMessages, 'hooks.denyBashMessages');
  if (!messages.ok) {
    return { ok: false, message: messages.message };
  }

  return {
    ok: true,
    hooks: { denyBashPatterns: patterns.value, denyBashMessages: messages.value },
  };
}

/**
 * `.claude/bdboard-harness.json` の本文を検証コントラクトへ変換する。
 *
 * 未知キーはエラーにせず無視する (前方互換)。判定できたものだけを厳しく見る、
 * という方針: この JSON を書くのは注入先のユーザーで、bdboard の新機能が増える
 * たびに既存プロジェクトの Hygiene が赤くなるのは望ましくない。
 */
export function parseHarnessContract(text: string): ParseHarnessContractResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'invalid-json', message: 'JSON として解釈できません' };
  }

  if (!isPlainObject(parsed)) {
    return schemaFailure('トップレベルはオブジェクトである必要があります');
  }

  if (parsed.version !== HARNESS_CONTRACT_VERSION) {
    return schemaFailure(
      `version は ${HARNESS_CONTRACT_VERSION} のみ対応です (受領: ${JSON.stringify(parsed.version)})`,
    );
  }

  if (typeof parsed.verify !== 'string' || parsed.verify.trim().length === 0) {
    return schemaFailure('verify は空でない文字列である必要があります');
  }

  const prFlow = parsed.prFlow;
  if (
    typeof prFlow !== 'string' ||
    !HARNESS_PR_FLOWS.includes(prFlow as HarnessPrFlow)
  ) {
    return schemaFailure('prFlow は pr / direct / none のいずれかである必要があります');
  }

  let mainBranch = DEFAULT_MAIN_BRANCH;
  if (parsed.mainBranch !== undefined) {
    if (typeof parsed.mainBranch !== 'string' || parsed.mainBranch.trim().length === 0) {
      return schemaFailure('mainBranch は空でない文字列である必要があります');
    }
    mainBranch = parsed.mainBranch.trim();
  }

  const hooks = parseHooks(parsed.hooks);
  if (!hooks.ok) {
    return schemaFailure(hooks.message);
  }

  return {
    ok: true,
    contract: {
      version: HARNESS_CONTRACT_VERSION,
      verify: parsed.verify.trim(),
      prFlow: prFlow as HarnessPrFlow,
      mainBranch,
      hooks: hooks.hooks,
    },
  };
}

/** `verify` が npm 系の run コマンドだったときの、実体を探す先。 */
export interface VerifyScriptRequirement {
  /** プロジェクトルートからの相対ディレクトリ (POSIX)。ルート直下なら `.`。 */
  readonly packageDir: string;
  /** package.json の scripts に存在すべきキー。 */
  readonly script: string;
}

const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn']);
const DIR_FLAGS = new Set(['--prefix', '--dir', '--cwd', '-C']);
/** シェルの合成が入った時点で「1本のスクリプト起動」ではないので検査を諦める。 */
const SHELL_METACHARACTERS = /[|&;<>$`'"()]/;

/**
 * `verify` から「注入先の package.json に存在すべき npm script」を割り出す。
 *
 * 検出できるのは `npm run <script>` / `npm --prefix <dir> run <script>` /
 * `pnpm run` / `yarn run` の形だけ。`make verify` や `python -c "..."` のような
 * 形はコマンド実体を検査しない (null) — 検証コマンドの実在確認は「安く確実に
 * できる範囲だけやる」のが方針で、任意コマンドの存在確認は範囲外。
 */
export function resolveVerifyScriptRequirement(
  verify: string,
): VerifyScriptRequirement | null {
  if (SHELL_METACHARACTERS.test(verify)) {
    return null;
  }

  const tokens = verify.trim().split(/\s+/).filter((token) => token.length > 0);
  if (tokens.length === 0 || !PACKAGE_MANAGERS.has(tokens[0]!)) {
    return null;
  }

  let index = 1;
  let packageDir = '.';

  while (index < tokens.length) {
    const token = tokens[index]!;
    if (DIR_FLAGS.has(token)) {
      const value = tokens[index + 1];
      if (value === undefined) {
        return null;
      }
      packageDir = value;
      index += 2;
      continue;
    }

    const inlineDir = /^(--prefix|--dir|--cwd)=(.+)$/.exec(token);
    if (inlineDir !== null) {
      packageDir = inlineDir[2]!;
      index += 1;
      continue;
    }

    break;
  }

  if (tokens[index] !== 'run') {
    return null;
  }

  const script = tokens[index + 1];
  if (script === undefined || script.startsWith('-')) {
    return null;
  }

  if (packageDir === '.' || packageDir === './') {
    return { packageDir: '.', script };
  }

  // プロジェクト外を指す prefix は「検査しない」に倒す。注入先の任意の JSON から
  // 読み出したパスなので、注入 API と同じくルート脱出は素通りさせない。
  const normalized = normalizeProjectRelativePath(packageDir);
  if (normalized === null) {
    return null;
  }

  return { packageDir: normalized, script };
}

/**
 * パース結果とプロジェクトの事実から表示用の状態を作る。
 * `parsed` が null は「ファイルが無い」。
 */
export function evaluateContractState(
  parsed: ParseHarnessContractResult | null,
  projectFacts: HarnessProjectFacts,
): ContractState {
  if (parsed === null) {
    return { state: 'missing' };
  }

  if (!parsed.ok) {
    return { state: 'invalid', message: parsed.message };
  }

  const { contract } = parsed;
  const requirement = resolveVerifyScriptRequirement(contract.verify);
  const scripts = projectFacts.verifyPackageScripts;

  if (requirement !== null && scripts !== null && !scripts.includes(requirement.script)) {
    return {
      state: 'command-missing',
      script: requirement.script,
      verify: contract.verify,
    };
  }

  return {
    state: 'ok',
    verify: contract.verify,
    prFlow: contract.prFlow,
    mainBranch: contract.mainBranch,
  };
}
