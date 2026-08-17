const EVENT_SOURCE_OPEN = 1;

function eventsUrl(): string {
  // Absolute URL built from origin rather than relative '/api/events': a
  // relative URL resolves against the document URL, and if that still carries
  // QR credentials WebKit rejects the EventSource outright. `origin` never
  // includes userinfo. See stripUrlCredentials.ts.
  return `${window.location.origin}/api/events`;
}

type OpenListener = () => void;
type ErrorListener = () => void;

export interface SharedEventSourceHandle {
  addEventListener(type: string, listener: EventListener): void;
  removeEventListener(type: string, listener: EventListener): void;
  addOpenListener(listener: OpenListener): void;
  removeOpenListener(listener: OpenListener): void;
  addErrorListener(listener: ErrorListener): void;
  removeErrorListener(listener: ErrorListener): void;
  release(): void;
}

let refCount = 0;
let eventSource: EventSource | null = null;
const openListeners = new Set<OpenListener>();
const errorListeners = new Set<ErrorListener>();

function dispatchOpen(): void {
  for (const listener of openListeners) {
    listener();
  }
}

function dispatchError(): void {
  for (const listener of errorListeners) {
    listener();
  }
}

function attachEventSourceHandlers(es: EventSource): void {
  es.onopen = () => dispatchOpen();
  es.onerror = () => dispatchError();
}

function ensureEventSource(): EventSource {
  if (eventSource === null) {
    eventSource = new EventSource(eventsUrl());
    attachEventSourceHandlers(eventSource);
  }
  return eventSource;
}

function resetIfIdle(): void {
  if (refCount === 0 && eventSource !== null) {
    eventSource.close();
    eventSource = null;
    openListeners.clear();
    errorListeners.clear();
  }
}

export function acquireSharedEventSource(): SharedEventSourceHandle {
  refCount += 1;
  const es = ensureEventSource();

  return {
    addEventListener(type, listener) {
      es.addEventListener(type, listener);
    },
    removeEventListener(type, listener) {
      es.removeEventListener(type, listener);
    },
    addOpenListener(listener) {
      openListeners.add(listener);
      if (eventSource?.readyState === EVENT_SOURCE_OPEN) {
        listener();
      }
    },
    removeOpenListener(listener) {
      openListeners.delete(listener);
    },
    addErrorListener(listener) {
      errorListeners.add(listener);
    },
    removeErrorListener(listener) {
      errorListeners.delete(listener);
    },
    release() {
      refCount = Math.max(0, refCount - 1);
      resetIfIdle();
    },
  };
}

/** Test-only reset when RTL cleanup order leaves module state behind. */
export function __resetSharedEventSourceForTests(): void {
  refCount = 0;
  if (eventSource !== null) {
    eventSource.close();
    eventSource = null;
  }
  openListeners.clear();
  errorListeners.clear();
}
