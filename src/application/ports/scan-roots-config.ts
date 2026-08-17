export interface ScanRootsConfig {
  readonly scanRoots: readonly string[];
  readonly excludePaths: readonly string[];
}

export interface ScanRootsConfigPort {
  read(): Promise<ScanRootsConfig | undefined>;
  write(config: ScanRootsConfig): Promise<void>;
}
