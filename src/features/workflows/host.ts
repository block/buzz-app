import type { WorkflowRunCursor } from "./types.ts";

/** Host-owned authenticated reads on the captured relay principal/admission lane. */
export interface WorkflowHost {
  /** Positive forward lifecycle contract evidence, never inferred from kind support. */
  readonly lifecycleVersion?: 1;
  runs(
    id: string,
    cursor: WorkflowRunCursor | undefined,
    signal: AbortSignal,
  ): Promise<unknown>;
  approvals(id: string, runId: string, signal: AbortSignal): Promise<unknown>;
}
