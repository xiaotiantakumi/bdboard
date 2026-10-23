// bdboard-v7sw: チケット属性ブロックを既定で畳む <details>。開閉は端末ごとに
// localStorage へ覚える (既定は閉)。
import { useState, type ReactNode } from 'react';

export const ATTRIBUTES_OPEN_KEY = 'bdboard.ticketDetail.attributesOpen';

export function readAttributesOpen(): boolean {
  try {
    return localStorage.getItem(ATTRIBUTES_OPEN_KEY) === '1';
  } catch {
    return false;
  }
}

function writeAttributesOpen(open: boolean): void {
  try {
    localStorage.setItem(ATTRIBUTES_OPEN_KEY, open ? '1' : '0');
  } catch {
    // 保存できなくても動作には影響しない
  }
}

export function TicketAttributesDetails({
  summary,
  children,
}: {
  summary: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(readAttributesOpen);
  return (
    <details
      className="ticket-attributes"
      open={open}
      onToggle={(event) => {
        const next = event.currentTarget.open;
        if (next !== open) {
          setOpen(next);
          writeAttributesOpen(next);
        }
      }}
    >
      <summary className="ticket-attributes-summary">
        <span className="ticket-attributes-title">詳細情報</span>
        <span className="ticket-attributes-text">{summary}</span>
      </summary>
      <div className="ticket-attributes-grid">{children}</div>
    </details>
  );
}
