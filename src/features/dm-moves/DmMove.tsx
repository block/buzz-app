import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { splitPartition } from "../relay/partition";
import type { RelaySession } from "../relay/session";
import type { Navigation } from "../navigation/controller";
import type { ChannelMessage } from "../relay/contracts";
import type { RelayData } from "../relay/service";
import { conversationTarget } from "../channel-navigation/routes";
import { eventMs } from "../relay/message-order";
import { threadReference } from "../relay/thread-reference";
import {
  namedChannel,
  useChannelReference,
} from "../conversation/channel-reference";
import { BuzzLinkPreview } from "../conversation/BuzzLinkPreview";
import { dmMoves, type DmMoves, type MoveSnapshot } from "./coordinator";
import type { MoveState } from "./protocol";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { Button } from "../../shared/design-system/ui/Button";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import { Textarea } from "../../shared/design-system/ui/Textarea";
import { Select } from "../../shared/design-system/ui/Select";
import { MenuItem, MenuIcon } from "../../shared/design-system/ui/Menu";
import { MessageReplyIcon } from "../../shared/design-system/icons";
import styles from "./DmMove.module.css";

const empty: MoveSnapshot = { moves: [], loading: true };
const noSubscribe = () => () => {};
function useMoves(session: RelaySession) {
  const moves = dmMoves(session);
  const snapshot = useSyncExternalStore(
    moves?.subscribe ?? noSubscribe,
    moves?.snapshot ?? (() => empty),
  );
  return { moves, snapshot };
}
export function canConvertDm(session: RelaySession, id: string) {
  const c = session.channels.get?.(id);
  return !!(
    dmMoves(session) &&
    c?.channelType === "dm" &&
    !c.cached &&
    !c.readOnly &&
    !c.archived
  );
}
export function openDmMove(
  navigation: Navigation,
  session: RelaySession,
  channelId: string,
  from = "all",
) {
  const target = conversationTarget(session.scope, channelId);
  if (target.kind === "conversation")
    void navigation.open({ ...target, dmMove: from });
}
export function DmMoveMenuItem({
  session,
  channelId,
  navigation,
}: {
  session: RelaySession;
  channelId: string;
  navigation: Navigation;
}) {
  if (!canConvertDm(session, channelId)) return null;
  return (
    <MenuItem onClick={() => openDmMove(navigation, session, channelId)}>
      <MenuIcon>
        <MessageReplyIcon size={16} aria-hidden="true" />
      </MenuIcon>
      Convert to thread
    </MenuItem>
  );
}

/** Addressable form: Back hides it, Forward restores it, Close retires its visits. */
export function DmMovePresentation({
  session,
  navigation,
  children,
}: {
  session: RelaySession;
  navigation: Navigation;
  children: ReactNode;
}) {
  const current = useSyncExternalStore(
    navigation.subscribe,
    navigation.snapshot,
  ).entry.target;
  const requested =
    current.kind === "conversation" &&
    current.scope.viewer === session.viewer &&
    current.scope.communityOrigin ===
      splitPartition(session.scope)?.communityOrigin &&
    current.dmMove
      ? current
      : undefined;
  // Passive history navigation hides the form without losing its draft or
  // in-flight submission. Explicit dismissal retires the retained presentation.
  const retained = useRef<typeof requested>(undefined);
  if (requested) retained.current = requested;
  if (
    retained.current &&
    (retained.current.scope.viewer !== session.viewer ||
      retained.current.scope.communityOrigin !==
        splitPartition(session.scope)?.communityOrigin)
  )
    retained.current = undefined;
  const presented = requested ?? retained.current;
  const trigger = useRef<HTMLElement | null>(null);
  const previous = useRef(false);
  if (requested && !previous.current)
    trigger.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
  previous.current = !!requested;
  const dismiss = () => {
    if (!requested) return;
    if (
      retained.current?.channelId === requested.channelId &&
      retained.current.dmMove === requested.dmMove
    )
      retained.current = undefined;
    const { dmMove: _move, ...fallback } = requested;
    navigation.dismiss(
      (t) =>
        t.kind === "conversation" &&
        t.scope.viewer === requested.scope.viewer &&
        t.scope.communityOrigin === requested.scope.communityOrigin &&
        t.channelId === requested.channelId &&
        t.dmMove === requested.dmMove,
      fallback,
    );
  };
  return (
    <>
      {children}
      {presented && (
        <DmMoveDialog
          key={`${session.scope}:${presented.channelId}:${presented.dmMove}`}
          open={!!requested}
          session={session}
          channelId={presented.channelId}
          fromId={presented.dmMove ?? "all"}
          close={dismiss}
          finalFocus={trigger}
        />
      )}
    </>
  );
}

export function DmMoveDialog({
  open = true,
  session,
  channelId,
  fromId = "all",
  close,
  finalFocus,
}: {
  open?: boolean;
  session: RelaySession;
  channelId: string;
  fromId?: string;
  close(): void;
  finalFocus?: React.RefObject<HTMLElement | null>;
}) {
  const { moves } = useMoves(session);
  const list = useSyncExternalStore(
    session.channels.subscribeList,
    session.channels.list,
  );
  const [target, setTarget] = useState("");
  const [hours, setHours] = useState("24");
  const [from, setFrom] = useState<{ id: string; ms: number }>();
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const fields = useRef<HTMLDivElement>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    const lifetime = new AbortController();
    if (fromId !== "all")
      void session
        .readRemote(
          [{ kinds: [9, 40002], ids: [fromId], "#h": [channelId], limit: 1 }],
          { signal: lifetime.signal },
        )
        .then((events) => {
          if (!events[0])
            throw new Error(
              "The selected message is unavailable. Choose another message.",
            );
          if (threadReference(events[0]))
            throw new Error(
              "Conversion cannot start from a thread reply. Choose a message in the main DM.",
            );
          if (!lifetime.signal.aborted)
            setFrom({ id: events[0].id, ms: eventMs(events[0]) });
        })
        .catch((e) => {
          if (!lifetime.signal.aborted) setError(String(e));
        });
    return () => {
      mounted.current = false;
      lifetime.abort();
    };
  }, [session, channelId, fromId]);
  const channels = list.channels.filter(
    (c) =>
      c.channelType === "stream" &&
      !c.readOnly &&
      !c.cached &&
      !c.archived &&
      !!c.visibility,
  );
  const disabledReason = pending
    ? "Sending approval request…"
    : !moves
      ? "Conversion is unavailable on this connection."
      : !channels.length
        ? "Join a text channel before converting this DM."
        : !target
          ? "Choose a destination channel first."
          : fromId !== "all" && !from
            ? error || "Loading the starting message…"
            : !Number.isFinite(Number(hours)) ||
                Number(hours) < 1 / 60 ||
                Number(hours) > 720
              ? "Choose an approval window between one minute and 30 days."
              : undefined;
  const submit = async () => {
    if (!moves || disabledReason) return;
    setPending(true);
    setError("");
    try {
      await moves.start(
        channelId,
        target,
        Number(hours),
        fromId !== "all" ? from : undefined,
      );
      close();
    } catch (e) {
      if (mounted.current) {
        setError(e instanceof Error ? e.message : String(e));
        setPending(false);
      }
    }
  };
  return (
    <Dialog
      visit
      open={open}
      title="Convert to thread"
      description="Everyone in the DM must approve before any messages are copied or anyone is added to the channel."
      size="compact"
      headerGap="compact"
      preventClose={pending}
      onOpenChange={(open) => {
        if (!open) close();
      }}
      finalFocus={finalFocus}
      initialFocus={() =>
        fields.current?.querySelector<HTMLElement>('[role="combobox"]') ?? null
      }
      actions={
        <>
          <Button onClick={close} disabled={pending}>
            Cancel
          </Button>
          <Button
            variant="prominent"
            loading={pending}
            disabled={!!disabledReason}
            focusableWhenDisabled
            title={disabledReason}
            onClick={() => void submit()}
          >
            Request approval
          </Button>
        </>
      }
    >
      <div className={styles.form} ref={fields}>
        <Select
          variant="field"
          label="Channel"
          value={target}
          onValueChange={setTarget}
          disabled={pending}
          placeholder="Choose a channel"
          groups={[
            {
              label: "",
              options: channels.map((c) => ({
                value: c.id,
                label: `#${c.name}`,
              })),
            },
          ]}
        />
        {!channels.length && (
          <p className="text-body-sm text-subtle">
            Join a text channel before converting this DM.
          </p>
        )}
        <Field
          label="Messages"
          nativeLabel={false}
          description={
            fromId === "all"
              ? "To start later, open a message’s menu and choose Convert to thread from here."
              : undefined
          }
        >
          <p className="text-body text-primary">
            {fromId === "all"
              ? "Whole conversation"
              : "From this message onward"}
          </p>
        </Field>
        <Field
          label="Approval window (hours)"
          description="Only approvals expire. Once everyone approves, the move waits until everyone is online."
        >
          <Input
            type="number"
            min={1 / 60}
            max={720}
            step="any"
            value={hours}
            disabled={pending}
            onChange={(e) => setHours(e.target.value)}
          />
        </Field>
        <p className="text-body-sm text-subtle">
          Latest edits are included and deleted messages are left out. Hosted
          agents and patches aren’t supported yet.
        </p>
        {error && (
          <p role="alert" className="text-body-sm text-danger">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}

function Status({
  state,
  session,
}: {
  state: MoveState;
  session: RelaySession;
}) {
  const names = (keys: readonly string[]) =>
    keys
      .map((k) =>
        k === session.viewer
          ? "you"
          : (session.profiles.snapshot().get(k)?.name ?? k.slice(0, 8)),
      )
      .join(", ");
  switch (state.status) {
    case "pending":
      return (
        <>
          Approved: {names(state.approved) || "nobody yet"}. Waiting:{" "}
          {names(state.waiting)}.
        </>
      );
    case "approved": {
      const online = state.approvers.filter(
        (k) => session.presence.status(k) === "online" || k === session.viewer,
      ).length;
      return (
        <>
          Everyone approved · {online}/{state.approvers.length} online
        </>
      );
    }
    case "committing":
    case "posting":
      return <>Posting the thread…</>;
    case "complete":
      return <>Moved to the channel.</>;
    case "declined":
      return (
        <>
          Move cancelled: {names([state.actor ?? ""])} declined.
          {state.reason ? ` ${state.reason}` : ""}
        </>
      );
    case "cancelled":
      return <>Move cancelled by {names([state.actor ?? ""])}.</>;
    case "expired":
      return <>Move expired: waiting on {names(state.waiting)}.</>;
  }
}
export function DmMoveCard({
  session,
  message,
  navigation,
}: {
  session: RelaySession;
  message: ChannelMessage;
  navigation: Navigation;
}) {
  const { moves, snapshot } = useMoves(session);
  const state = snapshot.moves.find(
    (s) => s.request.event.id === message.dmMove,
  );
  const destination = useChannelReference(
    session.channels,
    state?.request.control.target,
  );
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const action = async (run: (moves: DmMoves) => Promise<void>) => {
    if (!moves || busy) return;
    setBusy(true);
    setError("");
    try {
      await run(moves);
      setDeclining(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  if (!state) return <p role="status">Loading conversion request…</p>;
  const req = state.request.control;
  const name =
    namedChannel(destination)?.name ?? session.channels.get?.(req.target)?.name;
  const waiting =
    state.status === "pending" && state.waiting.includes(session.viewer ?? "");
  return (
    <section
      className={styles.form}
      aria-label={name ? `Convert DM to #${name}` : "Convert DM to thread"}
    >
      <p className="text-body-sm">
        Convert{" "}
        {req.from
          ? "from the selected message onward"
          : "the whole conversation"}{" "}
        to a thread in{" "}
        <strong>{name ? `#${name}` : "the destination channel"}</strong>.
      </p>
      {req.from && (
        <div className={styles.form}>
          <p className="text-caption text-subtle">Starting message</p>
          {state.status === "pending" && (
            <BuzzLinkPreview
              session={session}
              channelId={state.request.dm}
              messageId={req.from.id}
            />
          )}
          <div>
            <Button
              size="inline"
              variant="link"
              onClick={() => {
                const target = conversationTarget(
                  session.scope,
                  state.request.dm,
                );
                if (target.kind === "conversation" && req.from)
                  void navigation.open({ ...target, messageId: req.from.id });
              }}
            >
              View message
            </Button>
          </div>
        </div>
      )}
      {!name && (
        <p role="status" className="text-body-sm text-subtle">
          {destination.state === "withheld"
            ? "The destination channel is unavailable."
            : "Loading destination…"}
        </p>
      )}
      {state.status === "pending" && (
        <p className="text-body-sm text-subtle">
          Approve by {new Date(req.expires * 1000).toLocaleString()}.
        </p>
      )}
      <p role="status" className="text-body-sm">
        <Status state={state} session={session} />
      </p>
      {waiting && (
        <div className={styles.actions}>
          <Button
            size="sm"
            variant="prominent"
            disabled={busy || !name}
            onClick={() =>
              void action((m) => m.respond(state.request.event.id, true))
            }
          >
            Approve
          </Button>
          <Button
            size="sm"
            disabled={busy}
            onClick={() => setDeclining((v) => !v)}
          >
            Decline
          </Button>
        </div>
      )}
      {waiting && declining && (
        <>
          <Field label="Reason" optional>
            <Textarea
              maxLength={240}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              disabled={busy}
            />
          </Field>
          <div>
            <Button
              size="sm"
              disabled={busy}
              onClick={() =>
                void action((m) =>
                  m.respond(state.request.event.id, false, reason),
                )
              }
            >
              Decline move
            </Button>
          </div>
        </>
      )}
      {state.request.event.pubkey === session.viewer &&
        ["pending", "approved"].includes(state.status) && (
          <div>
            <Button
              size="sm"
              disabled={busy}
              onClick={() =>
                void action((m) => m.cancel(state.request.event.id))
              }
            >
              Cancel move
            </Button>
          </div>
        )}
      {state.root && (
        <div>
          <Button
            size="sm"
            onClick={() => {
              const target = conversationTarget(session.scope, req.target);
              if (target.kind === "conversation" && state.root)
                void navigation.open({
                  ...target,
                  messageId: state.root,
                  threadRootId: state.root,
                });
            }}
          >
            Open thread
          </Button>
        </div>
      )}
      {(error || snapshot.error) && (
        <p role="alert" className="text-body-sm text-danger">
          {error || snapshot.error}
        </p>
      )}
      {snapshot.error && (
        <div>
          <Button size="sm" onClick={() => moves?.retry()}>
            Retry conversion
          </Button>
        </div>
      )}
    </section>
  );
}
/** Plugin renderer follows the current session; it never keeps a retired session's authority. */
export function DmMoveMessage({
  relay,
  navigation,
  message,
}: {
  relay: RelayData;
  navigation: Navigation;
  message: ChannelMessage;
}) {
  const { session } = useSyncExternalStore(relay.subscribe, relay.snapshot);
  return (
    <DmMoveCard
      key={session.scope}
      session={session}
      navigation={navigation}
      message={message}
    />
  );
}
