import { useQuery } from '@tanstack/react-query';
import { fetchLocalFileText } from '../../api/local-files';
import { MarkdownContent } from '../MarkdownContent';
import { localFileErrorMessage } from './localFileErrorMessage';

export interface LocalMarkdownViewerProps {
  readonly ticketId: string;
  readonly path: string;
}

export function LocalMarkdownViewer({ ticketId, path }: LocalMarkdownViewerProps) {
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
  return (
    <MarkdownContent
      text={textQuery.data}
      isTicketOnBoard={() => false}
      onOpenTicket={() => undefined}
      className="markdown-detail"
    />
  );
}
