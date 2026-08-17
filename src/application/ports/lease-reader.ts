export interface InProgressWithLease {
  readonly id: string;
  readonly leaseExpiresAt: string | null;
  readonly heartbeatAt: string | null;
}

export interface LeaseReader {
  listInProgressWithLease(projectRootPath: string): Promise<readonly InProgressWithLease[]>;
}
