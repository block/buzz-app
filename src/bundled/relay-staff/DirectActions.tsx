import {
  createContext,
  useContext,
  useDeferredValue,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Button } from "../../shared/design-system/ui/Button";
import { Input } from "../../shared/design-system/ui/Input";
import { useToastNotification } from "../../shared/design-system/ui/Toast";
import {
  unresolved,
  unsupported,
  type EventPreviewDto,
  type MemberDetailDto,
  type MemberSearchDto,
  type StaffFailure,
  type StaffRequest,
} from "../../features/relay-staff/contract";
import { reasonAudience, SECRET_REASON } from "./Reports";
import { describe, useRead, useSession, type Read } from "./session";
import {
  absoluteTime,
  CommunityBadge,
  containsSecretKey,
  eventIdInput,
  NotConnected,
  publicKeyInput,
  shortKey,
  time,
  UNSUPPORTED_BROWSING,
  type CommunityRef,
} from "./ui";

type Action = "ban" | "timeout" | "delete";
type Intent = Extract<StaffRequest, { route: "directAction" }>;

const LABELS: Record<Action, string> = {
  ban: "Ban member",
  timeout: "Time out member",
  delete: "Delete message",
};

export const STAFF_COPY =
  "Relay staff can't be banned or timed out. Remove their staff role first.";
export const UNSUPPORTED_ACTIONS =
  "This relay doesn't support direct actions yet.";
const SECRET_SEARCH = "That's a secret key. Never paste it here.";

export function directFailure(failure: StaffFailure) {
  if (failure.code === "target_is_staff") return STAFF_COPY;
  if (failure.code === "request_id_conflict")
    return "This request id was already used for a different action. Review again to send it with a new id.";
  if (unsupported(failure)) return UNSUPPORTED_ACTIONS;
  return describe(failure);
}

/** Why a lookup failed; "not found" only when the relay said so. */
function lookupFailure(failure: StaffFailure) {
  if (unsupported(failure)) return UNSUPPORTED_BROWSING;
  if (failure.code === "event_not_found" || failure.code === "not_found")
    return "Not found in this community.";
  return describe(failure);
}

type Member = { pubkey: string; name: string | null };
type Draft = {
  host: string;
  action: Action;
  target: string;
  member: Member | null;
  secs: string;
  reason: string;
};
const emptyDraft = (host: string): Draft => ({
  host,
  action: "ban",
  target: "",
  member: null,
  secs: "",
  reason: "",
});

/** A reviewed action. Its intent, including `requestId`, never changes. */
type Frozen = {
  intent: Intent;
  community: CommunityRef;
  name: string | null;
  member: MemberDetailDto | null;
  preview: EventPreviewDto | null;
};

type Held = { frozen: Frozen | null; pending: boolean; error: string | null };
const IDLE: Held = { frozen: null, pending: false, error: null };
const DIRECT = "direct action";

type Controller = {
  draftFor(host: string): Draft;
  setDraft(draft: Draft): void;
  frozen: Frozen | null;
  pending: boolean;
  error: string | null;
  submitting: boolean;
  review(
    frozen: Omit<Frozen, "intent">,
    intent: Omit<Intent, "route" | "requestId">,
  ): void;
  confirm(): Promise<void>;
  discard(): void;
  /** Host whose Actions section is on screen, for the off-screen failure toast. */
  shownHost: { current: string | null };
};
const ControllerContext = createContext<Controller | null>(null);

function useController() {
  const controller = useContext(ControllerContext);
  if (!controller) throw new Error("Direct actions controller is missing");
  return controller;
}

/**
 * Owns the draft and the reviewed action for every community page. Mounted
 * above the tabs, so leaving a page mid-action keeps the same request. The
 * reviewed action is held per identity, admin host and relay (`Staff.held`),
 * so it also survives closing the card and losing then regaining access.
 */
export function DirectActionsProvider({ children }: { children: ReactNode }) {
  const { request, frozen: store } = useSession();
  const notify = useToastNotification();
  const [draft, setDraft] = useState<Draft | null>(null);
  // The reviewed action lives in the session's held writes, so closing the
  // card or losing and regaining access brings back the same request.
  const [held, setHeld] = useState(
    () => (store.get(DIRECT) as Held | undefined) ?? IDLE,
  );
  const hold = (next: Held) => {
    if (next.frozen) store.set(DIRECT, next);
    else store.delete(DIRECT);
    setHeld(next);
  };
  const { frozen, pending, error } = held;
  const [submitting, setSubmitting] = useState(false);
  const inFlight = useRef(false);
  const shownHost = useRef<string | null>(null);

  const confirm = async () => {
    if (!frozen || inFlight.current) return;
    inFlight.current = true;
    setSubmitting(true);
    hold({ ...held, error: null });
    const { intent } = frozen;
    const outcome = await request(intent);
    inFlight.current = false;
    setSubmitting(false);
    if (outcome.ok && outcome.value.state === "succeeded") {
      notify(`${LABELS[intent.action]}: done`, "success");
      hold(IDLE);
      setDraft(emptyDraft(intent.communityHost));
      return;
    }
    // Unresolved (pending, or the write may have landed): keep the same
    // request for a retry. Anything else is final for this request id.
    const message = outcome.ok ? null : directFailure(outcome.failure);
    hold({
      frozen: unresolved(outcome) ? frozen : null,
      pending: outcome.ok,
      error: message,
    });
    if (message && shownHost.current !== intent.communityHost)
      notify(
        `${LABELS[intent.action]} in ${intent.communityHost} failed: ${message}`,
        "error",
      );
  };

  const value: Controller = {
    draftFor: (host) => (draft?.host === host ? draft : emptyDraft(host)),
    setDraft,
    frozen,
    pending,
    error,
    submitting,
    review(lookup, intent) {
      if (frozen) return;
      hold({
        frozen: {
          ...lookup,
          intent: {
            route: "directAction",
            ...intent,
            requestId: crypto.randomUUID(),
          },
        },
        pending: false,
        error: null,
      });
    },
    confirm,
    discard: () => hold(IDLE),
    shownHost,
  };
  return (
    <ControllerContext.Provider value={value}>
      {children}
    </ControllerContext.Provider>
  );
}

function validate(draft: Draft, eventId: string | null) {
  if (draft.action === "delete" && !eventId)
    return "Enter a 64-hex event id, or a note1… or nevent1… link.";
  if (draft.action !== "delete" && !draft.member)
    return "Choose a member: search by name, or paste an npub or hex key.";
  const secs = Number(draft.secs);
  if (draft.action === "timeout" && !(Number.isInteger(secs) && secs > 0))
    return "Duration must be a whole number of seconds above zero.";
  if (containsSecretKey(draft.reason)) return SECRET_REASON;
  return null;
}

function MemberState({ member }: { member: MemberDetailDto }) {
  const facts = [
    member.role === null
      ? "Not on the community roster"
      : `Role: ${member.role}`,
    member.banned ? "Currently banned" : null,
    member.mutedUntil
      ? `Timed out until ${absoluteTime(member.mutedUntil)}`
      : null,
    member.isStaff ? "Relay staff" : null,
  ].filter(Boolean);
  return <p className="text-caption text-secondary">{facts.join(" · ")}</p>;
}

function EventPreview({ event }: { event: EventPreviewDto }) {
  return (
    <div className="flex flex-col gap-1 rounded-md border px-3 py-2 text-caption">
      <span className="break-all font-mono text-secondary">
        {event.authorPubkey}
      </span>
      <p className="whitespace-pre-wrap break-words">{event.content}</p>
      {event.deletedAt && (
        <p className="text-secondary">
          Already deleted {time(event.deletedAt)}.
        </p>
      )}
    </div>
  );
}

/** A lookup that only runs for `key`; null when there is nothing to look up. */
function useLookup<R extends StaffRequest>(
  request: R | null,
  key: string | null,
) {
  const [read] = useRead(request, [key]);
  return request ? read : null;
}

export function ActionsSection({ community }: { community: CommunityRef }) {
  const { context, canMutate } = useSession();
  const c = useController();
  const host = community.host;
  const draft = c.draftFor(host);
  const set = (patch: Partial<Draft>) => c.setDraft({ ...draft, ...patch });
  const [invalid, setInvalid] = useState<string | null>(null);

  useEffect(() => {
    c.shownHost.current = host;
    return () => {
      c.shownHost.current = null;
    };
  }, [c.shownHost, host]);

  const eventId = draft.action === "delete" ? eventIdInput(draft.target) : null;
  const memberKey =
    draft.action !== "delete" ? (draft.member?.pubkey ?? null) : null;
  const fence = `${context.signer} ${context.origin} ${host}`;
  const member = useLookup(
    memberKey
      ? { route: "getMember", communityHost: host, pubkey: memberKey }
      : null,
    memberKey && `${fence} member ${memberKey}`,
  );
  const preview = useLookup(
    eventId ? { route: "getEvent", communityHost: host, id: eventId } : null,
    eventId && `${fence} event ${eventId}`,
  );
  const lookup: Read<unknown> | null =
    draft.action === "delete" ? preview : member;
  const blocked =
    lookup?.state === "failed"
      ? lookupFailure(lookup.failure)
      : draft.action !== "delete" &&
          member?.state === "ok" &&
          member.value.isStaff
        ? STAFF_COPY
        : null;

  if (c.frozen && c.frozen.intent.communityHost !== host)
    return (
      <div className="flex flex-col gap-2 text-body-sm">
        <p>
          Finish or discard the pending action in{" "}
          <code>{c.frozen.intent.communityHost}</code>.
        </p>
        <ConfirmStep readOnly />
      </div>
    );

  const locked = !!c.frozen || c.submitting || !canMutate;
  const review = () => {
    const problem = validate(draft, eventId);
    setInvalid(problem);
    if (problem || lookup?.state !== "ok" || blocked) return;
    const target = eventId ?? memberKey ?? "";
    const reason = draft.reason.trim();
    c.review(
      {
        community,
        name: draft.member?.name ?? null,
        member: member?.state === "ok" ? member.value : null,
        preview: preview?.state === "ok" ? preview.value : null,
      },
      {
        communityHost: host,
        action: draft.action,
        target,
        ...(reason ? { reason } : {}),
        ...(draft.action === "timeout"
          ? { expirationSecs: Number(draft.secs) }
          : {}),
      },
    );
  };
  const error = invalid ?? c.error;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-1.5">
        {(Object.keys(LABELS) as Action[]).map((action) => (
          <Button
            key={action}
            size="sm"
            variant={action === draft.action ? "prominent" : "outline"}
            disabled={locked}
            onClick={() => set({ action })}
          >
            {LABELS[action]}
          </Button>
        ))}
      </div>
      {draft.action === "delete" ? (
        <Input
          aria-label="Event id"
          placeholder="Event id (hex), note1… or nevent1…"
          disabled={locked}
          value={draft.target}
          onChange={(event) => set({ target: event.target.value })}
        />
      ) : (
        <MemberPicker
          communityHost={host}
          disabled={locked}
          member={draft.member}
          onChange={(picked) => set({ member: picked })}
        />
      )}
      {!c.frozen && member?.state === "ok" && draft.action !== "delete" && (
        <MemberState member={member.value} />
      )}
      {!c.frozen && preview?.state === "ok" && draft.action === "delete" && (
        <EventPreview event={preview.value} />
      )}
      {!c.frozen && blocked && (
        <p className="text-body-sm text-danger" role="alert">
          {blocked}
        </p>
      )}
      {draft.action === "timeout" && (
        <Input
          aria-label="Duration (seconds)"
          placeholder="Duration (seconds)"
          type="number"
          disabled={locked}
          value={draft.secs}
          onChange={(event) => set({ secs: event.target.value })}
        />
      )}
      <Input
        aria-label="Reason"
        placeholder="Reason (optional)"
        disabled={locked}
        value={draft.reason}
        onChange={(event) => set({ reason: event.target.value })}
      />
      <p className="text-caption text-secondary">
        {reasonAudience(c.frozen?.intent.action ?? draft.action)}
      </p>
      {error && (
        <p className="text-body-sm text-danger" role="alert">
          {error}
        </p>
      )}
      {c.frozen ? (
        <ConfirmStep />
      ) : (
        <div>
          <Button
            size="sm"
            disabled={
              !canMutate ||
              c.submitting ||
              lookup?.state === "loading" ||
              blocked !== null
            }
            onClick={review}
          >
            Review
          </Button>
        </div>
      )}
    </div>
  );
}

/** The reviewed intent, leading with its community. */
function ConfirmStep({ readOnly = false }: { readOnly?: boolean }) {
  const { canMutate } = useSession();
  const c = useController();
  if (!c.frozen) return null;
  const { intent, community, name, member, preview } = c.frozen;
  return (
    <div className="flex flex-col gap-2 rounded-md border px-3 py-2 text-body-sm">
      <p className="flex flex-wrap items-center gap-1.5">
        In <CommunityBadge id={community.id} host={community.host} />
        <NotConnected host={intent.communityHost} />
      </p>
      <p>
        {LABELS[intent.action]}{" "}
        {intent.action === "delete" ? (
          <code className="break-all">{intent.target}</code>
        ) : (
          <span>
            {name
              ? `${name} (${shortKey(intent.target)})`
              : shortKey(intent.target)}
          </span>
        )}
        {intent.expirationSecs ? ` for ${intent.expirationSecs}s` : ""}?
      </p>
      {intent.action !== "delete" && (
        <code className="break-all font-mono text-caption text-secondary">
          {intent.target}
        </code>
      )}
      {member && <MemberState member={member} />}
      {preview && <EventPreview event={preview} />}
      <p>Reason: {intent.reason ?? "(none)"}</p>
      {c.pending && (
        <p className="text-secondary" role="status">
          Accepted; the relay is still applying it. Retry to check.
        </p>
      )}
      <div className="flex gap-1.5">
        {!readOnly && (
          <Button
            size="sm"
            variant="destructive"
            loading={c.submitting}
            disabled={!canMutate}
            onClick={() => void c.confirm()}
          >
            {c.error || c.pending ? "Retry" : "Confirm"}
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          disabled={c.submitting}
          onClick={c.discard}
        >
          Discard
        </Button>
      </div>
    </div>
  );
}

const label = (m: MemberSearchDto) => m.displayName || m.nip05 || null;

/**
 * Search the community's profiles (including former members), or paste an
 * npub or hex key. A pasted secret key never leaves the device.
 */
export function MemberPicker({
  communityHost,
  disabled,
  member,
  onChange,
}: {
  communityHost: string;
  disabled: boolean;
  member: Member | null;
  onChange(member: Member | null): void;
}) {
  const { context } = useSession();
  const [query, setQuery] = useState("");
  const q = useDeferredValue(query.trim());
  const secret = containsSecretKey(query) || containsSecretKey(q);
  const pasted = publicKeyInput(q);
  const searching = !!q && !secret && !pasted;
  const [results] = useRead(
    searching ? { route: "searchMembers", communityHost, q } : null,
    [context, communityHost, searching ? q : null],
  );

  if (member)
    return (
      <div className="flex items-center gap-2 text-body-sm">
        {member.name && <span>{member.name}</span>}
        <span
          className="font-mono text-caption text-secondary"
          title={member.pubkey}
        >
          {shortKey(member.pubkey)}
        </span>
        <Button
          size="sm"
          variant="link"
          disabled={disabled}
          onClick={() => onChange(null)}
        >
          Change
        </Button>
      </div>
    );

  const candidates: Member[] = pasted
    ? [{ pubkey: pasted, name: null }]
    : searching && results.state === "ok"
      ? results.value.items.map((m) => ({ pubkey: m.pubkey, name: label(m) }))
      : [];
  return (
    <div className="flex flex-col gap-1">
      <Input
        aria-label="Member"
        placeholder="Search by name, or paste an npub or hex key"
        disabled={disabled}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      {secret && (
        <p className="text-body-sm text-danger" role="alert">
          {SECRET_SEARCH}
        </p>
      )}
      {searching && results.state === "failed" && (
        <p className="text-body-sm text-danger" role="alert">
          {lookupFailure(results.failure)}
        </p>
      )}
      {candidates.length > 0 && (
        <ul className="flex flex-col rounded-md border" aria-label="Members">
          {candidates.map((candidate) => (
            <li key={candidate.pubkey}>
              <button
                type="button"
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-body-sm hover:bg-secondary"
                onClick={() => {
                  onChange(candidate);
                  setQuery("");
                }}
              >
                <span className="flex-1 truncate">
                  {candidate.name ?? "Unnamed"}
                </span>
                <span className="font-mono text-caption text-secondary">
                  {shortKey(candidate.pubkey)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Members section: pick someone, then ban or time them out from Actions. */
export function MembersSection({
  communityHost,
  onAct,
}: {
  communityHost: string;
  onAct(): void;
}) {
  const { canMutate } = useSession();
  const c = useController();
  const [member, setMember] = useState<Member | null>(null);
  return (
    <div className="flex flex-col gap-2">
      <MemberPicker
        communityHost={communityHost}
        disabled={false}
        member={member}
        onChange={setMember}
      />
      {member && (
        <div className="flex gap-1.5">
          {(["ban", "timeout"] as const).map((action) => (
            <Button
              key={action}
              size="sm"
              variant="outline"
              disabled={!canMutate || !!c.frozen}
              onClick={() => {
                c.setDraft({ ...emptyDraft(communityHost), action, member });
                onAct();
              }}
            >
              {action === "ban" ? "Ban" : "Time out"}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}
