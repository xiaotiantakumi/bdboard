import { isPlainObject, isSafeSingleLineValue } from './shared.js';
import { describeContractValue } from './model-candidates.js';
import { HARNESS_MODEL_COMPLEXITIES } from './types.js';
import type { HarnessModelCandidate, HarnessModelExclude, HarnessContractModels } from './types.js';

/** `models.exclude[].member` の文字集合。候補 (`member:model`) の member 部分と同じ。 */
const MODEL_EXCLUDE_MEMBER_PATTERN = /^[a-z][a-z0-9-]{0,15}$/;
const MODEL_EXCLUDE_UNTIL_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
export const MODEL_EXCLUDE_MAX_COUNT = 32;

/** `YYYY-MM-DD` が実在する暦日かを確かめる (例: 2026-02-30 を弾く)。 */
function isValidCalendarDate(dateStr: string): boolean {
  if (!MODEL_EXCLUDE_UNTIL_PATTERN.test(dateStr)) {
    return false;
  }
  const [yearStr, monthStr, dayStr] = dateStr.split('-');
  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);
  if (month < 1 || month > 12) {
    return false;
  }
  // 月の翌月 0 日目 = その月の末日 (UTC 固定で夏時間等の影響を受けない)。
  const lastDayOfMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day >= 1 && day <= lastDayOfMonth;
}

type ModelExcludeParseResult =
  | { readonly ok: true; readonly value: readonly HarnessModelExclude[] }
  | { readonly ok: false; readonly message: string };

/**
 * `models.exclude`。省略可 (省略時は `[]` = 除外なし、従来と同じ挙動)。
 *
 * ここでは構文だけを見る。期限切れかどうかは評価時 (`now` 注入) にしか分からないため、
 * パース時点では判定しない — `until` の形式さえ正しければ受理する。
 */
// parseModels (model-routes.ts) からのみ呼ばれる。分割前は同一ファイル内の非公開関数
// だったが、サブモジュール分割で cross-module import が必要になったため export している —
// ただし入口 (harness-contract.ts) の公開エクスポート面には含めない (分割前と同じく非公開)。
export function parseModelExclude(value: unknown): ModelExcludeParseResult {
  if (value === undefined) {
    return { ok: true, value: [] };
  }
  if (!Array.isArray(value)) {
    return { ok: false, message: 'models.exclude は配列である必要があります' };
  }
  if (value.length > MODEL_EXCLUDE_MAX_COUNT) {
    return {
      ok: false,
      message: `models.exclude は最大 ${MODEL_EXCLUDE_MAX_COUNT} 件です (受領: ${value.length} 件)`,
    };
  }

  const excludes: HarnessModelExclude[] = [];
  for (const [index, entry] of value.entries()) {
    const field = `models.exclude[${index}]`;
    if (!isPlainObject(entry)) {
      return { ok: false, message: `${field} はオブジェクトである必要があります` };
    }

    const member = entry.member;
    if (typeof member !== 'string' || !MODEL_EXCLUDE_MEMBER_PATTERN.test(member)) {
      return {
        ok: false,
        message:
          `${field}.member は member 形式 (英小文字始まり 16 文字以内の英小文字・数字・ハイフン) ` +
          `である必要があります (受領: ${describeContractValue(String(member))})`,
      };
    }

    const until = entry.until;
    if (typeof until !== 'string' || !isValidCalendarDate(until)) {
      return {
        ok: false,
        message:
          `${field}.until は YYYY-MM-DD 形式の実在する日付である必要があります ` +
          `(時刻は持てません) (受領: ${describeContractValue(String(until))})`,
      };
    }

    let reason: string | null = null;
    if (entry.reason !== undefined) {
      if (typeof entry.reason !== 'string') {
        return { ok: false, message: `${field}.reason は文字列である必要があります` };
      }
      if (!isSafeSingleLineValue(entry.reason)) {
        return {
          ok: false,
          message: `${field}.reason に改行・制御文字は使えません (200 文字以内)`,
        };
      }
      reason = entry.reason;
    }

    excludes.push({ member, until, reason });
  }

  return { ok: true, value: excludes };
}

/** `member:model` から member 部分だけを取り出す。パース済みの候補にのみ使う。 */
function candidateMember(candidate: HarnessModelCandidate): string {
  return candidate.slice(0, candidate.indexOf(':'));
}

/** 評価時点 (`today`) でまだ有効 (期限切れでない) 除外か。`until` を含む当日まで有効。 */
function isModelExcludeActive(entry: HarnessModelExclude, today: Date): boolean {
  const todayIso = today.toISOString().slice(0, 10);
  // 固定長 YYYY-MM-DD 同士なので、文字列の辞書順比較がそのまま日付順になる。
  return entry.until >= todayIso;
}

/**
 * `models.exclude` のうち評価時点で期限切れの件数。Hygiene の
 * 「期限切れの除外が N 件」の元データ。0 件なら何も出さない。
 */
export function countExpiredModelExcludes(
  models: HarnessContractModels | null,
  today: Date,
): number {
  if (models === null) {
    return 0;
  }
  return models.exclude.filter((entry) => !isModelExcludeActive(entry, today)).length;
}

/**
 * 除外によって候補列が空になった (stage, 複雑度) の警告メッセージ一覧。
 *
 * 除外された member を候補列から落とし、残りの候補で解決する。**セルの候補が
 * 全部落ちたら invalid ではなく警告を出す** — 契約自体 (member:model の構文) は
 * 妥当なので、待遇を invalid とは分ける (bdboard-p5l.20)。
 *
 * low/med/high は `*` からの展開で同じ配列を指すことがあり、その場合は 3 段とも
 * 同じ理由で空になる。冗長に見えても「宣言した 3 段それぞれが今 0 件」という
 * 事実は正しいため、複雑度ごとに個別の警告として出す (dedupe しない)。
 */
export function computeModelExclusionWarnings(
  models: HarnessContractModels | null,
  today: Date,
): readonly string[] {
  if (models === null) {
    return [];
  }

  const activeExcludedMembers = new Set(
    models.exclude
      .filter((entry) => isModelExcludeActive(entry, today))
      .map((entry) => entry.member),
  );
  if (activeExcludedMembers.size === 0) {
    return [];
  }

  const warnings: string[] = [];
  for (const route of models.routes) {
    for (const complexity of HARNESS_MODEL_COMPLEXITIES) {
      const candidates = route[complexity];
      if (candidates.length === 0) {
        continue;
      }
      const excludedHere = new Set(
        candidates
          .map(candidateMember)
          .filter((member) => activeExcludedMembers.has(member)),
      );
      if (excludedHere.size === 0) {
        continue;
      }
      const remaining = candidates.filter(
        (candidate) => !excludedHere.has(candidateMember(candidate)),
      );
      if (remaining.length === 0) {
        warnings.push(
          `models.routes.${route.stage}.${complexity}: 除外 (${[...excludedHere].join(', ')}) ` +
            'により候補が 0 件になりました (hook は除外中の member の委譲を止め、' +
            '他の member は表の判定なしで通します)',
        );
      }
    }
  }
  return warnings;
}
