import { useState } from 'react';
import type { AiQuotaProviderDto } from '../../api';
import { usePopoverViewportClamp } from '../../hooks/usePopoverViewportClamp';

export function ManualProviderNote({ provider }: { provider: AiQuotaProviderDto }) {
  const [noteOpen, setNoteOpen] = useState(false);
  const detailRef = usePopoverViewportClamp<HTMLSpanElement>(noteOpen);

  return (
    <div className="ai-quota-provider">
      <span className="ai-quota-provider-label">{provider.id}</span>
      <details
        className="ai-quota-note"
        open={noteOpen}
        onToggle={(event) => {
          setNoteOpen(event.currentTarget.open);
        }}
      >
        <summary
          className="ai-quota-chip ai-quota-chip-manual"
          aria-label={`${provider.label}: ${provider.detail ?? '数値を自動取得できません'}`}
          onClick={(event) => {
            // <details> の toggle は非同期に発火するため、ネイティブ開閉に任せると
            // クランプが1フレーム遅れ、ツールチップが画面外に描画されてからスナップする。
            // click を奪って open を React 管理にすると、layout effect がペイント前に走る。
            event.preventDefault();
            setNoteOpen((open) => !open);
          }}
        >
          手動確認
        </summary>
        <span className="ai-quota-note-detail" ref={detailRef}>
          {provider.detail ?? '数値を自動取得できません。対象サービスで確認してください。'}
        </span>
      </details>
    </div>
  );
}
