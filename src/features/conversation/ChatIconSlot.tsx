import {
  createContext,
  useContext,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { OwnedContribution } from "../../plugins/OwnedContribution";
import type { RelaySession } from "../relay/session";
import type { Conversation } from "./service";

/** Plugin icons for Solo chats, supplied once by the shell to every row. */
export const ChatIcons = createContext<Conversation["chatIcons"] | undefined>(
  undefined,
);

/** What a plugin knows about a Solo chat, beside its name; else `fallback`. */
export function ChatIconSlot({
  session,
  channelId,
  fallback = null,
}: {
  session: RelaySession;
  channelId: string;
  fallback?: ReactNode;
}) {
  const icons = useContext(ChatIcons);
  const entry = useSyncExternalStore(
    icons?.subscribe ?? noSubscription,
    () => icons?.snapshot()[0],
  );
  if (!icons || !entry) return fallback;
  const Icon = entry.component;
  return (
    <OwnedContribution entry={entry} registry={icons} fallback={fallback}>
      {() => (
        <Icon session={session} channelId={channelId} fallback={fallback} />
      )}
    </OwnedContribution>
  );
}

const noSubscription = () => () => {};
