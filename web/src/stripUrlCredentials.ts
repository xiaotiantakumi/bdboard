// Landing on the board through the tunnel QR (bdboard-3tw.77) means landing on
// a document whose URL still carries `user:password@`, because that is how the
// QR skips the Basic auth prompt on a phone. WebKit then breaks the app:
//
//   FetchRequest::initializeWith resolves a relative URL against the document's
//   base URL and rejects the result outright if it has credentials —
//   `TypeError: URL is not valid or contains user credentials.` Every call in
//   api.ts is relative, so every query fails at once and the board renders as a
//   shell of error messages. (EventSource, contrary to the first attempt at
//   this fix, has no credentials check at all; the message was always Fetch's.)
//
// Two things make this harder to clean up than it looks, both of which the
// first attempt got wrong:
//
//   - `location.href` is NOT a reliable way to detect the problem. WebKit's
//     Location::href() strips credentials before returning, while document.URL
//     and document.baseURI — the thing relative fetches actually resolve
//     against — keep them. So on iOS the URL looks clean and the dirty base URL
//     goes unnoticed. Detection has to read `document.baseURI`.
//   - `history.replaceState` cannot fix it. The spec's "can have its URL
//     rewritten" check requires the new URL's username and password to match
//     the document's, so rewriting them throws SecurityError. The credentials
//     can only be shed by an actual navigation.

// Returns the same URL without its userinfo component, or null if there was
// nothing to strip.
export function stripUrlCredentials(href: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(href);
  } catch {
    return null;
  }

  if (parsed.username === '' && parsed.password === '') {
    return null;
  }

  parsed.username = '';
  parsed.password = '';

  return parsed.toString();
}

// Decides whether boot should redirect to a credential-free URL first.
// Returning null means "just render".
//
// Both `document.URL` and `document.baseURI` are consulted. baseURI is the one
// relative fetches actually resolve against, which makes it the authoritative
// signal, but engines disagree about which accessors hide credentials — and the
// accessor that hid them is exactly how the first attempt at this fix failed
// silently. Checking both costs nothing and cannot produce a false positive:
// a URL either carries userinfo or it does not.
//
// `alreadyRedirected` guards against a reload loop. If the credentials somehow
// survive the navigation, render the app anyway rather than bouncing forever.
export function resolveCredentialRedirect(
  documentUrl: string,
  baseUri: string,
  alreadyRedirected: boolean,
): string | null {
  if (alreadyRedirected) {
    return null;
  }

  return stripUrlCredentials(documentUrl) ?? stripUrlCredentials(baseUri);
}
