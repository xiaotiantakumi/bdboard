import type { HarnessManifest } from '../../domain/harness-pack.js';
import {
  evaluatePackInjectability,
  type PackInjectabilityCode,
} from '../../domain/harness-pack-injectability.js';
import type { HarnessInjectorPort } from '../ports/harness-injector.js';
import type { PackRegistryPort } from '../ports/pack-registry.js';

export type InjectHarnessPackFailure =
  | { readonly kind: 'pack-not-found' }
  /**
   * role/requires の組み合わせ違反、または依存先が未注入 (bdboard-l1m1.1)。
   * 何も書かずに返す。HTTP では 409。
   */
  | {
      readonly kind: 'not-injectable';
      readonly code: PackInjectabilityCode;
      readonly reason: string;
    }
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

  // 選択状態の正は注入先の注入記録 (.claude/bdboard-packs.json)。「入れたいが入って
  // いない」状態は持たないので、依存の充足もここで記録を読んで判定する。
  // 読めない (injector が投げる) ときは注入失敗と同じ扱いにして、検査を飛ばさない。
  try {
    const [available, manifest] = await Promise.all([
      deps.registry.listPacks(),
      deps.injector.readManifest(projectRootPath),
    ]);
    const injectability = evaluatePackInjectability(pack, available, manifest);
    if (!injectability.ok) {
      return {
        ok: false,
        failure: {
          kind: 'not-injectable',
          code: injectability.code,
          reason: injectability.reason,
        },
      };
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, failure: { kind: 'injection-failed', detail } };
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
