import type { LocalFileKind } from '../../api/local-files';
import { formatByteSize } from '../TicketAttachments';
import { localFileKindLabel } from './localFileKindLabel';

export function LocalFileLabel({
  kind,
  path,
  size,
}: {
  readonly kind: LocalFileKind;
  readonly path: string;
  readonly size: number | null;
}) {
  return (
    <>
      <span className="local-file-kind">{localFileKindLabel(kind)}</span>
      <span className="local-file-path">{path}</span>
      {size !== null && <span className="local-file-size">{formatByteSize(size)}</span>}
    </>
  );
}
