import type { Delivery } from "../relay/outbox";

/** Canonical signed coordinate, bound to the owning community session. */
export type WorkflowReference = Readonly<{
  id: string;
  owner: string;
  channelId: string;
}>;

/** Configuration intent, not proof of runtime presence, enabled state or authority. */
export type WorkflowDefinition = WorkflowReference &
  Readonly<{
    revision: string;
    createdAt: number;
    yaml: string;
  }>;

export type WorkflowDefinitions = Readonly<{
  items: readonly WorkflowDefinition[];
  /** A bounded configuration snapshot is not a complete runtime inventory. */
  partial: boolean;
}>;

/** Views belong to a captured session; dispose only releases this read interest. */
export interface WorkflowView<T> {
  snapshot(): Readonly<{
    status: "idle" | "loading" | "ready" | "error" | "unavailable";
    data: T;
    error?: string;
  }>;
  subscribe(listener: () => void): () => void;
  refresh(): Promise<void>;
  dispose(): void;
}

/** Preserve the relay cursor pair verbatim, including fractional timestamp precision. */
export type WorkflowRunCursor = Readonly<{ before: string; beforeId: string }>;
export type WorkflowRun = Readonly<{
  id: string;
  workflowId: string;
  status:
    | "pending"
    | "running"
    | "waiting_approval"
    | "completed"
    | "failed"
    | "cancelled";
  currentStep: number;
  trace: readonly unknown[];
  startedAt: number | null;
  completedAt: number | null;
  createdAt: number;
  errorCode: string | null;
  errorMessage: string | null;
}>;
export type WorkflowRunPage = Readonly<{
  runs: readonly WorkflowRun[];
  next: WorkflowRunCursor | null;
}>;
export type WorkflowApproval = Readonly<{
  /** Hashed reference, NEVER an actionable approval token. */
  reference: string;
  runId: string;
  stepId: string;
  status: "pending" | "granted" | "denied" | "expired";
  note: string | null;
  createdAt: number;
}>;

/** Delivery evidence and domain outcome are deliberately separate. No secret here. */
export type WorkflowOperation = Readonly<{
  eventId: string;
  workflow: WorkflowReference;
  action: "save" | "delete" | "trigger";
  delivery: Delivery;
  outcome: "pending" | "succeeded" | "rejected" | "unknown";
  error?: string;
  runId?: string;
  /** A secret can be consumed once, never journaled or automatically copied. */
  secretAvailable: boolean;
}>;

/** Host availability, NOT per-row permission; the relay remains authoritative. */
export type WorkflowAvailability = Readonly<{
  definitions: boolean;
  history: boolean;
  save: boolean;
  trigger: boolean;
  /** Requires the repaired relay lifecycle contract, not merely kind-5 support. */
  delete: boolean;
  webhookSecrets: boolean;
}>;

/** Bundled UI contract. No socket, signer, arbitrary HTTP, scheduler or approval writes. */
export interface WorkflowCapability {
  readonly availability: WorkflowAvailability;
  definitions(channelId: string): WorkflowView<WorkflowDefinitions>;
  runs(
    workflow: WorkflowReference,
    cursor?: WorkflowRunCursor,
  ): WorkflowView<WorkflowRunPage>;
  approvals(
    workflow: WorkflowReference,
    runId: string,
  ): WorkflowView<readonly WorkflowApproval[]>;
  /** Synchronous local intent ID; follow operations for delivery and domain completion.
   * Existing definitions preserve author/channel/id and use their signed revision.
   * New definitions get a new UUID. YAML mode uses the same host restrictions.
   */
  save(
    input: Readonly<{
      channelId: string;
      yaml: string;
      existing?: WorkflowDefinition;
    }>,
  ): string;
  delete(workflow: WorkflowDefinition): string;
  trigger(workflow: WorkflowDefinition): string;
  operations: Readonly<{
    snapshot(): readonly WorkflowOperation[];
    subscribe(listener: () => void): () => void;
    /** Exact signed replay only; never creates a new event or recovers a lost receipt. */
    retry(eventId: string): void;
    dismiss(eventId: string): Promise<void>;
  }>;
  /** Consume in response to explicit reveal; caller must clear display on scope/access loss.
   * Returns undefined after consumption, clear-cache, access revocation or disposal.
   */
  takeWebhookSecret(eventId: string): string | undefined;
}
