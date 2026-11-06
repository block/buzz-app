import { useMemo } from "react";
import { buzzLinkTarget } from "../navigation/buzz-links";
import type { Navigation } from "../navigation/controller";
import type { RelaySession } from "../relay/session";
import { MAX_MARKDOWN_LENGTH, scanMarkdown } from "../relay/message-content";
import { SafeMarkdown } from "./SafeMarkdown";

/** Host document rendering with optional local link handling before host navigation. */
export type MarkdownProps = {
  content: string;
  session?: RelaySession | undefined;
  /** True handles the link locally; false falls through to the host. */
  openLink?: ((url: string) => boolean) | undefined;
};

/** Installed documents use the host's parsing bounds, URL rules and rich links. */
export function PluginMarkdown({
  content,
  session,
  openLink,
  navigation,
}: MarkdownProps & { navigation?: Navigation | undefined }) {
  const plain = useMemo(
    () => content.length > MAX_MARKDOWN_LENGTH || scanMarkdown(content).tooDeep,
    [content],
  );
  return plain ? (
    <pre>{content}</pre>
  ) : (
    <SafeMarkdown
      content={content}
      session={session}
      openLink={(url) => {
        if (openLink?.(url)) return true;
        if (!session || !navigation) return false;
        const target = buzzLinkTarget(url, {
          viewer: session.viewer ?? "",
          communityOrigin: session.scope.replace(/:[0-9a-f]{64}$/, ""),
        });
        if (!target) return false;
        void navigation.open(target);
        return true;
      }}
    />
  );
}
