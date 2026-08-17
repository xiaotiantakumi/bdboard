export interface ProcessProbe {
  /** process.kill(pid, 0) equivalent. Returns true when the process is alive. */
  isAlive(pid: number): boolean;
}
