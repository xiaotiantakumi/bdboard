import { useQuery } from '@tanstack/react-query';
import { fetchLocalFileList, localFileRawUrl, type LocalFileListEntryDto } from '../../api/local-files';
import { LocalFileLabel } from './LocalFileLabel';
import { localFileErrorMessage } from './localFileErrorMessage';

export interface LocalFolderThumbnailsProps {
  readonly ticketId: string;
  readonly dirPath: string;
  readonly onSelect: (entry: LocalFileListEntryDto) => void;
}

export function LocalFolderThumbnails({ ticketId, dirPath, onSelect }: LocalFolderThumbnailsProps) {
  const listQuery = useQuery({
    queryKey: ['ticket-local-file-list', ticketId, dirPath],
    queryFn: () => fetchLocalFileList(ticketId, dirPath),
  });

  if (listQuery.isPending) {
    return <p className="local-file-note">読み込んでいます。</p>;
  }
  if (listQuery.isError) {
    return (
      <p className="local-file-note" role="alert">
        {localFileErrorMessage(listQuery.error)}
      </p>
    );
  }

  const images = listQuery.data.entries.filter((entry) => entry.kind === 'image');
  const others = listQuery.data.entries.filter((entry) => entry.kind !== 'image');

  return (
    <div className="local-file-folder-body">
      {images.length > 0 && (
        <ul className="attachment-thumbnail-list">
          {images.map((entry) => (
            <li key={entry.path} className="attachment-thumbnail-item">
              <button type="button" className="attachment-thumbnail-button" onClick={() => onSelect(entry)}>
                <img
                  className="attachment-thumbnail-image"
                  src={localFileRawUrl(ticketId, entry.path)}
                  alt={entry.name}
                  loading="lazy"
                />
              </button>
            </li>
          ))}
        </ul>
      )}
      {others.length > 0 && (
        <ul className="local-file-entry-list">
          {others.map((entry) => (
            <li key={entry.path}>
              <button type="button" className="local-file-row" onClick={() => onSelect(entry)}>
                <LocalFileLabel kind={entry.kind} path={entry.path} size={entry.size} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {listQuery.data.entries.length === 0 && (
        <p className="local-file-note">表示できるファイルはありません。</p>
      )}
      {listQuery.data.truncated && <p className="local-file-note">先頭の一部だけ表示しています。</p>}
    </div>
  );
}
