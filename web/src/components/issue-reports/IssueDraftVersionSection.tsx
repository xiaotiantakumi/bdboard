import type { IssueDraftDetailDto, IssueDraftEnvInfoDto } from '../../api/issue-reports';
import { compareHarnessVersions, type VersionComparison } from './issueDraftText';

export interface IssueDraftVersionSectionProps {
  readonly draft: IssueDraftDetailDto;
  /** この bdboard が配る最新の harness pack の版。読めなければ null・未取得なら undefined。 */
  readonly latestHarnessVersion: string | null | undefined;
}

const ENV_ROWS: readonly { key: keyof IssueDraftEnvInfoDto; label: string }[] = [
  { key: 'bdboardVersion', label: 'bdboard' },
  { key: 'os', label: 'OS' },
  { key: 'nodeVersion', label: 'Node.js' },
  { key: 'bdVersion', label: 'bd' },
  { key: 'ghVersion', label: 'gh' },
];

function comparisonMessage(comparison: VersionComparison): string {
  switch (comparison.kind) {
    case 'different':
      return '発生したときの版と最新の版が違います。最新の版では直っているかもしれません。注入先のハーネスを更新して、まだ起きるか確かめてください。';
    case 'same':
      return '最新の版で起きています。';
    case 'unknown-occurrence':
      return '発生したときのハーネスの版が記録されていないため、比べられません。';
    case 'unknown-latest':
      return 'この bdboard が配る最新の版を読めなかったため、比べられません。';
  }
}

function shown(value: string | undefined): string {
  return value !== undefined ? value : '(記録なし)';
}

/**
 * 3) 版の比較: 注入先のハーネスの版 (最後の発生のもの。4節 m-6) と、この bdboard が配る最新の版を並べる。
 * bdboard 本体の不具合 (種類 C) のように版が無い下書きや、版の無い envInfo でも崩さない。
 */
export function IssueDraftVersionSection({ draft, latestHarnessVersion }: IssueDraftVersionSectionProps) {
  const envInfo = draft.localOnly?.envInfo ?? {};
  const occurred = draft.harnessVersionAtOccurrence ?? envInfo.harnessVersion;
  const comparison = compareHarnessVersions(occurred, latestHarnessVersion);
  const occurredShown = comparison.kind === 'unknown-occurrence' ? undefined : comparison.occurred;
  const latestShown = comparison.kind === 'unknown-latest' ? undefined : comparison.latest;
  return (
    <section className="issue-draft-section" aria-labelledby={`issue-draft-version-${draft.id}`}>
      <h3 id={`issue-draft-version-${draft.id}`} className="issue-draft-section-title">
        版の比較
      </h3>
      <dl className="issue-draft-version-list">
        <dt>発生したときのハーネス</dt>
        <dd>
          <code>{shown(occurredShown)}</code>
        </dd>
        <dt>最新のハーネス</dt>
        <dd>
          <code>{shown(latestShown)}</code>
        </dd>
      </dl>
      <p className={`issue-draft-version-message issue-draft-version-${comparison.kind}`} data-comparison={comparison.kind}>
        {comparisonMessage(comparison)}
      </p>
      <dl className="issue-draft-version-list issue-draft-env-list">
        {ENV_ROWS.filter((row) => typeof envInfo[row.key] === 'string' && envInfo[row.key] !== '').map((row) => (
          <div key={row.key} className="issue-draft-env-row">
            <dt>{row.label}</dt>
            <dd>
              <code>{envInfo[row.key]}</code>
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
