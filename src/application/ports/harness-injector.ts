import type { HarnessManifest, PackDefinition } from '../../domain/harness-pack.js';

export class HarnessInjectionError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'HarnessInjectionError';
  }
}

export class HarnessPathTraversalError extends HarnessInjectionError {
  constructor(message: string) {
    super(message);
    this.name = 'HarnessPathTraversalError';
  }
}

export interface HarnessInjectorPort {
  readManifest(projectRootPath: string): Promise<HarnessManifest>;
  /**
   * 注入先の `.claude/settings.json` の本文。無い/読めないときは null。
   *
   * hook 登録状況 (hooksState) の判定に要る。読み書きどちらも同じファイルなので
   * 専用 port を足さず、既に settings.json を書いている injector に相乗りさせる。
   */
  readSettings(projectRootPath: string): Promise<string | null>;
  injectPack(
    projectRootPath: string,
    pack: PackDefinition,
    injectedAt: Date,
  ): Promise<HarnessManifest>;
}
