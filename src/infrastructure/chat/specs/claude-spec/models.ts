import type { ChatModelOption } from '../../../../application/ports/chat-agent.js';

/**
 * 並び順は「安い方を先頭」にしてある。descriptor.model を設定せず models だけを持つ
 * spec が将来現れると UI の既定は models[0] に落ちるので、先頭が Opus だと黙って
 * 最も高価なモデルが全員の既定になる。先頭は Sonnet で固定しておく。
 */
export interface ClaudeModelWeights {
  readonly sonnet?: number;
  readonly opus?: number;
  readonly haiku?: number;
}

// 相対コストの目安は Opus : Sonnet : Haiku ≈ 5 : 1 : 1。1 未満にしないのは、perMinute/perDay が
// 課金上限であると同時に、公開トンネル経由の CLI 子プロセス起動レートの上限でもあるため
// (chat-routes.ts の agents 非免除コメント参照)。安いモデルの重みを 0.25 にすると、既存の
// 起動レート上限が黙って 4 倍に緩んでしまう。緩めたい運用者は BDBOARD_CHAT_RATE_WEIGHT_HAIKU
// で明示的にオプトインできる。
// (このコメントは元々 chat-rate-limit.ts の DEFAULT_CHAT_RATE_LIMIT_WEIGHTS に付いていたものを、
// 重みの宣言元がここに一元化されたことに合わせて移設した — bdboard-3tw.104.11)
export const DEFAULT_CLAUDE_MODEL_WEIGHTS: Required<ClaudeModelWeights> = {
  sonnet: 1,
  opus: 5,
  haiku: 1,
};

export const DEFAULT_CLAUDE_MODEL_IDS: readonly string[] = ['sonnet', 'opus', 'haiku'] as const;

/**
 * `options.modelWeights` の未指定フィールドを DEFAULT_CLAUDE_MODEL_WEIGHTS で埋めた完全形にする。
 * 重みの既定値適用はこの spec に一元化されている(bdboard-3tw.104.11 Opus レビュー N2)ので、
 * 呼び出し元(chat-agent-registry-builder.ts)は env が未設定/不正なら `undefined` のまま渡してよい
 * — デフォルト値の重複宣言を避けるため、`??` によるフォールバックは必ずここに一本化すること。
 */
export function resolveClaudeModelWeights(weights: ClaudeModelWeights): Required<ClaudeModelWeights> {
  return {
    sonnet: weights.sonnet ?? DEFAULT_CLAUDE_MODEL_WEIGHTS.sonnet,
    opus: weights.opus ?? DEFAULT_CLAUDE_MODEL_WEIGHTS.opus,
    haiku: weights.haiku ?? DEFAULT_CLAUDE_MODEL_WEIGHTS.haiku,
  };
}

export function resolveClaudeModelIds(models: readonly string[] | undefined): readonly string[] {
  return models ?? DEFAULT_CLAUDE_MODEL_IDS;
}

export function buildClaudeChatModels(
  ids: readonly string[],
  weights: Required<ClaudeModelWeights>,
): readonly ChatModelOption[] {
  return ids.map((id) => {
    const normalized = id.toLowerCase();
    if (normalized === 'sonnet') {
      return { id, label: 'Sonnet', weight: weights.sonnet };
    }
    if (normalized === 'opus') {
      return { id, label: 'Opus', weight: weights.opus };
    }
    if (normalized === 'haiku') {
      return { id, label: 'Haiku', weight: weights.haiku };
    }
    return { id, label: id, weight: weightForUnlistedClaudeModel(id, weights) };
  });
}

/**
 * 既定重みのスナップショット(env による上書き前の参照値)。実行時に実際に使われる重みは
 * `createClaudeSpec(...).descriptor.models` を見ること — `BDBOARD_CHAT_RATE_WEIGHT_*` で
 * 上書きされていればこの定数とは値がずれる(bdboard-3tw.104.11 Opus レビュー N1)。
 * 並び順は既存どおり「安い方を先頭」(Sonnet 先頭)を維持すること。
 */
export const CLAUDE_CHAT_MODELS: readonly ChatModelOption[] = buildClaudeChatModels(
  DEFAULT_CLAUDE_MODEL_IDS,
  DEFAULT_CLAUDE_MODEL_WEIGHTS,
);

/**
 * `options.model`(例: BDBOARD_CHAT_MODEL で運用者が指定したカスタムモデル ID)が
 * CLAUDE_CHAT_MODELS の一覧に無い場合の重み推定(bdboard-3tw.104.11 Opus レビュー MF1)。
 *
 * 修正前は normalizeModelList が prepend するエントリに weight を付けておらず、一覧外の
 * 独自 opus 系 ID を既定モデルにしている運用者のリクエストが、宣言なし → chat-routes.ts の
 * default フォールバックに落ちて 5 のはずが 1 で数えられる回帰になっていた(実測確認済み)。
 *
 * ここでの opus/haiku/sonnet 文字列判定は claude 固有の命名規則に基づくもので、この spec の
 * 内側に閉じている。本チケットの趣旨は「重み知識が interface 層と infrastructure 層の 2 箇所に
 * 複製されること」の解消であって、「claude-spec が Claude 自身の命名知識を持つこと」自体は
 * 正当な自己完結性なので許容する。
 */
function weightForUnlistedClaudeModel(id: string, weights: Required<ClaudeModelWeights>): number {
  const normalized = id.toLowerCase();
  if (normalized.includes('opus')) {
    return weights.opus;
  }
  if (normalized.includes('haiku')) {
    return weights.haiku;
  }
  return weights.sonnet;
}

export function normalizeModelList(
  defaultModel: string,
  models: readonly ChatModelOption[],
  weights: Required<ClaudeModelWeights>,
): readonly ChatModelOption[] {
  if (models.some((entry) => entry.id === defaultModel)) {
    return models;
  }
  return [
    { id: defaultModel, label: defaultModel, weight: weightForUnlistedClaudeModel(defaultModel, weights) },
    ...models,
  ];
}
