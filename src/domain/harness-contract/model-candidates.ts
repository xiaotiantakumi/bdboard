// model-routes.ts (models.routes/parseModels) と parse.ts の両方から使われる、
// member:model 候補のパース・表示補助。bdboard-sso1.22: harness-contract.ts の
// モジュール分割で切り出した。
//
// MODEL_STAGE_KEY_PATTERN / MODEL_STAGE_MAX_COUNT / describeContractValue /
// isModelComplexityKey / parseModelCandidates は分割前は同一ファイル内の非公開
// 定数・関数だったが、model-routes.ts からの cross-module import のため export
// している — ただし入口 (harness-contract.ts) の公開エクスポート面には含めない
// (分割前と同じく非公開)。
import {
  HARNESS_MODEL_WILDCARD,
  HARNESS_MODEL_COMPLEXITIES,
} from './types.js';
import type {
  HarnessModelCandidate,
  HarnessModelComplexityKey,
} from './types.js';

export const MODEL_STAGE_KEY_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
export const MODEL_STAGE_MAX_COUNT = 16;
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
export function describeContractValue(value: string): string {
  const clipped =
    value.length > CONTRACT_ECHO_MAX_LENGTH
      ? `${value.slice(0, CONTRACT_ECHO_MAX_LENGTH)}…`
      : value;
  return JSON.stringify(clipped);
}

export function isModelComplexityKey(key: string): key is HarnessModelComplexityKey {
  return (
    key === HARNESS_MODEL_WILDCARD ||
    (HARNESS_MODEL_COMPLEXITIES as readonly string[]).includes(key)
  );
}

type CandidatesParseResult =
  | { readonly ok: true; readonly value: readonly HarnessModelCandidate[] }
  | { readonly ok: false; readonly message: string };

export function parseModelCandidates(value: unknown, fieldName: string): CandidatesParseResult {
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
