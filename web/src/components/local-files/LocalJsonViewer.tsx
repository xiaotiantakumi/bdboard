import { useQuery } from '@tanstack/react-query';
import { fetchLocalFileText } from '../../api/local-files';
import { JsonTree } from './JsonTree';
import { localFileErrorMessage } from './localFileErrorMessage';

export interface LocalJsonViewerProps {
  readonly ticketId: string;
  readonly path: string;
  /** 描く節点の上限。既定は 2000。 */
  readonly nodeLimit?: number;
}

export function LocalJsonViewer({ ticketId, path, nodeLimit }: LocalJsonViewerProps) {
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

  let parsed: unknown;
  try {
    parsed = JSON.parse(textQuery.data) as unknown;
  } catch {
    return (
      <>
        <p className="local-file-note">JSON として読めなかったので、そのまま表示しています。</p>
        <pre className="local-file-viewer-text">{textQuery.data}</pre>
      </>
    );
  }

  return <JsonTree value={parsed} nodeLimit={nodeLimit} />;
}
