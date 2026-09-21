export interface PsProcessScannerOptions {
  readonly timeoutMs?: number;
  /** bd-heartbeat pidfile ディレクトリ。未指定時は ${TMPDIR}/bd-heartbeat.<uid> */
  readonly heartbeatStateDir?: string;
}

export interface PsRow {
  readonly pid: number;
  readonly lstart: string;
  readonly command: string;
}

export interface PsRawRow {
  readonly pid: number;
  readonly lstart: string;
  readonly commandLine: string;
}

export interface HeartbeatPidfileRecord {
  readonly sessionPid: number;
  readonly lstart: string | undefined;
}
