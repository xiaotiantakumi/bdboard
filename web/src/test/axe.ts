import { axe, toHaveNoViolations } from 'jest-axe';
import { expect } from 'vitest';

type AxeRunOptions = NonNullable<Parameters<typeof axe>[1]>;
type AxeResults = Awaited<ReturnType<typeof axe>>;

expect.extend(toHaveNoViolations);

declare module 'vitest' {
  interface Assertion {
    toHaveNoViolations(): void;
  }
  interface AsymmetricMatchersContaining {
    toHaveNoViolations(): void;
  }
}

/**
 * Rules disabled in jsdom because they need layout/computed-style data the
 * environment does not provide (false positives or runtime errors).
 */
const JSDOM_DISABLED_AXE_RULES: Record<string, { enabled: boolean }> = {
  // jsdom does not compute foreground/background contrast from CSS.
  'color-contrast': { enabled: false },
};

export async function runAxe(
  container: Element,
  options: Partial<AxeRunOptions> = {},
): Promise<AxeResults> {
  const mergedRules: Record<string, { enabled: boolean }> = {
    ...JSDOM_DISABLED_AXE_RULES,
    ...(options.rules as Record<string, { enabled: boolean }> | undefined),
  };
  return axe(container, {
    ...options,
    rules: mergedRules,
  } as AxeRunOptions);
}

export async function expectNoA11yViolations(
  container: Element,
  options: Partial<AxeRunOptions> = {},
): Promise<void> {
  const results = await runAxe(container, options);
  expect(results).toHaveNoViolations();
}
