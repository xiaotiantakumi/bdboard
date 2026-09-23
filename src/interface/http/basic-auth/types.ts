import type { Context } from 'hono';

export interface BasicAuthConfig {
  readonly username: string;
  readonly password: string;
}

export type AuthMode =
  | { readonly kind: 'enabled'; readonly config: BasicAuthConfig }
  | { readonly kind: 'disabled-explicitly' }
  | { readonly kind: 'unconfigured' };

export interface BasicAuthMiddlewareOptions {
  readonly now?: () => Date;
  readonly maxFailures?: number;
  readonly lockDurationMs?: number;
  readonly getExtraCredentials?: () => BasicAuthConfig | null;
  readonly hasValidSession?: (c: Context) => boolean;
  readonly isLocalRequest?: (c: Context) => boolean;
}
