import { useEffect, useState } from "react";
import { nativeIdentityEnabled } from "../../features/identity/service";
import { communityFromScope } from "../../features/relay/gifs";
import { nativeRelayInfo } from "../../features/relay/native";
import {
  workflowAgentMentions,
  type WorkflowAgentMentions,
} from "./workflowAgentMentionWarning";

/** The active community's NIP-11 mode, read once per community. `any` until
 * read, when unreadable, and on hosts with no NIP-11 reader. */
export function useWorkflowAgentMentions(scope: string): WorkflowAgentMentions {
  const community = communityFromScope(scope);
  const [mode, setMode] = useState<{
    community: string;
    mode: WorkflowAgentMentions;
  }>();
  useEffect(() => {
    if (!community || !nativeIdentityEnabled()) return;
    const controller = new AbortController();
    nativeRelayInfo(community, controller.signal).then(
      (info) => setMode({ community, mode: workflowAgentMentions(info) }),
      () => {},
    );
    return () => controller.abort();
  }, [community]);
  return mode?.community === community ? mode.mode : "any";
}
