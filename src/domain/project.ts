export type ProjectPrefix = string;

export function isProjectPrefix(value: string): boolean {
  return value.length > 0 && !/\s/.test(value) && !value.endsWith('-');
}

export interface Project {
  readonly id: string;
  readonly name: string;
  readonly rootPath: string;
  readonly prefixes: readonly ProjectPrefix[];
  /** rootPath に畳まれた別名パス(リポジトリ外 worktree 等)。昇順ソート・重複なし・rootPath 自身は含まない。 */
  readonly aliasPaths: readonly string[];
}
