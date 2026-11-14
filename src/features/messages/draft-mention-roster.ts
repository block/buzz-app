import { createContext } from "react";
import type { MentionRecipient } from "./mention-draft";

/** Composer-local candidates before a channel exists; delivery still validates membership. */
export type MentionRoster = {
  recipients: readonly MentionRecipient[];
  /** An unaddressed draft can search its owner's directory as @ completion opens. */
  onQuery?: ((query: string | undefined) => void) | undefined;
  /** Set while the owner's sources are still loading, so a name may be
   * missing: the recipients once they settle. A pending mention outlives the
   * chooser that saw the partial roster and resolves against these. */
  pending?: Promise<readonly MentionRecipient[]> | undefined;
};

export const DraftMentionRoster = createContext<MentionRoster | undefined>(
  undefined,
);
