export interface ScannedProcess {
  readonly pid: number;
  /** 実行ファイル名のみ（例: "claude", "cursor-agent", "agy"）。引数は含めない */
  readonly command: string;
  readonly cwd: string;
  readonly startedAt?: Date;
}

export interface ProcessScanner {
  listAgentProcesses(): Promise<readonly ScannedProcess[]>;
}
