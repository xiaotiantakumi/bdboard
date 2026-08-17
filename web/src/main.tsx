import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import { App } from './App';
import { WatchedTicketsProvider } from './components/WatchedTicketsProvider';
import { resolveCredentialRedirect } from './stripUrlCredentials';

const REDIRECT_GUARD_KEY = 'bdboard.credential-redirect';

function alreadyRedirected(): boolean {
  try {
    return window.sessionStorage.getItem(REDIRECT_GUARD_KEY) !== null;
  } catch {
    // Private browsing can throw on sessionStorage. Losing the guard is better
    // than losing the redirect, so treat it as "not yet redirected".
    return false;
  }
}

function markRedirected(): void {
  try {
    window.sessionStorage.setItem(REDIRECT_GUARD_KEY, '1');
  } catch {
    // See above — proceed without the guard rather than not redirecting.
  }
}

function mount(): void {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { staleTime: 30_000 } },
  });

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <WatchedTicketsProvider>
          <App />
        </WatchedTicketsProvider>
      </QueryClientProvider>
    </StrictMode>,
  );
}

// Arriving via the tunnel QR means arriving on a URL that carries the Basic
// auth credentials, and WebKit then rejects every relative fetch the app makes.
// See stripUrlCredentials.ts for why this reads document.baseURI rather than
// location.href, and why it navigates instead of rewriting history.
//
// The first request has already been authenticated by the time this runs, so
// the browser holds the credentials for the origin and the reload goes through
// without a prompt. Nothing is mounted on the redirect path — rendering an app
// that is about to be replaced would only fire queries that are certain to fail.
const credentialFreeUrl = resolveCredentialRedirect(
  document.URL,
  document.baseURI,
  alreadyRedirected(),
);

if (credentialFreeUrl !== null) {
  markRedirected();
  window.location.replace(credentialFreeUrl);
} else {
  mount();
}
