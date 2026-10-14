import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import {
  fetchLocalFileList,
  localFileRawUrl,
  type LocalFileListEntryDto,
} from '../../api/local-files';
import { isTypingTarget } from '../../keyboardShortcuts';
import { localFileNameOf } from '../../localFileViewerRoute';

export interface LocalImageViewerProps {
  readonly ticketId: string;
  readonly path: string;
  readonly onNavigate: (entry: LocalFileListEntryDto) => void;
}

function parentDirectory(path: string): string | null {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? null : path.slice(0, slash);
}

export function LocalImageViewer({ ticketId, path, onNavigate }: LocalImageViewerProps) {
  const [failedPath, setFailedPath] = useState<string | null>(null);
  const parent = parentDirectory(path);
  const listQuery = useQuery({
    // フォルダのサムネイル一覧 (LocalFolderThumbnails) と同じキーでキャッシュを共有する。
    queryKey: ['ticket-local-file-list', ticketId, parent ?? ''],
    queryFn: () => fetchLocalFileList(ticketId, parent ?? ''),
    enabled: parent !== null,
  });
  const images =
    parent !== null && listQuery.isSuccess
      ? listQuery.data.entries.filter((entry) => entry.kind === 'image')
      : [];
  const index = images.findIndex((entry) => entry.path === path);
  const previous = index > 0 ? images[index - 1] : undefined;
  const next = index >= 0 && index < images.length - 1 ? images[index + 1] : undefined;
  const imageFailed = failedPath === path;

  useEffect(() => {
    if (index < 0) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      // Alt/Cmd/Ctrl/Shift + 矢印はブラウザの戻る・進むや選択の操作なので奪わない。
      if (event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return;
      if (isTypingTarget(event.target)) return;
      const entry = event.key === 'ArrowLeft' ? previous : next;
      if (entry === undefined) return;
      event.preventDefault();
      onNavigate(entry);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [index, next, onNavigate, previous]);

  return (
    <div className="local-file-viewer-image-frame">
      <img
        className="local-file-viewer-image"
        src={localFileRawUrl(ticketId, path)}
        alt={localFileNameOf(path)}
        onError={() => setFailedPath(path)}
      />
      {imageFailed && (
        <p className="local-file-note" role="alert">
          画像を読み込めませんでした。
        </p>
      )}
      {parent !== null && (
        <div className="local-file-viewer-nav">
          <button
            type="button"
            className="btn"
            onClick={() => onNavigate({ name: localFileNameOf(parent), path: parent, kind: 'directory', size: null })}
          >
            フォルダの一覧へ
          </button>
          {index >= 0 && (
            <>
              <button
                type="button"
                className="btn"
                disabled={previous === undefined}
                onClick={() => previous && onNavigate(previous)}
              >
                前へ
              </button>
              <span className="local-file-viewer-position">
                {index + 1} / {images.length}
              </span>
              <button
                type="button"
                className="btn"
                disabled={next === undefined}
                onClick={() => next && onNavigate(next)}
              >
                次へ
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
