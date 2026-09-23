import type { NextUpLoopProgress } from './types';

export const INITIAL_NEXT_UP_LOOP_PROGRESS: NextUpLoopProgress = {
  currentTicketId: null,
  completedCount: 0,
  failedCount: 0,
  cancelledCount: 0,
  unknownCount: 0,
  totalCount: 0,
  lastFailureReason: null,
  endReason: null,
};
