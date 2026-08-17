import type { PrBadgeDto } from '../api';

export interface PrLinkBadgeProps {
  prLink: PrBadgeDto | undefined;
}

export function prStateLabel(state: string | null): string {
  switch (state) {
    case 'open':
      return 'PR open';
    case 'merged':
      return 'PR merged';
    case 'closed':
      return 'PR closed';
    default:
      return 'PR';
  }
}

export function prBadgeClassName(state: string | null): string {
  switch (state) {
    case 'open':
      return 'badge-pr-open';
    case 'merged':
      return 'badge-pr-merged';
    case 'closed':
      return 'badge-pr-closed';
    default:
      return 'badge-pr-unknown';
  }
}

function prCheckDotClassName(checkStatus: string | null): string | null {
  switch (checkStatus) {
    case 'pass':
      return 'pr-check-dot pr-check-pass';
    case 'fail':
      return 'pr-check-dot pr-check-fail';
    case 'pending':
      return 'pr-check-dot pr-check-pending';
    default:
      return null;
  }
}

function prStateTitlePart(state: string | null): string {
  if (state === 'open' || state === 'merged' || state === 'closed') {
    return state;
  }
  return 'state unknown';
}

function buildPrTitle(prLink: PrBadgeDto): string {
  const statePart = prStateTitlePart(prLink.state);
  if (
    prLink.checkStatus === 'pass' ||
    prLink.checkStatus === 'fail' ||
    prLink.checkStatus === 'pending' ||
    prLink.checkStatus === 'unknown'
  ) {
    return `${prLink.url} (${statePart}, CI: ${prLink.checkStatus})`;
  }
  return `${prLink.url} (${statePart})`;
}

export function PrLinkBadge({ prLink }: PrLinkBadgeProps) {
  if (prLink === undefined) {
    return null;
  }

  const checkDotClassName = prCheckDotClassName(prLink.checkStatus);

  return (
    <a
      href={prLink.url}
      target="_blank"
      rel="noreferrer noopener"
      className={`badge ${prBadgeClassName(prLink.state)}`}
      title={buildPrTitle(prLink)}
      onClick={(event) => event.stopPropagation()}
    >
      {prStateLabel(prLink.state)}
      {checkDotClassName !== null && (
        <span className={checkDotClassName} aria-hidden="true" />
      )}
    </a>
  );
}
