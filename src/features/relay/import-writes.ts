import type { EventTemplate } from "nostr-tools";
import type { ExplicitTimestampInput, LocalEvents } from "./outbox";

/** Host-only conversation import writes. Plugins see the session object but
 * cannot reach this module, so these capabilities stay with the host service
 * that shows the confirmation dialogs. */
export type ImportWriter = Readonly<{
  /** Imported history at its original time; see `sendAt` in `createOutbox`. */
  sendAt(input: ExplicitTimestampInput): string;
  /** Proposal, consent, withdrawal and completion records. */
  sendRecord(input: Pick<EventTemplate, "kind" | "content" | "tags">): string;
  /** Retries an import entry; the plugin-visible retry refuses them. */
  retry(id: string): void;
  /** Removes an entry from the journal, for refused or abandoned imports. */
  dismiss(id: string): Promise<void>;
  /** Raw journal, including confirmed events, for delivery tracking. */
  local: LocalEvents;
}>;

const writers = new WeakMap<object, { writer: ImportWriter; owner?: object }>();

export function registerImportWriter(session: object, writer: ImportWriter) {
  if (writers.has(session))
    throw new Error("This session already has an import writer.");
  writers.set(session, { writer });
}

/** The session's writer, bound to the first claimant; any other claimant gets
 * nothing, so a second import service cannot sign through this session. */
export function claimImportWriter(
  session: object,
  claimant: object,
): ImportWriter | undefined {
  const entry = writers.get(session);
  if (!entry) return;
  entry.owner ??= claimant;
  return entry.owner === claimant ? entry.writer : undefined;
}
