// bdboard-sso1.5: 詳細パネルの「ラベル + 値」の1行フィールド (ID/Status/Priority
// など) が同じ DOM 構造 (.detail-field > .detail-field-label + 値div) を
// 繰り返していたのをまとめた表示専用コンポーネント。DOM構造・クラス名は
// 移動前の各インライン div と同一 (PR-L調査コメントで見送られていた候補)。
import type { ReactNode } from 'react';

export interface DetailFieldProps {
  label: string;
  children: ReactNode;
}

export function DetailField({ label, children }: DetailFieldProps) {
  return (
    <div className="detail-field">
      <div className="detail-field-label">{label}</div>
      <div>{children}</div>
    </div>
  );
}
