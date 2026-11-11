import { useSyncExternalStore } from "react";
import type { Contribution } from "../../plugins/contributions";
import type { ContributionReader, TabAction } from "../conversation/contracts";
import type { RelaySession } from "../relay/session";
import { MenuIcon, MenuItem } from "../../shared/design-system/ui/Menu";

const none: readonly Contribution<TabAction>[] = [];
const noActions = () => none;
const noSubscription = () => () => {};

/** Contributed conversation actions (Open in new window) as menu items, in
 * the place every conversation menu gives them: right after Copy link. A
 * failing contribution hides itself, not the menu. */
export function ConversationActionItems({
  tabActions,
  session,
  channelId,
}: {
  tabActions: ContributionReader<TabAction> | undefined;
  session: RelaySession;
  channelId: string;
}) {
  const actions = useSyncExternalStore(
    tabActions?.subscribe ?? noSubscription,
    tabActions?.snapshot ?? noActions,
  );
  return (
    <>
      {actions
        .filter((action) => {
          try {
            return action.matches({ channelId }, session);
          } catch {
            return false;
          }
        })
        .map((action) => (
          <MenuItem
            key={`action:${action.key}`}
            onClick={() => action.run({ channelId }, session)}
          >
            {action.icon && (
              <MenuIcon>
                <action.icon />
              </MenuIcon>
            )}
            {action.title}
          </MenuItem>
        ))}
    </>
  );
}
