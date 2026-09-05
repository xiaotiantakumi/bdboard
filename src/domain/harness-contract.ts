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

/**
 * モデル振り分け表の複雑度。**`low` / `med` / `high` の 3 段で固定**し、
 * 注入先プロジェクトに増やさせない。
 *
 * 委譲先の aimix が受け取る `--complexity` が 1 次元の enum (既定 `med`) なので、
 * ここを可変にすると「bdboard 側では宣言できるが渡す先が無い」複雑度が作れて
 * しまう。両側の対応が取れる範囲に閉じておく (bdboard-p5l.13)。
 */
export type HarnessModelComplexity = 'low' | 'med' | 'high';

/** parseModelCandidates が検証した member:model。未検証の文字列とは区別する。 */
export type HarnessModelCandidate = string & {
  readonly __harnessModelCandidate: unique symbol;
};

export const HARNESS_MODEL_COMPLEXITIES: readonly HarnessModelComplexity[] = [
  'low',
  'med',
  'high',
];

/** 3 段まとめて 1 本の候補列にするワイルドカードキー。 */
export const HARNESS_MODEL_WILDCARD = '*';

/** 1 つの stage に書ける複雑度キー。 */
export type HarnessModelComplexityKey =
  | HarnessModelComplexity
  | typeof HARNESS_MODEL_WILDCARD;

/**
 * 1 工程 (stage) の振り分け。
 *
 * `*` は「3 段まとめて同じ候補列」の宣言で、個別キーが並んでいればそちらが勝つ。
 * パースの時点で 3 段すべてを解決済みにしておくのは、参照側 (後続チケット) に
 * 「まず個別キーを見て、無ければ `*` に落ちる」フォールバックを再実装させない
 * ため。`*` が無い stage は 3 段すべての宣言を必須にしているので、穴は開かない。
 */
export interface HarnessModelStageRoute {
  readonly stage: string;
  /** 宣言に現れた複雑度キー。UI に出す宣言段数で、`*` 一本は共通扱いになる。 */
  readonly declaredKeys: readonly HarnessModelComplexityKey[];
  readonly low: readonly HarnessModelCandidate[];
  readonly med: readonly HarnessModelCandidate[];
  readonly high: readonly HarnessModelCandidate[];
}

export interface HarnessContractModels {
  readonly routes: readonly HarnessModelStageRoute[];
}

/**
 * UI へ出す要約。**生の候補列は載せない** — 表示に要らないうえ、注入先由来の
 * 文字列を DTO へ広げる理由が無い (`models` の値は run プロンプトにも載せない)。
 */
export interface HarnessModelStageSummary {
  readonly stage: string;
  /** 宣言された複雑度キーの数。`*` 一本なら 1、low/med/high なら 3。 */
  readonly tiers: number;
}

export interface HarnessContract {
  readonly version: typeof HARNESS_CONTRACT_VERSION;
  /** そのプロジェクトのフル検証コマンド。exit 0 が合格、以上の意味は持たせない。 */
  readonly verify: string;
  readonly prFlow: HarnessPrFlow;
  readonly mainBranch: string;
  readonly hooks: HarnessContractHooks | null;
  /** 工程 × 複雑度のモデル振り分け表。未宣言なら null (従来どおりの挙動)。 */
  readonly models: HarnessContractModels | null;
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
      /** `models` の要約。未宣言なら null。生の候補列はここに出さない。 */
      readonly models: readonly HarnessModelStageSummary[] | null;
    }
  | { readonly state: 'missing' }
  | { readonly state: 'invalid'; readonly message: string }
  | {
      readonly state: 'command-missing';
      readonly script: string;
      readonly verify: string;
    }
  | { readonly state: 'not-applicable' };

/**
 * `verify` が指す package.json の scripts の状態。
 *
 * - `readonly string[]` — 読めた。中身がそのまま script 名の一覧 (`scripts` キーが
 *   無い package.json は空配列 = 「その script は無い」と判定できる)。
 * - `'absent'` — package.json 自体が存在しない。`npm run <script>` は確実に失敗するので
 *   `command-missing` に倒す。
 * - `null` — 存在はするが読めない/壊れている。**判定不能**なので警告しない。
 *
 * 「無い」と「読めない」を分けるのがこの型の全部で、両方 null にすると
 * package.json ごと存在しないプロジェクトの誤宣言を見逃す (PR#282 レビュー minor-1)。
 */
export type VerifyPackageScripts = readonly string[] | 'absent' | null;

export interface HarnessProjectFacts {
  readonly verifyPackageScripts: VerifyPackageScripts;
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

/**
 * 各パターンが JS の正規表現として成立するかを確かめる。
 *
 * これを通しておかないと、壊れたパターンは hook スクリプト (P1a) が読み込んだ
 * 実行時にしか露見しない — つまり「ガードが黙って効いていない」状態になる。
 * コントラクトを読んだ時点で `invalid` として出すほうが早く気付ける。
 */
function findInvalidRegexMessage(patterns: readonly string[]): string | null {
  for (const [index, pattern] of patterns.entries()) {
    try {
      new RegExp(pattern);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return `hooks.denyBashPatterns[${index}] が正規表現として不正です: ${detail}`;
    }
  }
  return null;
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

  const invalidRegex = findInvalidRegexMessage(patterns.value);
  if (invalidRegex !== null) {
    return { ok: false, message: invalidRegex };
  }

  const messages = parseStringArray(value.denyBashMessages, 'hooks.denyBashMessages');
  if (!messages.ok) {
    return { ok: false, message: messages.message };
  }

  // メッセージはパターンと1対1で対応させる (省略して既定文言に任せるなら空)。
  // 本数がずれた配列は、どのパターンにどのメッセージが付くのかが決まらない
  // ため、hook 側で黙って取り違えるより読み込み時点で弾く。
  if (
    messages.value.length !== 0 &&
    messages.value.length !== patterns.value.length
  ) {
    return {
      ok: false,
      message:
        `hooks.denyBashMessages は空か、denyBashPatterns と同数 (${patterns.value.length} 件) である必要があります ` +
        `(受領: ${messages.value.length} 件)`,
    };
  }

  return {
    ok: true,
    hooks: { denyBashPatterns: patterns.value, denyBashMessages: messages.value },
  };
}

const MODEL_STAGE_KEY_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const MODEL_STAGE_MAX_COUNT = 16;
const MODEL_CANDIDATES_MIN = 1;
const MODEL_CANDIDATES_MAX = 6;

/**
 * 候補 (`member:model`) の文字集合。**この正規表現が唯一かつ十分な注入防御**。
 *
 * 空白・引用符・`$`・バッククォート・`(`・改行が構造的に入らないので、通過した
 * 文字列をそのままコマンドラインへ渡してもシェルのメタ文字は発生しない。
 * 後段でサニタイズやクォート処理を重ねないこと — 二重防御にすると「どちらが
 * 本当のガードか」が曖昧になり、片方を緩めたときに気付けなくなる。
 * 長さも member 16 + `:` + model 64 = 最大 81 文字に閉じており、`verify` /
 * `mainBranch` に掛けている `isSafeSingleLineValue` (制御文字禁止・200 文字)
 * より厳しい。
 */
const MODEL_CANDIDATE_PATTERN =
  /^(claude|[a-z][a-z0-9-]{0,15}):[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
// `claude` は後続の `[a-z]…` に包含されており冗長だが、設計ドキュメントおよび T2/T3/T8 の
// チケット本文と表記を一致させるために残している。実際の特別扱いは下の `CLAUDE_MODEL_NAMES` の閉集合チェック。

/**
 * `claude:` の model 部だけは閉集合で見る。bdboard 自身が起動するモデルなので
 * 存在を知っているし、typo をここで落とせる。**他の member は構文しか見ない** —
 * モデルの存在の正本は実行する CLI 自身であり、bdboard が端末固有の設定
 * (`~/.agent/skills/ai-mix/council.json` 等) を読みに行くのは層の逆依存になる。
 */
const CLAUDE_MODEL_NAMES: ReadonlySet<string> = new Set([
  'haiku',
  'sonnet',
  'opus',
  'fable',
]);

const CONTRACT_ECHO_MAX_LENGTH = 40;

/**
 * 不正値をエラーメッセージへ引用するときの整形。
 *
 * コントラクトは信頼できない入力なので、生のまま連結しない。`JSON.stringify` は
 * 制御文字と引用符をエスケープするため、改行入りの値でもメッセージは 1 行に
 * 収まる (このメッセージは Hygiene のツールチップと preflight の detail に出る)。
 */
function describeContractValue(value: string): string {
  const clipped =
    value.length > CONTRACT_ECHO_MAX_LENGTH
      ? `${value.slice(0, CONTRACT_ECHO_MAX_LENGTH)}…`
      : value;
  return JSON.stringify(clipped);
}

function isModelComplexityKey(key: string): key is HarnessModelComplexityKey {
  return (
    key === HARNESS_MODEL_WILDCARD ||
    (HARNESS_MODEL_COMPLEXITIES as readonly string[]).includes(key)
  );
}

type CandidatesParseResult =
  | { readonly ok: true; readonly value: readonly HarnessModelCandidate[] }
  | { readonly ok: false; readonly message: string };

function parseModelCandidates(value: unknown, fieldName: string): CandidatesParseResult {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    return { ok: false, message: `${fieldName} は文字列の配列である必要があります` };
  }

  const candidates = value as readonly string[];
  if (
    candidates.length < MODEL_CANDIDATES_MIN ||
    candidates.length > MODEL_CANDIDATES_MAX
  ) {
    return {
      ok: false,
      message:
        `${fieldName} の候補は ${MODEL_CANDIDATES_MIN}〜${MODEL_CANDIDATES_MAX} 個である必要があります ` +
        `(受領: ${candidates.length} 個)`,
    };
  }

  const seen = new Set<string>();
  const validated: HarnessModelCandidate[] = [];
  for (const [index, candidate] of candidates.entries()) {
    if (!MODEL_CANDIDATE_PATTERN.test(candidate)) {
      return {
        ok: false,
        message:
          `${fieldName}[${index}] は member:model 形式 (member は英小文字始まり 16 文字以内、` +
          `model は英数字始まりで . _ - のみ 64 文字以内) である必要があります ` +
          `(受領: ${describeContractValue(candidate)})`,
      };
    }

    const separator = candidate.indexOf(':');
    const member = candidate.slice(0, separator);
    const model = candidate.slice(separator + 1);
    if (member === 'claude' && !CLAUDE_MODEL_NAMES.has(model)) {
      return {
        ok: false,
        message:
          `${fieldName}[${index}] の claude: のモデルは haiku / sonnet / opus / fable のいずれかである必要があります ` +
          `(受領: ${describeContractValue(candidate)})`,
      };
    }

    if (seen.has(candidate)) {
      return {
        ok: false,
        message: `${fieldName} に同じ候補が 2 回あります: ${describeContractValue(candidate)}`,
      };
    }
    seen.add(candidate);
    // ブランド生成はこの検証境界だけ。後段で未検証の文字列をキャストしない。
    validated.push(candidate as HarnessModelCandidate);
  }

  return { ok: true, value: validated };
}

type StageRouteParseResult =
  | { readonly ok: true; readonly route: HarnessModelStageRoute }
  | { readonly ok: false; readonly message: string };

function parseModelStageRoute(stage: string, value: unknown): StageRouteParseResult {
  const field = `models.routes.${stage}`;
  if (!isPlainObject(value)) {
    return { ok: false, message: `${field} はオブジェクトである必要があります` };
  }

  const cells = new Map<HarnessModelComplexityKey, readonly HarnessModelCandidate[]>();
  const declaredKeys: HarnessModelComplexityKey[] = [];

  for (const key of Object.keys(value)) {
    if (!isModelComplexityKey(key)) {
      return {
        ok: false,
        message:
          `${field} のキー ${describeContractValue(key)} は low / med / high / * のいずれかである必要があります ` +
          '(複雑度は 3 段固定で、増やせません)',
      };
    }

    const cell = parseModelCandidates(value[key], `${field}.${key}`);
    if (!cell.ok) {
      return { ok: false, message: cell.message };
    }
    cells.set(key, cell.value);
    declaredKeys.push(key);
  }

  if (declaredKeys.length === 0) {
    return {
      ok: false,
      message: `${field} は low / med / high / * のいずれかを 1 つ以上宣言する必要があります`,
    };
  }

  // `*` はあくまで既定値で、個別キーがあればそちらが勝つ。`*` が無いなら
  // 3 段すべてを要求する — 片段だけ宣言された表は、参照側が黙って何も選べない
  // 穴になる。
  const fallback = cells.get(HARNESS_MODEL_WILDCARD);
  const low = cells.get('low') ?? fallback;
  const med = cells.get('med') ?? fallback;
  const high = cells.get('high') ?? fallback;
  if (low === undefined || med === undefined || high === undefined) {
    const missing = HARNESS_MODEL_COMPLEXITIES.filter(
      (complexity) => cells.get(complexity) === undefined,
    );
    return {
      ok: false,
      message:
        `${field} は * を宣言しない場合 low / med / high をすべて宣言する必要があります ` +
        `(不足: ${missing.join(' / ')})`,
    };
  }

  return { ok: true, route: { stage, declaredKeys, low, med, high } };
}

type ModelsParseResult =
  | { readonly ok: true; readonly models: HarnessContractModels | null }
  | { readonly ok: false; readonly message: string };

/**
 * `models` 節。**省略可**で、無ければ `null` = 従来とまったく同じ挙動。
 *
 * この節を足しても `version` は 1 のまま上げない。パーサが未知キーを無視する
 * 前方互換方針なので、新しい契約を旧 bdboard が読んでも Hygiene は赤くならず、
 * 逆に `models` の無い既存プロジェクトも新 bdboard でそのまま ok になる。
 */
function parseModels(value: unknown): ModelsParseResult {
  if (value === undefined) {
    return { ok: true, models: null };
  }
  if (!isPlainObject(value)) {
    return { ok: false, message: 'models はオブジェクトである必要があります' };
  }

  const routesValue = value.routes;
  if (routesValue === undefined) {
    return { ok: false, message: 'models には routes が必要です' };
  }
  if (!isPlainObject(routesValue)) {
    return { ok: false, message: 'models.routes はオブジェクトである必要があります' };
  }

  const stages = Object.keys(routesValue);
  if (stages.length === 0) {
    return {
      ok: false,
      message: 'models.routes を空にはできません（工程を 1 つ以上宣言してください）',
    };
  }
  if (stages.length > MODEL_STAGE_MAX_COUNT) {
    return {
      ok: false,
      message:
        `models.routes の工程は 1〜${MODEL_STAGE_MAX_COUNT} 個である必要があります ` +
        `(受領: ${stages.length} 個)`,
    };
  }

  const routes: HarnessModelStageRoute[] = [];
  for (const stage of stages) {
    if (!MODEL_STAGE_KEY_PATTERN.test(stage)) {
      return {
        ok: false,
        message:
          `models.routes のキー ${describeContractValue(stage)} は工程名の形式 ` +
          '(英小文字で始まる 32 文字以内の英小文字・数字・ハイフン) である必要があります',
      };
    }

    const route = parseModelStageRoute(stage, routesValue[stage]);
    if (!route.ok) {
      return { ok: false, message: route.message };
    }
    routes.push(route.route);
  }

  return { ok: true, models: { routes } };
}

/** 表示用の要約へ落とす。候補そのものは UI へ流さない。 */
export function summarizeHarnessModels(
  models: HarnessContractModels | null,
): readonly HarnessModelStageSummary[] | null {
  if (models === null) {
    return null;
  }
  return models.routes.map((route) => ({
    stage: route.stage,
    tiers: route.declaredKeys.length,
  }));
}

const CONTRACT_TEXT_MAX_LENGTH = 200;

/**
 * 制御文字を含まず 200 文字以内か。
 *
 * `verify` / `mainBranch` は注入先のプロジェクトが書くファイル由来の**信頼できない
 * 入力**でありながら、run プロンプト (`buildRunPrompt`) と UI のコピー用シェル行
 * (`cd <worktree> && <verify>`) にそのまま埋まる。改行を通すとプロンプトへ任意の
 * 行を注入できてしまうため、ここで弾いて preflight に `harness-contract-invalid`
 * として止めさせる (bdboard-pkr6.11 レビュー指摘)。
 */
function isSafeSingleLineValue(value: string): boolean {
  if (value.length > CONTRACT_TEXT_MAX_LENGTH) {
    return false;
  }
  // eslint-disable-next-line no-control-regex
  return !/[\u0000-\u001f\u007f]/.test(value);
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

  if (!isSafeSingleLineValue(parsed.verify)) {
    return schemaFailure('verify に改行・制御文字は使えません (200 文字以内)');
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
    if (!isSafeSingleLineValue(parsed.mainBranch)) {
      return schemaFailure('mainBranch に改行・制御文字は使えません (200 文字以内)');
    }
    mainBranch = parsed.mainBranch.trim();
  }

  const hooks = parseHooks(parsed.hooks);
  if (!hooks.ok) {
    return schemaFailure(hooks.message);
  }

  const models = parseModels(parsed.models);
  if (!models.ok) {
    return schemaFailure(models.message);
  }

  return {
    ok: true,
    contract: {
      version: HARNESS_CONTRACT_VERSION,
      verify: parsed.verify.trim(),
      prFlow: prFlow as HarnessPrFlow,
      mainBranch,
      hooks: hooks.hooks,
      models: models.models,
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

  if (requirement !== null && scripts !== null) {
    const commandMissing =
      scripts === 'absent' || !scripts.includes(requirement.script);
    if (commandMissing) {
      return {
        state: 'command-missing',
        script: requirement.script,
        verify: contract.verify,
      };
    }
  }

  return {
    state: 'ok',
    verify: contract.verify,
    prFlow: contract.prFlow,
    mainBranch: contract.mainBranch,
    models: summarizeHarnessModels(contract.models),
  };
}
