// bdboard-v7sw: 詳細パネル上部バーのチケット番号。タップでクリップボードへコピーし、
// 約1.5秒だけ「コピーしました ✓」に替わる。失敗時は短いエラー文を出す。
import { useEffect, useRef, useState } from 'react';

export type CopyState = 'idle' | 'copied' | 'error';

export const COPY_FEEDBACK_MS = 1500;

/** navigator.clipboard が無い/拒否された環境向けのフォールバック。成否を返す。 */
export function legacyCopy(text: string): boolean {
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}

export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText !== undefined) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // フォールバックへ
  }
  return legacyCopy(text);
}

export function copyLabel(state: CopyState, ticketId: string): string {
  if (state === 'copied') return 'コピーしました ✓';
  if (state === 'error') return 'コピーできませんでした';
  return ticketId;
}

export function TicketIdCopyButton({
  ticketId,
  className,
}: {
  ticketId: string;
  className?: string;
}) {
  const [state, setState] = useState<CopyState>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    setState('idle');
    return () => clearTimeout(timer.current);
  }, [ticketId]);
  const onClick = async () => {
    const ok = await copyText(ticketId);
    setState(ok ? 'copied' : 'error');
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), COPY_FEEDBACK_MS);
  };
  return (
    <button
      type="button"
      className={`detail-id-copy${className !== undefined ? ` ${className}` : ''}`}
      aria-label="チケット番号をコピー"
      onClick={() => void onClick()}
    >
      <span aria-live="polite">{copyLabel(state, ticketId)}</span>
    </button>
  );
}
