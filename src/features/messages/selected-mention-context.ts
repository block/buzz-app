import { createContext } from "react";
import type { MentionRecipient } from "./mention-draft";
import type { SoloRegionBinding } from "../channel-navigation/solo-navigation-contract";
/** Selected keys participate in naming even if no longer eligible for another selection. */
export const SelectedMentionContext = createContext<
  readonly MentionRecipient[]
>([]);
/** Host task toolbar state; separate from authored mention intent. */
export const TaskRecipientContext = createContext<
  | {
      pubkey?: string | undefined;
      selectPrimary?: ((pubkey: string) => boolean) | undefined;
      eligible?: ((pubkey: string) => boolean) | undefined;
    }
  | undefined
>(undefined);
/** A host task composer's region, for bundled completions only: `@` folder
 * rows, and `#` workspaces while `draft` (before the task chat exists). */
export const TaskCompletionContext = createContext<
  Readonly<{ binding: SoloRegionBinding; draft: boolean }> | undefined
>(undefined);
