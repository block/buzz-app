import { createContext } from "react";
import type { MentionRecipient } from "./mention-draft";

/** Composer-local candidates before a channel exists; delivery still validates membership. */
export const DraftMentionRoster = createContext<
  readonly MentionRecipient[] | undefined
>(undefined);
