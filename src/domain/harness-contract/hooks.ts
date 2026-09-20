import { isPlainObject } from './shared.js';
import type { HarnessContractHooks } from './types.js';

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

// parseHarnessContract (parse.ts) からのみ呼ばれる。分割前は同一ファイル内の非公開関数
// だったが、サブモジュール分割で cross-module import が必要になったため export している —
// ただし入口 (harness-contract.ts) の公開エクスポート面には含めない (分割前と同じく非公開)。
export function parseHooks(
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
