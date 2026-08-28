// Liveness union and thresholds are defined in src/domain/liveness.ts (server).
// Web must not import that module: .dependency-cruiser.cjs's `web-no-server-src` rule
// forbids any web/ -> src/ edge (checked by `npm run check:boundaries`). So types and
// labels are mirrored here instead.

export type Liveness = 'active' | 'idle' | 'stale' | 'dormant';

export const LIVENESS_LABELS: Record<Liveness, string> = {
  active: '稼働中',
  idle: 'アイドル',
  stale: '停滞',
  dormant: '休止',
};

export const LIVENESS_ORDER: Record<Liveness, number> = {
  active: 0,
  idle: 1,
  stale: 2,
  dormant: 3,
};

export function livenessClass(liveness: Liveness | string | null): string {
  switch (liveness) {
    case 'active':
      return 'liveness-active';
    case 'idle':
      return 'liveness-idle';
    case 'stale':
      return 'liveness-stale';
    default:
      return 'liveness-unknown';
  }
}

export function livenessLabel(liveness: string | null): string {
  if (liveness === null) {
    return '—';
  }
  if (liveness in LIVENESS_LABELS) {
    return LIVENESS_LABELS[liveness as Liveness];
  }
  return '—';
}
