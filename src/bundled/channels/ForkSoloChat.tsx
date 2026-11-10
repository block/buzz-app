import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  communityRequest,
  type CommunityInfo,
} from "../../features/communities/api";
import {
  conversationTarget,
  soloForkDraft,
  soloForkTarget,
  type SoloForkDraft,
} from "../../features/channel-navigation/routes";
import type { Navigation } from "../../features/navigation/controller";
import type { PageNavigation } from "../../features/navigation/service";
import type { ChannelMessage } from "../../features/relay/contracts";
import { hasEventProof } from "../../features/relay/events";
import { compareMessages } from "../../features/relay/message-order";
import { splitPartition } from "../../features/relay/partition";
import type { RelaySession } from "../../features/relay/session";
import { threadReference } from "../../features/relay/thread-reference";
import { ownSolo } from "../../features/solo/labels";
import { readView, writeView } from "../../shared/view-state";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import { MenuItem } from "../../shared/design-system/ui/Menu";
import { Select } from "../../shared/design-system/ui/Select";
import { useToastNotification } from "../../shared/design-system/ui/Toast";
import styles from "../../features/solo/WorkspaceSettings.module.css";

export function canForkSolo(session: RelaySession, id: string) {
  const channel = session.channels.get?.(id);
  return !!(
    ownSolo(channel, session.viewer) &&
    channel &&
    !channel.cached &&
    !channel.metadataCached &&
    !channel.metadataPending &&
    !channel.pending &&
    !channel.archived &&
    !channel.readOnly &&
    !!session.viewer &&
    channel.members?.includes(session.viewer) &&
    !(
      channel.ttlSeconds &&
      channel.createdAt &&
      channel.createdAt + channel.ttlSeconds <= Date.now() / 1000
    ) &&
    session.channelWrites.available
  );
}
const accepted = (row: ChannelMessage) =>
  !row.delivery || ["accepted", "seen"].includes(row.delivery);

/** The existing menu owns anchoring. Opening captures intent, never creates a chat. */
export function ForkSoloChat({
  session,
  navigation,
  channelId,
  message,
}: {
  session: RelaySession;
  navigation: Navigation;
  channelId: string;
  message?: ChannelMessage;
}) {
  const notify = useToastNotification();
  return (
    <MenuItem
      disabled={!canForkSolo(session, channelId)}
      onClick={() => {
        if (!canForkSolo(session, channelId)) return;
        const window = session.channels.window(channelId);
        const cutoff =
          message ??
          (!window.hasNewer && window.status === "ready"
            ? window.rows
                .filter((row) => accepted(row) && !row.membership && !row.diff)
                .slice()
                .sort(compareMessages)
                .at(-1)
            : undefined);
        if (!cutoff || cutoff.channelId !== channelId || !accepted(cutoff)) {
          notify(
            "Open the latest messages or choose an accepted message to fork.",
            "error",
          );
          return;
        }
        void navigation
          .open(
            soloForkTarget(session.scope, {
              channelId,
              messageId: cutoff.id,
              destination: crypto.randomUUID(),
            }),
          )
          .then((result) => {
            if (result.status === "failed")
              notify(
                "The fork form couldn’t open. Nothing was created.",
                "error",
              );
          });
      }}
    >
      Fork chat from here
    </MenuItem>
  );
}

type Form = { title: string; agent: string; submitted?: true };
/** Before submission: durable view intent. After enqueue: only the destination owns recovery. */
export function SoloForkDialog({
  session,
  navigation,
  visit,
  draft,
}: {
  session: RelaySession;
  navigation: Navigation;
  visit: PageNavigation;
  draft: SoloForkDraft;
}) {
  const key = `solo:fork:${draft.destination}`;
  const source = session.channels.get?.(draft.channelId);
  const [form, setForm] = useState<Form>(() => {
    const fallback = {
      title: source?.name ? `Fork of ${source.name}` : "Forked chat",
      agent: "",
    };
    const saved = readView<Partial<Form> | null>(session.scope, key, null);
    return saved &&
      typeof saved.title === "string" &&
      typeof saved.agent === "string" &&
      (saved.submitted === undefined || saved.submitted === true)
      ? (saved as Form)
      : fallback;
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [evidence, setEvidence] = useState<{
    retained: string;
    destination: string;
    checkedAt: string;
  }>();
  const fence = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const choices = useSyncExternalStore(
    session.agentChoices.subscribe,
    session.agentChoices.snapshot,
  );
  useEffect(() => session.agentChoices.ensure(true, true), [session]);
  const agents = choices.selectable.filter((row) => row.runtime === "claude");
  const current = () =>
    mounted.current &&
    !visit.signal.aborted &&
    visit.target.kind === "page" &&
    visit.target.scope?.viewer === session.viewer &&
    visit.target.scope?.communityOrigin ===
      splitPartition(session.scope)?.communityOrigin;
  function save(next: Form) {
    if (!writeView(session.scope, key, next))
      throw new Error(
        "The fork form couldn’t be saved. Nothing was submitted.",
      );
    setForm(next);
  }
  function retire(id: string) {
    navigation.dismiss(
      (target) =>
        target.kind === "page" &&
        target.scope?.viewer === session.viewer &&
        target.scope?.communityOrigin ===
          splitPartition(session.scope)?.communityOrigin &&
        soloForkDraft(target.route?.params)?.destination === draft.destination,
      conversationTarget(session.scope, id),
    );
  }
  async function openDestination() {
    const opening = navigation.open(
      conversationTarget(session.scope, draft.destination),
    );
    const attempt = navigation.snapshot().attempt.id;
    const result = await opening;
    if (
      result.status === "opened" &&
      navigation.snapshot().attempt.id === attempt
    )
      retire(draft.destination);
    else if (
      result.status === "failed" &&
      navigation.snapshot().attempt.id === attempt &&
      mounted.current
    )
      setError(
        "The destination couldn’t open. Open the same fork again; do not create another chat.",
      );
  }
  // An interrupted fence is intent, not proof that a create was (or was not)
  // published. Check existing owners; absence never authorizes a replacement.
  async function checkSubmission() {
    if (fence.current || !current()) return;
    fence.current = true;
    setBusy(true);
    setError(undefined);
    let retained = "unknown",
      destination = "not checked";
    try {
      const saved = await session.outbox?.recovery(
        `solo-fork:${draft.destination}`,
      );
      if (!current()) return;
      retained = saved ? "yes" : session.outbox ? "no" : "unavailable";
      if (!saved) {
        destination = "unknown";
        await session.channels.resolve?.([draft.destination], {
          signal: visit.signal,
          consistency: "strong",
        });
        if (!current()) return;
        const channel = session.channels.get?.(draft.destination);
        destination = session.channels.resolve
          ? channel?.forkClaim
            ? "claim found"
            : "no claim found"
          : "unavailable";
        if (!channel?.forkClaim)
          throw new Error(
            "Submission unresolved: no retained create or destination claim was found. Retry submission check when connected. Nothing will be re-enqueued or signed from this form.",
          );
        // A claim permits navigation, not delivery. Only the destination lock
        // checks signed ancestry and reports its errors; no second modal lock.
      }
      if (current()) await openDestination();
    } catch (reason) {
      if (current())
        setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      fence.current = false;
      if (current()) {
        setEvidence({
          retained,
          destination,
          checkedAt: new Date().toISOString(),
        });
        setBusy(false);
      }
    }
  }
  async function submit() {
    if (fence.current || form.submitted || !current()) return;
    fence.current = true;
    setBusy(true);
    setError(undefined);
    try {
      if (readView<Partial<Form>>(session.scope, key, {}).submitted) {
        setForm({ ...form, submitted: true });
        fence.current = false;
        await checkSubmission();
        return;
      }
      if (!form.title.trim() || [...form.title].length > 120)
        throw new Error("Use a title between 1 and 120 characters.");
      const origin = splitPartition(session.scope)?.communityOrigin;
      if (!origin || !canForkSolo(session, draft.channelId))
        throw new Error("This source chat is no longer available to fork.");
      const info = await communityRequest<CommunityInfo>(
        origin,
        "info",
        undefined,
        visit.signal,
      );
      if (!current()) return;
      if (!info.soloFork)
        throw new Error("This community does not support Solo forks.");
      const events = await session.readRemote(
        [
          {
            kinds: [9, 40002],
            ids: [draft.messageId],
            "#h": [draft.channelId],
            limit: 1,
            consistency: "strong",
          },
        ],
        { signal: visit.signal, fresh: true },
      );
      if (!current()) return;
      if (
        !events.some(
          (event) =>
            hasEventProof(event) &&
            event.id === draft.messageId &&
            [9, 40002].includes(event.kind) &&
            !threadReference(event) &&
            event.tags.some(
              ([name, value]) => name === "h" && value === draft.channelId,
            ),
        )
      )
        throw new Error("The selected cutoff message is unavailable.");
      if (
        !canForkSolo(session, draft.channelId) ||
        !session.agentChoices
          .snapshot()
          .selectable.some(
            (row) => row.pubkey === form.agent && row.runtime === "claude",
          )
      )
        throw new Error(
          "Choose an available Claude agent and an accessible source chat.",
        );
      // Persist the submission fence before enqueue. Restoration never calls start.
      save({ ...form, submitted: true });
      let operation: ReturnType<RelaySession["channelWrites"]["start"]>;
      try {
        operation = session.channelWrites.start(
          draft.destination,
          form.title.trim(),
          [form.agent],
          undefined,
          true,
          undefined,
          {
            forkedFrom: {
              channelId: draft.channelId,
              messageId: draft.messageId,
            },
          },
        );
      } catch (reason) {
        save(form); // A synchronous start rejection never enqueued a create.
        throw reason;
      }
      void operation.ready.catch(() => {}); // The destination's one lock reports ancestry failures.
      await openDestination();
    } catch (reason) {
      if (current())
        setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      fence.current = false;
      if (current()) setBusy(false);
    }
  }
  return (
    <Dialog
      open
      visit
      size="compact"
      title="Fork Solo chat"
      description="Start a private chat with live inherited context through the selected message. Projects, Canvas, tools and other members are not copied."
      preventClose={busy}
      onOpenChange={(open) => {
        if (!open) retire(form.submitted ? draft.destination : draft.channelId);
      }}
      actions={
        <>
          <Button
            disabled={busy}
            onClick={() =>
              retire(form.submitted ? draft.destination : draft.channelId)
            }
          >
            Cancel
          </Button>
          <Button
            variant="prominent"
            loading={busy}
            disabled={
              busy ||
              (!form.submitted &&
                (!form.agent || !canForkSolo(session, draft.channelId)))
            }
            onClick={() => void (form.submitted ? checkSubmission() : submit())}
          >
            {form.submitted ? "Check submission / open fork" : "Create fork"}
          </Button>
        </>
      }
    >
      <div className={styles.fields}>
        {!form.submitted && (
          <>
            <Field label="Chat title">
              <Input
                value={form.title}
                disabled={busy}
                onValueChange={(title) => {
                  try {
                    save({ ...form, title });
                  } catch (reason) {
                    setError(String(reason));
                  }
                }}
              />
            </Field>
            <Select
              label="Claude agent"
              variant="field"
              value={form.agent}
              disabled={busy}
              placeholder="Choose an agent"
              groups={[
                {
                  label: "Claude",
                  options: agents.map((row) => ({
                    value: row.pubkey,
                    label: row.name,
                  })),
                },
              ]}
              onValueChange={(agent) => {
                try {
                  save({ ...form, agent });
                } catch (reason) {
                  setError(String(reason));
                }
              }}
            />
            {!agents.length && (
              <p>
                No available Claude agents. Configure one in Agents before
                creating a fork.
              </p>
            )}
            <p className="text-caption text-subtle">
              Inclusive cutoff: {draft.messageId}
            </p>
          </>
        )}
        {form.submitted && (
          <p>
            Submission was requested for the original destination. Check for its
            retained create or destination claim before opening it; this form
            never repeats Create.
          </p>
        )}
        {evidence && (
          <p className="text-caption text-subtle" role="status">
            Retained create: {evidence.retained}. Destination:{" "}
            {evidence.destination}. Last checked:{" "}
            <time dateTime={evidence.checkedAt}>{evidence.checkedAt}</time>.
          </p>
        )}
        {error && <p role="alert">{error}</p>}
      </div>
    </Dialog>
  );
}
