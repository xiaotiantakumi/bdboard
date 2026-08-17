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
  injectPack(
    projectRootPath: string,
    pack: PackDefinition,
    injectedAt: Date,
  ): Promise<HarnessManifest>;
}
