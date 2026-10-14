/**
 * bdboard-vgdr。local-files の拒否応答。
 * routes と raw の両方から使う。互いに import すると循環になるので、ここへ置いている。
 */

/** list / raw が共有する拒否理由。 */
export type LocalFileRouteErrorReason =
  | 'invalid'
  | 'not-found'
  | 'unsupported-type'
  | 'not-a-directory';

export function localFileErrorResponse(reason: LocalFileRouteErrorReason): {
  readonly status: 400 | 404 | 415;
  readonly body: { readonly error: string };
} {
  switch (reason) {
    case 'invalid':
      return { status: 400, body: { error: 'invalid path' } };
    case 'not-found':
      return { status: 404, body: { error: 'not found' } };
    case 'unsupported-type':
      return { status: 415, body: { error: 'unsupported file type' } };
    case 'not-a-directory':
      return { status: 400, body: { error: 'not a directory' } };
  }
}
