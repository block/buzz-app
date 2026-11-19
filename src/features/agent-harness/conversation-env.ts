// The public context of the conversation a harness session serves, as the
// variables Buzz's terminal gives a shell (docs/terminal.md), so commands an
// agent runs can tell which conversation started them. A session's
// conversation never changes, so neither do these: a session shared by a
// whole channel has no thread. Terminal-only variables (`BUZZ_TERM_*`) and
// `BUZZ_RELAY_URL`, which `buzz` reads as its relay in place of the one its
// credential provider picks, are never set.
import { canonicalPublicKey } from "../../shared/identity/public-key";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EVENT_ID = /^[0-9a-f]{64}$/i;
/** The terminal's rule for `BUZZ_CHANNEL`: a name a shell gives no meaning
 * to, else the channel UUID. */
const SAFE_NAME = /^[\p{Alphabetic}\p{N} ._-]{1,64}$/u;

export type ConversationContext = Readonly<{
  channelId: string;
  channelName?: string | undefined;
  /** The thread the session serves; absent for a channel or DM session. */
  root?: string | undefined;
  /** The agent's owner, the person whose app runs it. */
  owner: string;
}>;

/** No variables for a conversation the terminal would refuse to describe. */
export function conversationEnv({
  channelId,
  channelName,
  root,
  owner,
}: ConversationContext): Record<string, string> {
  const npub = canonicalPublicKey(owner);
  if (!UUID.test(channelId) || (root && !EVENT_ID.test(root)) || !npub)
    return {};
  return {
    BUZZ_CHANNEL_ID: channelId,
    BUZZ_CHANNEL:
      channelName && SAFE_NAME.test(channelName) ? channelName : channelId,
    BUZZ_NPUB: npub,
    ...(root ? { BUZZ_THREAD_ID: root } : {}),
  };
}
