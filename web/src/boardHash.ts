// Board deep-link hash (#ticket=…&view=…).
//
// Safety rules (bdboard-1qm / WebKit credential URLs):
// - history.pushState/replaceState must receive a relative URL only
//   (pathname + search + hash). Never build from document.URL, location.href,
//   or new URL(...) with an absolute href — WebKit throws SecurityError or
//   re-exposes credentials in the URL bar.
// - serializeBoardHash outputs only known keys (ticket, view). Unknown keys
//   (user, password, token, …) are dropped on parse and never re-emitted.

import {
  DEFAULT_VIEW,
  validateViewMode,
  type ViewMode,
} from './uiPersistedState';

export interface BoardHashState {
  ticketId: string | null;
  view: ViewMode | null;
}

/** `#ticket=…&view=…` をパースする。未知キー・不正 view は捨てる。 */
export function parseBoardHash(hash: string): BoardHashState {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  if (raw === '') {
    return { ticketId: null, view: null };
  }

  const params = new URLSearchParams(raw);
  const ticketRaw = params.get('ticket');
  const ticketId = ticketRaw !== null && ticketRaw !== '' ? ticketRaw : null;
  const viewRaw = params.get('view');
  const view = viewRaw !== null ? validateViewMode(viewRaw) : null;

  return { ticketId, view };
}

/** 既知キーだけを `#ticket=…&view=…` 形式で出力。空状態なら '' を返す。 */
export function serializeBoardHash(state: BoardHashState): string {
  const params = new URLSearchParams();

  if (state.ticketId !== null) {
    params.set('ticket', state.ticketId);
  }

  if (state.view !== null && state.view !== DEFAULT_VIEW) {
    params.set('view', state.view);
  }

  const serialized = params.toString();
  return serialized === '' ? '' : `#${serialized}`;
}

/** history に渡す「相対 URL」を組み立てる。絶対 URL は絶対に作らない。 */
export function boardHashTarget(
  state: BoardHashState,
  location: { pathname: string; search: string },
): string {
  return location.pathname + location.search + serializeBoardHash(state);
}
