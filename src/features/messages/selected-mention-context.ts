import { createContext } from "react";
import type { MentionRecipient } from "./mention-draft";
/** Selected keys participate in naming even if no longer eligible for another selection. */
export const SelectedMentionContext = createContext<
  readonly MentionRecipient[]
>([]);
