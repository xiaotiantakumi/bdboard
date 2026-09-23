import { z } from 'zod';
import { isValidBdTicketId } from '../../../domain/chat.js';

/**
 * bdboard-sso1.71: repo-tool-catalog.ts のモジュール分割で切り出した、入力検証用の
 * zod スキーマ群。./args-builder.ts の buildRepoToolArgs() からのみ使う内部実装で、
 * バレル (../repo-tool-catalog.ts) からは re-export しない。
 */

const CONTROL_CHAR_PATTERN = /[\u0000-\u001f\u007f]/;

/**
 * 対象 ref。既定は origin/main だが、既定ブランチが master のリポジトリでも
 * 使えるように差し替えを許す。範囲指定(`a..b`)や先頭のハイフン(オプションに
 * 化ける)は弾き、「単一の ref 名」だけを通す。
 */
const REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;

const refSchema = z
  .string()
  .refine((value) => REF_PATTERN.test(value) && !value.includes('..'), {
    message: 'invalid ref',
  });

const ticketIdSchema = z.string().refine(isValidBdTicketId, {
  message: 'invalid ticket id',
});

/**
 * パス検索語。git には渡さず、ls-tree の出力をこちら側で絞り込むためだけに
 * 使うので、コマンドライン上の危険性は無い。制御文字と長さだけを見る。
 */
const pathPatternSchema = z
  .string()
  .min(1, 'pattern must not be empty')
  .max(200, 'pattern too long')
  .refine((value) => !CONTROL_CHAR_PATTERN.test(value), {
    message: 'unsafe pattern',
  });

export const repoTicketLandedSchema = z
  .object({
    ticketId: ticketIdSchema,
    ref: refSchema.optional(),
  })
  .strict();

export const repoPathExistsSchema = z
  .object({
    pattern: pathPatternSchema,
    ref: refSchema.optional(),
  })
  .strict();
