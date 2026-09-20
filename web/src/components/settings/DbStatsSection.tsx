// bdboard-sso1.10 (PR-B): SettingsPanel.tsx の「ローカルDB統計」表示ブロックを移動しただけの
// コンポーネント。query は親(SettingsPanel)に残し、その結果(isPending/isError/data)を props
// で受け取る表示専用コンポーネント。JSX・className・aria属性・文言・DOM構造は移動前から
// 変えていない。
import type { DbStatsDto } from '../../api';
import { formatBytes } from './formatters';
import { ModelStatsTableScroll } from '../ModelStatsTableScroll';

interface DbStatsSectionProps {
  isPending: boolean;
  isError: boolean;
  data: DbStatsDto | undefined;
}

export function DbStatsSection({ isPending, isError, data }: DbStatsSectionProps) {
  return (
    <section className="settings-panel-section" aria-labelledby="db-stats-title">
      <h3 id="db-stats-title">ローカルDB統計</h3>
      <p className="settings-panel-subtitle">
        SQLiteキャッシュのファイルサイズとテーブル別件数です。CFDスナップショット等は起動時・定期処理で保持期間に応じて整理されます。
      </p>
      {isPending ? (
        <p>読み込み中…</p>
      ) : isError || data === undefined ? (
        <p className="settings-panel-error">DB統計を読み込めませんでした</p>
      ) : (
        <>
          <p>DBサイズ: {formatBytes(data.sizeBytes)}</p>
          <ModelStatsTableScroll ariaLabel="ローカルDB統計（横スクロール可能）">
            <table className="model-stats-table">
              <thead>
                <tr>
                  <th scope="col">テーブル</th>
                  <th scope="col">件数</th>
                </tr>
              </thead>
              <tbody>
                {data.tables.map((table) => (
                  <tr key={table.name}>
                    <td>{table.name}</td>
                    <td>{table.rowCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ModelStatsTableScroll>
        </>
      )}
    </section>
  );
}
