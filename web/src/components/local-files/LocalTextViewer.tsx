import { useQuery } from '@tanstack/react-query';
import { fetchLocalFileText } from '../../api/local-files';
import { localFileErrorMessage } from './localFileErrorMessage';

export interface LocalTextViewerProps {
  readonly ticketId: string;
  readonly path: string;
}

export function LocalTextViewer({ ticketId, path }: LocalTextViewerProps) {
  const textQuery = useQuery({
    queryKey: ['local-file-text', ticketId, path],
    queryFn: () => fetchLocalFileText(ticketId, path),
  });

  if (textQuery.isPending) {
    return <p className="local-file-note">読み込んでいます。</p>;
  }
  if (textQuery.isError) {
    return (
      <p className="local-file-note" role="alert">
        {localFileErrorMessage(textQuery.error)}
      </p>
    );
  }
  return <pre className="local-file-viewer-text">{textQuery.data}</pre>;
}
