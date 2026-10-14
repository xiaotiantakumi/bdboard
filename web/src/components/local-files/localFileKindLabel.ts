import type { LocalFileKind } from '../../api/local-files';

const LABELS: Readonly<Record<LocalFileKind, string>> = {
  image: '画像',
  video: '動画',
  audio: '音声',
  markdown: 'Markdown',
  json: 'JSON',
  text: 'テキスト',
  directory: 'フォルダ',
};

export function localFileKindLabel(kind: LocalFileKind): string {
  return LABELS[kind];
}
