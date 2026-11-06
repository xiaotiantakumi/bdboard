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
   * hook の登録先になりうる設定ファイル (`.claude/settings.json` と
   * `.claude/settings.local.json`) の本文を `[settings.json, settings.local.json]` の
   * 順で返す。無い/読めないものは null。
   *
   * hook 登録状況 (hooksState) の判定に要る。書き込み先は通常 settings.local.json だが、
   * 自己注入と移行前の注入先では settings.json にあるので、**和集合**で判定できるよう
   * 両方を返す (bdboard-l1m1.8)。専用 port を足さず、既に設定を書いている injector に
   * 相乗りさせる。
   */
  readSettings(projectRootPath: string): Promise<readonly (string | null)[]>;
  injectPack(
    projectRootPath: string,
    pack: PackDefinition,
    injectedAt: Date,
  ): Promise<HarnessManifest>;
}
