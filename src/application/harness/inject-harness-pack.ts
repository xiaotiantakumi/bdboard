import type { HarnessManifest } from '../../domain/harness-pack.js';
import type { HarnessInjectorPort } from '../ports/harness-injector.js';
import type { PackRegistryPort } from '../ports/pack-registry.js';

export type InjectHarnessPackFailure =
  | { readonly kind: 'pack-not-found' }
  | { readonly kind: 'injection-failed'; readonly detail: string };

export type InjectHarnessPackResult =
  | { readonly ok: true; readonly manifest: HarnessManifest }
  | { readonly ok: false; readonly failure: InjectHarnessPackFailure };

export async function injectHarnessPack(
  deps: {
    readonly registry: PackRegistryPort;
    readonly injector: HarnessInjectorPort;
    readonly now: () => Date;
  },
  projectRootPath: string,
  packName: string,
): Promise<InjectHarnessPackResult> {
  const pack = await deps.registry.getPack(packName);
  if (pack === undefined) {
    return { ok: false, failure: { kind: 'pack-not-found' } };
  }

  try {
    const manifest = await deps.injector.injectPack(
      projectRootPath,
      pack,
      deps.now(),
    );
    return { ok: true, manifest };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, failure: { kind: 'injection-failed', detail } };
  }
}
