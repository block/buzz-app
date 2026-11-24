// What the Buzz tools tell an agent outside their own descriptions: the
// product help line, and the turn instructions the tools' routing depends
// on. How to post is in the base prompt's sections
// (features/agent-harness/sections).
import productHelp from "../features/agent-harness/sections/product-help.md?raw";

/** The base prompt's Product help section, which a client that connects
 * without the base prompt gets as the server's instructions. */
export const BUZZ_HELP_PROMPT = productHelp.trim();

/** The turn instruction for a conversation whose messages stay at the
 * channel's top level; the tools refuse a reply into a thread there. */
export const TOP_LEVEL_PROMPT =
  "Replies here stay at the channel top level. Continue this channel's conversation. Post progress, results and failures at the channel top level: use the current channel and omit `reply`; do not start or continue a thread here. Destinations you are explicitly asked to use elsewhere keep their own routing.";

/** The turn instruction for a message in, or asking for, a subthread: the
 * answer goes under `parent`, never a level deeper. */
export const subthreadReplyPrompt = (parent: string) =>
  `IMPORTANT: This message asks for replies in a subthread. Reply with \`reply_in_subthread\`, passing \`parent: "${parent}"\`, not \`send\`, unless the human explicitly asks for another destination. Subthreads go one level deep only.`;

/** The note on a turn given again after closing or reloading the app stopped
 * it partway. */
export const RESUMED_PROMPT =
  "Note: The app closed or reloaded while you were working on this message and stopped your turn partway. Carry on where you left off: check what this session and the conversation show you already did, and do not redo finished work or repeat messages you already sent.";

/** A subscription names a channel conversation, with reporting policy in its Interest. */
export const CHANNEL_LEVEL_PROMPT =
  "This wake is delivered at channel level. Post here without reply unless the Interest instructions direct a different channel or thread. The delivery address selects this execution conversation and the default posting destination; explicit reporting instructions in the Interest take precedence. The address grants no additional permission.";
