import type { PageNavigation } from "../navigation/service";
import { relayPartition } from "../relay/partition";
import { readView, viewRevision, writeView } from "../../shared/view-state";
import { hasDraftContent, mentionDraft } from "./mention-draft";

/** Visit position key: this visit already applied its link draft. */
const SEEDED = "link-draft-seeded";

/** Apply a `buzz://message` link's draft to the thread it opened, once per
 * visit: the text becomes that thread's saved composer draft when the draft
 * is empty, so a link never replaces what someone wrote and never sends.
 * `scope` is the thread's own partition, `messageId` the message it was asked
 * to open and `rootId` that message's resolved root; a link bound to another
 * community, viewer, channel or message is ignored. The draft then leaves the
 * visit's address while the visit can still resolve. */
export function applyLinkDraft(
  navigation: PageNavigation,
  scope: string,
  channelId: string,
  messageId: string,
  rootId: string,
) {
  const target = navigation.target;
  if (
    target.kind !== "conversation" ||
    target.draft === undefined ||
    target.channelId !== channelId ||
    target.messageId !== messageId ||
    relayPartition(target.scope.communityOrigin, target.scope.viewer) !== scope
  )
    return;
  if (!navigation.position(SEEDED)) {
    const key = `draft:${channelId}:thread:${rootId}`;
    // Unreadable storage could hide a saved draft; leave it alone.
    if (
      viewRevision(scope, key) !== undefined &&
      !hasDraftContent(mentionDraft(readView<unknown>(scope, key, "")))
    )
      writeView(scope, key, target.draft);
    navigation.savePosition(SEEDED, true);
  }
  const { draft: _draft, ...address } = target;
  navigation.resolve(address);
}
