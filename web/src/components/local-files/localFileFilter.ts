import type { LocalFileRefDto } from '../../api/local-files';

export type LocalFileFilter = 'all' | 'video' | 'json' | 'markdown' | 'directory';

export const LOCAL_FILE_FILTER_OPTIONS: readonly { readonly value: LocalFileFilter; readonly label: string }[] = [
  { value: 'all', label: 'すべて' },
  { value: 'video', label: '動画' },
  { value: 'json', label: 'JSON' },
  { value: 'markdown', label: 'Markdown' },
  { value: 'directory', label: 'フォルダ' },
];

export const LOCAL_FILE_FILTER_STORAGE_KEY = 'bdboard.ui.localFileFilter';

const VALID: ReadonlySet<string> = new Set(LOCAL_FILE_FILTER_OPTIONS.map((o) => o.value));

export function isLocalFileFilter(value: unknown): value is LocalFileFilter {
  return typeof value === 'string' && VALID.has(value);
}

export function filterLocalFiles(
  files: readonly LocalFileRefDto[],
  filter: LocalFileFilter,
): readonly LocalFileRefDto[] {
  if (filter === 'all') return files;
  return files.filter((file) => file.kind === filter);
}

export function readStoredLocalFileFilter(): LocalFileFilter {
  try {
    const raw = window.localStorage.getItem(LOCAL_FILE_FILTER_STORAGE_KEY);
    return isLocalFileFilter(raw) ? raw : 'all';
  } catch {
    return 'all';
  }
}

export function writeStoredLocalFileFilter(filter: LocalFileFilter): void {
  try {
    window.localStorage.setItem(LOCAL_FILE_FILTER_STORAGE_KEY, filter);
  } catch {
    // 保存できなくても (プライベートモード等) 絞り込み自体は動く。
  }
}
