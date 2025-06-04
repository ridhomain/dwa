import { StringCodec } from 'nats';

const sc = StringCodec();

// Configuration
const FAILURE_RATE_THRESHOLD = 0.1; // 10% failure rate

// Simplified broadcast status types (Agent API only needs to know these)
export type BroadcastStatus =
  | 'SCHEDULED'
  | 'STARTING'
  | 'PROCESSING'
  | 'PAUSED'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'FAILED';

// Simplified broadcast state interface
export interface BroadcastState {
  status: BroadcastStatus;
  batchId: string;
  agentId: string;
  companyId: string;
  total: number;
  processed: number;
  completed: number;
  failed: number;
  lastUpdated?: string;
  [key: string]: any; // Allow other fields
}

// Check if transition is valid (simplified for Agent API)
function canTransition(from: BroadcastStatus, to: BroadcastStatus): boolean {
  // Agent API only needs to know about auto-transitions
  const validTransitions: Record<BroadcastStatus, BroadcastStatus[]> = {
    PROCESSING: ['COMPLETED', 'FAILED'],
    STARTING: ['PROCESSING'],
    // Other states are controlled by WA Service
    SCHEDULED: [],
    PAUSED: [],
    COMPLETED: [],
    CANCELLED: [],
    FAILED: [],
  };

  return validTransitions[from]?.includes(to) ?? false;
}

// Derive broadcast status from task statistics
function deriveBroadcastStatus(state: BroadcastState): BroadcastStatus {
  const { status, total, failed, processed } = state;

  // User-controlled states take precedence
  if (status === 'CANCELLED' || status === 'PAUSED') {
    return status;
  }

  // Not started yet
  if (processed === 0) {
    return status; // Keep current status
  }

  // In progress
  if (processed < total) {
    return 'PROCESSING';
  }

  // All done - check quality
  if (processed === total) {
    const failureRate = total > 0 ? failed / total : 0;
    if (failureRate > FAILURE_RATE_THRESHOLD) {
      return 'FAILED';
    }
    return 'COMPLETED';
  }

  return status;
}

// Update broadcast progress based on task completion
// This is the main function Agent API uses
export async function updateBroadcastProgress(
  kv: any,
  batchId: string,
  agentId: string,
  taskUpdate: { status: 'COMPLETED' | 'ERROR'; phoneNumber: string }
): Promise<void> {
  const stateKey = `${agentId}_${batchId}`;

  const maxRetries = 3;
  for (let i = 0; i < maxRetries; i++) {
    try {
      const entry = await kv.get(stateKey);
      if (!entry?.value) {
        // State might not exist yet or expired
        return;
      }

      const state: BroadcastState = JSON.parse(sc.decode(entry.value));

      // Update counters based on task status
      switch (taskUpdate.status) {
        case 'COMPLETED':
          state.completed = (state.completed || 0) + 1;
          break;
        case 'ERROR':
          state.failed = (state.failed || 0) + 1;
          break;
      }

      state.processed = state.completed + state.failed;

      // Auto-derive broadcast status if not user-controlled
      if (!['PAUSED', 'CANCELLED'].includes(state.status)) {
        const derivedStatus = deriveBroadcastStatus(state);

        // Only update if status actually changes and transition is valid
        if (derivedStatus !== state.status && canTransition(state.status, derivedStatus)) {
          state.status = derivedStatus;

          // Add completion timestamp if transitioning to terminal state
          if (derivedStatus === 'COMPLETED' || derivedStatus === 'FAILED') {
            state.completedAt = new Date().toISOString();
          }
        }
      }

      state.lastUpdated = new Date().toISOString();

      // Save with version check
      await kv.update(stateKey, sc.encode(JSON.stringify(state)), entry.revision);

      return; // Success
    } catch (err: any) {
      if (err.message?.includes('wrong last sequence') && i < maxRetries - 1) {
        // Version conflict - retry
        continue;
      }
      // Log error but don't throw - this is a non-critical update
      console.error(`[updateBroadcastProgress] Failed to update state: ${err.message}`);
      return;
    }
  }
}
