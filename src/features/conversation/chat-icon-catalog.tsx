import type { ComponentType } from "react";
import type { ChatIconName } from "./service";
import {
  ChatCircleIcon,
  CheckCircleIcon,
  CircleDashedIcon,
  GitHubIssueIcon,
  GitMergeIcon,
  GitPullRequestIcon,
  XCircleIcon,
} from "../../shared/design-system/icons";

/** The artwork a `ChatIconName` stands for, so a host can draw a plugin's
 * chat icon from data where the plugin's component cannot run. */
export const chatIconCatalog: Record<
  ChatIconName,
  ComponentType<{ size?: string | number; "aria-hidden"?: "true" }>
> = {
  chat: ChatCircleIcon,
  "git-pull-request": GitPullRequestIcon,
  "git-merge": GitMergeIcon,
  "circle-dashed": CircleDashedIcon,
  "x-circle": XCircleIcon,
  "check-circle": CheckCircleIcon,
  issue: GitHubIssueIcon,
};

/** The icon for a name, or the chat default for one this host doesn't know. */
export function chatIconFor(name: string) {
  return (
    (
      chatIconCatalog as Record<
        string,
        ComponentType<{ size?: string | number }>
      >
    )[name] ?? ChatCircleIcon
  );
}
