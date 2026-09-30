import {
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { npubEncode } from "nostr-tools/nip19";
import { AlertDialog } from "../../shared/design-system/ui/AlertDialog";
import { Button } from "../../shared/design-system/ui/Button";
import { Checkbox } from "../../shared/design-system/ui/Checkbox";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import {
  ArchiveIcon,
  ArrowSquareOutIcon,
  ArrowsClockwiseIcon,
  ArrowsLeftRightIcon,
  BoxArrowUpIcon,
  CheckCircleIcon,
  CircleNotchIcon,
  LinkBreakIcon,
  SignOutIcon,
  TrashIcon,
  WarningCircleIcon,
} from "../../shared/design-system/icons";
import {
  admitDeletion,
  ApiFailure,
  boundKey,
  call,
  check,
  clearPendingDeletion,
  getAuth,
  HOST_SUFFIX,
  isDefinitiveDeletionRejection,
  login,
  makePendingDeletion,
  persistPendingDeletion,
  quota,
  quotaLimitMessage,
  readPendingDeletion,
  relayUrl,
  signOut,
  Unsupported,
  VALID_NAME,
  type Account,
  type Community,
  type Identity,
  type PendingDeletion,
  type Quota,
} from "./api";

const card = "mt-6 rounded-xl border border-default p-5";
const npub = (hex?: string | null) => (hex ? npubEncode(hex) : "Unavailable");
const message = (reason: unknown) =>
  reason instanceof Error ? reason.message : String(reason);
type Confirm = {
  title: string;
  description: string;
  action: string;
  run(): Promise<void>;
};

export function HostedCommunities({ active }: { active(): boolean }) {
  const [auth, setAuth] = useState<Account | null>();
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [identityLoadFailed, setIdentityLoadFailed] = useState(false);
  const [communities, setCommunities] = useState<Community[]>([]);
  const [quotaState, setQuotaState] = useState<Quota | null>(null);
  // This device's key: undefined while loading, null when it could not be read.
  const [local, setLocal] = useState<string | null>();
  const [unsupported, setUnsupported] = useState("");
  const [action, setAction] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [transfer, setTransfer] = useState<Community | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Community | null>(null);
  const [pendingDeletion, setPendingDeletion] =
    useState<PendingDeletion | null>(null);
  const [blockedOwner, setBlockedOwner] = useState<string | null>(null);
  const [deletionNotice, setDeletionNotice] = useState("");
  // The last address handed off for joining, and whether the clipboard took it.
  const [handoff, setHandoff] = useState<{
    url: string;
    copied: boolean;
  } | null>(null);
  const handoffOwner = useRef(0);
  const loginAbort = useRef<AbortController | null>(null);
  // Bumped by every operation and unmount; a read applies only if none happened since it began.
  const generation = useRef(0);
  const acceptedDeletions = useRef(new Map<string, PendingDeletion>());
  const loadedOwner = useRef<string | null | undefined>(undefined);

  const load = useCallback(
    async (reconcileAccepted = false) => {
      const at = generation.current;
      const [current, list] = await Promise.all([
        call("identity"),
        call("list"),
      ]);
      if (at !== generation.current) return null;
      // A setup-needed mapping is the connect state. An upstream unauthorized
      // response may also be an expired session (dev/builderlab.mjs forwards it).
      if (
        current.error?.code === "unauthorized" ||
        list.error?.code === "unauthorized"
      ) {
        setIdentityLoadFailed(true);
        setIdentity(null);
        setCommunities([]);
        setQuotaState(null);
        setPendingDeletion(null);
      }
      if (!current.error?.setup_needed)
        check(current, "Could not load the connected Buzz identity.");
      if (!list.error?.setup_needed) check(list, "Could not load communities.");
      setIdentityLoadFailed(false);
      const nextIdentity = current.identity ?? null;
      const nextOwner = boundKey(nextIdentity);
      if (
        loadedOwner.current !== undefined &&
        loadedOwner.current !== nextOwner
      ) {
        acceptedDeletions.current.clear();
        setDeletionNotice("");
      }
      loadedOwner.current = nextOwner;
      const stored = readPendingDeletion();
      setBlockedOwner(
        stored &&
          (stored.owner_pubkey !== nextOwner ||
            stored.backend_origin !== window.location.origin)
          ? stored.owner_pubkey
          : null,
      );
      setPendingDeletion(
        stored?.owner_pubkey === nextOwner &&
          stored.backend_origin === window.location.origin
          ? stored
          : null,
      );
      const listed = list.communities ?? [];
      if (
        reconcileAccepted &&
        nextOwner &&
        listed.some((community) =>
          acceptedDeletions.current.has(community.id ?? ""),
        )
      ) {
        const currentAuth = await getAuth().catch(() => null);
        if (at !== generation.current || !active()) return null;
        if (currentAuth?.capabilities?.can_delete_buzz_communities === true)
          for (const community of listed) {
            if (at !== generation.current || !active()) return null;
            const accepted = acceptedDeletions.current.get(community.id ?? "");
            if (!accepted || accepted.owner_pubkey !== nextOwner) continue;
            try {
              await admitDeletion(accepted.request, "recovery");
            } catch (reason) {
              if (
                at === generation.current &&
                active() &&
                acceptedDeletions.current.get(accepted.request.community_id) ===
                  accepted &&
                reason instanceof ApiFailure &&
                reason.code === "deletion_aborted"
              ) {
                acceptedDeletions.current.delete(accepted.request.community_id);
                if (acceptedDeletions.current.size === 0) setDeletionNotice("");
                setError(
                  "Deletion stopped. This community is not being deleted.",
                );
              }
            }
            if (at !== generation.current || !active()) return null;
          }
      }
      const nextCommunities = listed.filter(
        (community) =>
          !community.id || !acceptedDeletions.current.has(community.id),
      );
      const nextQuota = quota(list);
      setIdentity(nextIdentity);
      setCommunities(nextCommunities);
      setQuotaState(nextQuota);
      return { identity: nextIdentity, communities: nextCommunities };
    },
    [active],
  );

  const markDeletionAccepted = useCallback(
    (pending: PendingDeletion, at: number) => {
      if (at !== generation.current || !active()) return false;
      clearPendingDeletion(pending);
      acceptedDeletions.current.set(pending.request.community_id, pending);
      setPendingDeletion(null);
      setCommunities((list) =>
        list.filter((item) => item.id !== pending.request.community_id),
      );
      setDeletionNotice("Deletion started");
      setError("");
      return true;
    },
    [active],
  );

  const localRead = useRef(0);
  const loadLocal = useCallback(() => {
    const at = ++localRead.current;
    setLocal(undefined);
    void fetch("/api/relay/identity")
      .then((response): Promise<{ viewer?: string }> => {
        if (!response.ok) throw new Error(String(response.status));
        return response.json();
      })
      .then(({ viewer }) => boundKey(viewer ? { pubkey_hex: viewer } : null))
      .catch(() => null)
      .then((key) => at === localRead.current && setLocal(key));
  }, []);

  useEffect(() => {
    const at = ++generation.current;
    loadLocal();
    void getAuth()
      .then((next) => {
        if (at !== generation.current) return;
        setAuth(next);
        if (next)
          return load().catch(
            (reason) => at === generation.current && setError(message(reason)),
          );
      })
      .catch((reason) => {
        if (at !== generation.current) return;
        setAuth(null);
        if (reason instanceof Unsupported) setUnsupported(reason.message);
        else setError(message(reason));
      });
    return () => {
      generation.current++;
      loginAbort.current?.abort();
    };
  }, [load, loadLocal]);

  /** Runs one account operation at a time; resolves whether it succeeded. */
  async function run(label: string, operation: () => Promise<unknown>) {
    if (!active()) return false;
    const at = ++generation.current;
    setAction(label);
    setError("");
    try {
      await operation();
      return true;
    } catch (reason) {
      if (at === generation.current) setError(message(reason));
      return false;
    } finally {
      if (at === generation.current) setAction(null);
    }
  }
  const copy = async (url: string) => {
    // A retired card must not start a clipboard write.
    if (!active()) return;
    const at = handoffOwner.current;
    const copied = await Promise.resolve()
      .then(() => navigator.clipboard.writeText(url))
      .then(
        () => true,
        () => false,
      );
    if (at === handoffOwner.current) setHandoff({ url, copied });
  };
  /** Refreshes after a confirmed write; a failed read must not present the write as failed. */
  const settle = () => {
    const at = generation.current;
    return load().catch(
      (reason) =>
        at === generation.current &&
        setError(
          `The change was saved, but the list could not be refreshed. ${message(reason)} Use Refresh to try again.`,
        ),
    );
  };
  const settleDeletion = async (
    pending: PendingDeletion,
    at: number,
    operation: () => Promise<unknown>,
  ) => {
    try {
      await operation();
      if (!markDeletionAccepted(pending, at)) return false;
      await settle();
      return true;
    } catch (reason) {
      if (at !== generation.current || !active()) return false;
      if (
        (reason instanceof ApiFailure && reason.code === "deletion_aborted") ||
        isDefinitiveDeletionRejection(reason)
      ) {
        clearPendingDeletion(pending);
        setPendingDeletion(null);
        if (reason instanceof ApiFailure && reason.code === "deletion_aborted")
          await load().catch(() => undefined);
      } else setPendingDeletion(pending);
      throw reason;
    }
  };
  const checkPendingDeletion = (pending: PendingDeletion) =>
    run("delete", async () => {
      const at = generation.current;
      const snapshot = await load();
      if (at !== generation.current || !active()) return;
      const currentAuth = await getAuth();
      if (at !== generation.current || !active()) return;
      const stored = readPendingDeletion();
      if (
        !snapshot ||
        !stored ||
        JSON.stringify(stored) !== JSON.stringify(pending) ||
        stored.backend_origin !== window.location.origin ||
        boundKey(snapshot.identity) !== pending.owner_pubkey
      )
        throw new Error(
          "This deletion request no longer matches the current account. Sign in with the original account to check its status.",
        );
      setAuth(currentAuth);
      if (currentAuth?.capabilities?.can_delete_buzz_communities !== true)
        throw new Error("Community deletion is no longer available.");
      await settleDeletion(pending, at, () =>
        admitDeletion(pending.request, "recovery"),
      );
    });
  const busy = action !== null;
  // Repeated inside open dialogs, whose modal backdrop hides the page copy.
  const failure = error && (
    <p role="alert" className="error flex items-start gap-2 break-words">
      <WarningCircleIcon
        size={16}
        aria-hidden="true"
        className="mt-0.5 shrink-0"
      />
      <span>{error}</span>
    </p>
  );
  const bound = boundKey(identity);
  // Without a usable bound key, the account cannot prove which identity it acts for.
  const mismatch =
    Boolean(identity) && (!bound || (Boolean(local) && bound !== local));
  // Acting requires this device's key to be known and to match the account's.
  const ready = bound !== null && bound === local;
  const deletionEnabled =
    auth?.capabilities?.can_delete_buzz_communities === true;
  // A handoff belongs to the bound identity: whenever it changes, by a local
  // action or a refresh, drop the handoff and any clipboard result in flight.
  // Layout effect, so a stale handoff is never painted beside the new identity.
  // biome-ignore lint/correctness/useExhaustiveDependencies: bound is the trigger.
  useLayoutEffect(() => {
    handoffOwner.current++;
    setHandoff(null);
  }, [bound]);
  // Joining guidance is never offered for an address the card knows is archived,
  // including a clipboard result that lands after the archive.
  const shown =
    handoff &&
    !communities.some(
      (item) => item.archived_at && relayUrl(item) === handoff.url,
    )
      ? handoff
      : null;

  const bind = async () => {
    const reply = check(
      await call("bind"),
      "Could not connect the Buzz identity.",
    );
    setIdentity(reply.identity ?? null);
    await settle();
  };
  const mutate = async (
    kind: "archive" | "unarchive",
    community: Community,
    fallback: string,
  ) => {
    const reply = await call(kind, { community_id: community.id ?? "" });
    const archivedAt = reply.community?.archived_at;
    const done = kind === "archive" ? Boolean(archivedAt) : archivedAt === null;
    if (!done) check(reply, fallback);
    // Apply the confirmed state now, so a failed refresh cannot leave the row's old actions.
    if (done)
      setCommunities((list) =>
        list.map((item) =>
          item.id === community.id
            ? { ...item, archived_at: archivedAt ?? null }
            : item,
        ),
      );
    await settle();
  };

  return (
    <section aria-labelledby="hosted-communities-title">
      <h2 id="hosted-communities-title" className="mt-0 mb-2 text-label">
        Hosted communities
      </h2>
      <p className="text-body-sm text-muted">
        Buzz works with any relay. This page is only for relay hosting provided
        by Block — sign in with a Builderlab account to create and manage
        Block-hosted communities. Builderlab sign-in is used on this page alone.
      </p>
      {failure}
      {unsupported ? (
        <p className={`${card} text-body-sm text-muted`}>{unsupported}</p>
      ) : auth === undefined ? (
        <p
          role="status"
          className="flex items-center gap-2 text-body-sm text-muted"
        >
          <CircleNotchIcon
            size={16}
            aria-hidden="true"
            className="motion-safe:animate-spin"
          />
          Checking sign-in…
        </p>
      ) : !auth ? (
        <div className={card}>
          <h3 className="m-0 text-label">
            Sign in to manage hosted communities
          </h3>
          <p className="text-body-sm text-muted">
            Authentication opens in your browser and returns securely to Buzz.
            You can use every other part of the app without signing in.
          </p>
          <div className="flex flex-wrap gap-3">
            <Button
              variant="primary"
              loading={action === "login"}
              disabled={busy}
              onClick={() =>
                void run("login", async () => {
                  loginAbort.current = new AbortController();
                  const next = await login(loginAbort.current.signal);
                  setAuth(next);
                  await settle();
                })
              }
            >
              <ArrowSquareOutIcon size={18} aria-hidden="true" /> Sign in with
              Builderlab
            </Button>
            {action === "login" && (
              <Button onClick={() => loginAbort.current?.abort()}>
                Cancel
              </Button>
            )}
          </div>
        </div>
      ) : (
        <>
          <div
            className={`${card} flex flex-wrap items-center justify-between gap-3`}
          >
            <div>
              <p className="m-0 text-label">
                {auth.name || auth.email || "Builderlab account"}
              </p>
              {auth.name && auth.email && (
                <p className="m-0 text-body-sm text-muted">{auth.email}</p>
              )}
            </div>
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() =>
                void run("sign-out", async () => {
                  await signOut();
                  setPendingDeletion(null);
                  setAuth(null);
                  setIdentity(null);
                  setCommunities([]);
                  setQuotaState(null);
                })
              }
            >
              <SignOutIcon aria-hidden="true" /> Sign out
            </Button>
          </div>
          {!identity ? (
            identityLoadFailed ? null : (
              <div className={card}>
                <h3 className="m-0 text-label">
                  Link this account to your Buzz identity
                </h3>
                <p className="text-body-sm text-muted">
                  This Builderlab account isn’t linked to a Buzz identity yet.
                  Connect this device’s key to create and own communities under
                  it — Buzz signs a one-time challenge locally, so your private
                  key never leaves this computer.
                </p>
                <Button
                  variant="primary"
                  loading={action === "bind"}
                  disabled={busy}
                  onClick={() => void run("bind", bind)}
                >
                  Connect Buzz identity
                </Button>
              </div>
            )
          ) : local === undefined && bound ? (
            <p role="status" className={card}>
              Checking this device’s Buzz identity…
            </p>
          ) : local === null && bound ? (
            <div className={card}>
              <p role="alert" className="error m-0">
                Could not read this device’s Buzz identity, so community actions
                are paused.
              </p>
              <div className="mt-3">
                <Button onClick={loadLocal}>Try again</Button>
              </div>
            </div>
          ) : mismatch ? (
            <section className={card} aria-label="Identity mismatch">
              <h3 className="m-0 flex items-center gap-2 text-label">
                <WarningCircleIcon size={16} aria-hidden="true" />
                This account is connected to a different Buzz identity
              </h3>
              <p className="text-body-sm text-muted">
                Your Builderlab account is linked to another Buzz key. Creating
                communities and copying addresses are paused until the
                identities match.
              </p>
              <dl className="text-body-sm">
                <dt className="text-muted">Account uses</dt>
                <dd className="m-0 break-all font-mono">{npub(bound)}</dd>
                <dt className="mt-2 text-muted">This device</dt>
                <dd className="m-0 break-all font-mono">{npub(local)}</dd>
              </dl>
              <Button
                variant="primary"
                loading={action === "switch"}
                disabled={busy || !local}
                onClick={() =>
                  void run("switch", async () => {
                    check(
                      await call("unbind"),
                      "Could not release the previously connected Buzz identity.",
                    );
                    setPendingDeletion(null);
                    // Unbound is a valid resting state; Connect recovers it.
                    setIdentity(null);
                    if (active()) await bind();
                  })
                }
              >
                Switch to this device’s identity
              </Button>
            </section>
          ) : (
            <div
              className={`${card} flex flex-wrap items-center justify-between gap-3`}
            >
              <p className="m-0 flex min-w-0 flex-wrap items-center gap-2 text-body-sm">
                <CheckCircleIcon size={16} aria-hidden="true" />
                Buzz identity connected{" "}
                <span className="break-all font-mono text-muted">
                  {npub(bound)}
                </span>
              </p>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() =>
                  setConfirm({
                    title: "Unpair this Buzz identity?",
                    description:
                      "Your Builderlab account will no longer be connected to this Buzz key. You can reconnect any key later, but community actions stay unavailable until you do.",
                    action: "Unpair identity",
                    run: async () => {
                      check(
                        await call("unbind"),
                        "Could not unpair the Buzz identity.",
                      );
                      setPendingDeletion(null);
                      setIdentity(null);
                      await settle();
                    },
                  })
                }
              >
                <LinkBreakIcon aria-hidden="true" /> Unpair identity
              </Button>
            </div>
          )}
          <div className="mt-8 flex items-center justify-between gap-3">
            <h3 className="m-0 text-label">
              Your communities{" "}
              {quotaState && (
                <span className="text-body-sm text-muted">
                  {quotaState.used} of {quotaState.limit} used
                </span>
              )}
            </h3>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => void run("refresh", () => load(true))}
            >
              <ArrowsClockwiseIcon aria-hidden="true" /> Refresh
            </Button>
          </div>
          {deletionNotice && (
            <p role="status" className={`${card} text-body-sm`}>
              {deletionNotice}
            </p>
          )}
          {pendingDeletion && (
            <div className={card}>
              <p className="m-0 text-label">Deletion status is unknown</p>
              <p className="text-body-sm text-muted">
                Buzz will not check automatically. Use Check deletion status
                when deletion is available. This resends the same request UUID,
                which may admit the original intent; a failed check does not
                prove the earlier request was never accepted.
              </p>
              <p className="break-all font-mono text-body-sm">
                {pendingDeletion.request.host}
              </p>
              <p className="text-body-sm text-muted">
                If this remains uncertain, contact support and include this
                Request UUID:
              </p>
              <p className="select-all break-all font-mono text-body-sm">
                {pendingDeletion.request.request_id}
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="primary"
                  loading={action === "delete"}
                  disabled={busy || !deletionEnabled || !ready}
                  onClick={() => void checkPendingDeletion(pendingDeletion)}
                >
                  Check deletion status
                </Button>
              </div>
              {!deletionEnabled && (
                <p className="text-body-sm text-muted">
                  Community deletion is unavailable right now, so this request
                  can't be checked. It stays saved on this device.
                </p>
              )}
            </div>
          )}
          {deletionEnabled && blockedOwner && (
            <p role="status" className={`${card} text-body-sm`}>
              A deletion request from {npub(blockedOwner)} is still pending on
              this device. Switch to that Buzz identity and use Check deletion
              status before starting another deletion here. If you no longer
              have that identity, contact support.
            </p>
          )}
          {communities.length === 0 ? (
            <p className={`${card} text-body-sm text-muted`}>
              No hosted communities yet.
            </p>
          ) : (
            <ul className="m-0 list-none p-0">
              {[...communities]
                .sort(
                  (a, b) =>
                    Number(Boolean(a.archived_at)) -
                    Number(Boolean(b.archived_at)),
                )
                .map((community, index) => {
                  const name =
                    community.name ?? community.slug ?? "Hosted community";
                  const url = relayUrl(community);
                  const archived = Boolean(community.archived_at);
                  const deletionPending =
                    pendingDeletion?.request.community_id === community.id;
                  return (
                    <li
                      key={community.id ?? community.normalized_host ?? index}
                      className={`${card} flex flex-wrap items-center justify-between gap-3${archived ? " opacity-70" : ""}`}
                    >
                      <div className="min-w-0">
                        <p className="m-0 text-label">{name}</p>
                        <p className="m-0 text-body-sm text-muted">
                          {community.normalized_host}
                          {archived ? " · Archived" : ""}
                        </p>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {archived ? (
                          <>
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={
                                busy || !community.id || deletionPending
                              }
                              onClick={() =>
                                setConfirm({
                                  title: `Unarchive ${name}?`,
                                  description:
                                    "This address becomes connectable again. Connections that closed during archival will not reconnect automatically.",
                                  action: "Unarchive",
                                  run: () =>
                                    mutate(
                                      "unarchive",
                                      community,
                                      "Could not unarchive the community.",
                                    ),
                                })
                              }
                            >
                              <BoxArrowUpIcon aria-hidden="true" /> Unarchive
                            </Button>
                            {deletionEnabled &&
                              ready &&
                              community.id &&
                              community.normalized_host && (
                                <Button
                                  variant="prominent"
                                  size="sm"
                                  disabled={
                                    busy ||
                                    Boolean(pendingDeletion) ||
                                    Boolean(blockedOwner)
                                  }
                                  onClick={() => setDeleteTarget(community)}
                                >
                                  <TrashIcon aria-hidden="true" /> Delete
                                </Button>
                              )}
                          </>
                        ) : (
                          <>
                            {url && ready && (
                              <Button
                                variant="outline"
                                size="sm"
                                disabled={busy}
                                onClick={() => void copy(url)}
                              >
                                {shown?.copied && shown.url === url
                                  ? "Copied"
                                  : "Copy address"}
                              </Button>
                            )}
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={busy || !community.id}
                              onClick={() => setTransfer(community)}
                            >
                              <ArrowsLeftRightIcon aria-hidden="true" />{" "}
                              Transfer
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={busy || !community.id}
                              onClick={() =>
                                setConfirm({
                                  title: `Archive ${name}?`,
                                  description:
                                    "New and existing connections stop and the address stays reserved. Archiving can’t be undone from here without unarchiving, and the community keeps counting toward your quota — it isn’t deleted.",
                                  action: "Archive",
                                  run: () =>
                                    mutate(
                                      "archive",
                                      community,
                                      "Could not archive the community.",
                                    ),
                                })
                              }
                            >
                              <ArchiveIcon aria-hidden="true" /> Archive
                            </Button>
                          </>
                        )}
                      </div>
                    </li>
                  );
                })}
            </ul>
          )}
          {shown?.copied && (
            <p role="status" className="text-body-sm text-muted">
              Address copied. Join it with Add a community (+) in the community
              rail.
            </p>
          )}
          {shown && !shown.copied && (
            <div role="alert" className="text-body-sm">
              <p className="m-0">
                Couldn’t copy the address. Copy it manually, then join it with
                Add a community (+) in the community rail:
              </p>
              <p className="m-0 select-all break-all font-mono">{shown.url}</p>
              <div className="mt-2">
                <Button
                  disabled={busy || !ready}
                  onClick={() => void copy(shown.url)}
                >
                  Try copying again
                </Button>
              </div>
            </div>
          )}
          <CreateCommunity
            enabled={ready && quotaState?.canCreate !== false}
            atLimit={
              quotaState?.canCreate === false
                ? quotaLimitMessage(quotaState.limit)
                : null
            }
            busy={busy}
            creating={action === "create"}
            onCreate={(name) =>
              run("create", async () => {
                const reply = check(
                  await call("create", { name }),
                  "Could not create the community.",
                  quotaState?.limit,
                );
                // Hand off the address before refreshing, so a failed refresh cannot lose it.
                const url = reply.community && relayUrl(reply.community);
                if (url) await copy(url);
                await settle();
              })
            }
          />
        </>
      )}
      {deleteTarget && bound && (
        <DeleteCommunityDialog
          community={deleteTarget}
          pending={action === "delete"}
          failure={failure}
          close={() => setDeleteTarget(null)}
          onDelete={() => {
            const occupied = readPendingDeletion();
            if (blockedOwner || occupied) {
              if (
                occupied?.owner_pubkey === bound &&
                occupied.backend_origin === window.location.origin
              )
                setPendingDeletion(occupied);
              else if (occupied) setBlockedOwner(occupied.owner_pubkey);
              return;
            }
            let pending: PendingDeletion;
            try {
              pending = makePendingDeletion(bound, deleteTarget);
              persistPendingDeletion(pending);
            } catch {
              const stored = readPendingDeletion();
              if (
                stored?.owner_pubkey === bound &&
                stored.backend_origin === window.location.origin
              )
                setPendingDeletion(stored);
              setError(
                "Deletion was not sent because its recovery record could not be saved.",
              );
              return;
            }
            setPendingDeletion(pending);
            setDeleteTarget(null);
            void run("delete", async () => {
              const at = generation.current;
              await settleDeletion(pending, at, () =>
                admitDeletion(pending.request, "fresh"),
              );
            });
          }}
        />
      )}
      {confirm && (
        <AlertDialog
          title={confirm.title}
          description={confirm.description}
          pending={busy}
          onClose={() => setConfirm(null)}
          {...(failure ? { children: failure } : {})}
          actions={
            <>
              <Button disabled={busy} onClick={() => setConfirm(null)}>
                Cancel
              </Button>
              <Button
                variant="prominent"
                loading={busy}
                onClick={() =>
                  void run("confirm", confirm.run).then(
                    (ok) => ok && setConfirm(null),
                  )
                }
              >
                {confirm.action}
              </Button>
            </>
          }
        />
      )}
      {transfer && (
        <TransferDialog
          name={transfer.name ?? transfer.slug ?? "this community"}
          busy={busy}
          failure={failure}
          close={() => setTransfer(null)}
          onTransfer={(recipient) =>
            run("transfer", async () => {
              check(
                await call("transfer", {
                  communityId: transfer.id ?? "",
                  transfereeNpub: recipient,
                }),
                "Could not transfer ownership.",
                quotaState?.limit,
              );
              // The community is no longer owned; drop it before refreshing.
              setCommunities((list) =>
                list.filter((item) => item.id !== transfer.id),
              );
              await settle();
            }).then((ok) => ok && setTransfer(null))
          }
        />
      )}
    </section>
  );
}

function DeleteCommunityDialog({
  community,
  pending,
  failure,
  close,
  onDelete,
}: {
  community: Community;
  pending: boolean;
  failure: ReactNode;
  close(): void;
  onDelete(): void;
}) {
  const [host, setHost] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const expected = community.normalized_host ?? "";
  const name = community.name ?? community.slug ?? "this community";
  const confirmed = host === expected && acknowledged;
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && close()}
      title={`Permanently delete ${name}?`}
      description="This starts an irreversible deletion."
      preventClose={pending}
      actions={
        <>
          <Button disabled={pending} onClick={close}>
            Cancel
          </Button>
          <Button
            variant="prominent"
            loading={pending}
            disabled={!confirmed || pending}
            onClick={onDelete}
          >
            Start deletion
          </Button>
        </>
      }
    >
      <div className="space-y-4 text-body-sm">
        <p className="m-0">
          This request cannot be canceled by an owner. All community content
          will be deleted eventually, the host stays permanently reserved, and
          your quota slot is released only after logical cleanup finishes.
        </p>
        <Field label="Type the exact host">
          <Input
            autoComplete="off"
            spellCheck={false}
            value={host}
            onValueChange={setHost}
          />
        </Field>
        <p className="m-0 break-all font-mono">{expected}</p>
        <Checkbox
          checked={acknowledged}
          onCheckedChange={(checked) => setAcknowledged(checked === true)}
          label="I understand this cannot be canceled and deletion continues after acceptance."
        />
        {failure}
      </div>
    </Dialog>
  );
}

function CreateCommunity({
  enabled,
  atLimit,
  busy,
  creating,
  onCreate,
}: {
  enabled: boolean;
  atLimit: string | null;
  busy: boolean;
  creating: boolean;
  onCreate(name: string): Promise<boolean>;
}) {
  const suffixId = useId();
  const [name, setName] = useState("");
  // null while checking; otherwise the answer or the failure to show.
  const [available, setAvailable] = useState<boolean | null>(null);
  const [failed, setFailed] = useState("");
  const [attempt, setAttempt] = useState(0);
  const valid = name.length <= 63 && VALID_NAME.test(name);
  // Check a paused, valid address so the result is ready before Create.
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt re-runs the same check on retry.
  useEffect(() => {
    setAvailable(null);
    setFailed("");
    if (!enabled || !valid) return;
    let current = true;
    const timer = setTimeout(() => {
      void call("availability", { name })
        .then((reply) => {
          check(reply, "Could not check that address.");
          if (current) setAvailable(Boolean(reply.available));
        })
        .catch((reason) => current && setFailed(message(reason)));
    }, 500);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [enabled, name, valid, attempt]);
  return (
    <form
      className={card}
      onSubmit={(event) => {
        event.preventDefault();
        if (enabled && valid && available)
          void onCreate(name).then((ok) => ok && setName(""));
      }}
    >
      <h3 className="m-0 text-label">Create a community</h3>
      <p className="mt-1 text-body-sm text-muted">
        Choose the address your team will use to connect.
      </p>
      {atLimit && <p className="text-body-sm text-muted">{atLimit}</p>}
      <Field
        label="Community address"
        labelVisibility="hidden"
        invalid={Boolean(name) && !valid}
        error={
          name && !valid
            ? "Use lowercase letters, numbers, and single hyphens."
            : available === false
              ? "That address is already taken."
              : undefined
        }
      >
        <div className="flex max-w-xl flex-wrap items-center gap-2">
          <div className="min-w-0 flex-1 basis-48">
            <Input
              autoComplete="off"
              spellCheck={false}
              maxLength={63}
              placeholder="north-star"
              aria-describedby={suffixId}
              disabled={!enabled || busy}
              value={name}
              onValueChange={(value) => setName(value.trim().toLowerCase())}
            />
          </div>
          <span id={suffixId} className="shrink-0 text-body-sm text-muted">
            .{HOST_SUFFIX}
          </span>
        </div>
      </Field>
      {valid && enabled && failed ? (
        <div role="alert" className="text-body-sm">
          <p className="error m-0 break-words">{failed}</p>
          <div className="mt-2">
            <Button onClick={() => setAttempt((count) => count + 1)}>
              Check again
            </Button>
          </div>
        </div>
      ) : (
        <p role="status" className="text-body-sm text-muted">
          {valid && enabled
            ? available === null
              ? "Checking availability…"
              : available
                ? "That address is available."
                : ""
            : ""}
        </p>
      )}
      <Button
        type="submit"
        variant="primary"
        loading={creating}
        disabled={!enabled || !valid || !available || busy}
      >
        Create community
      </Button>
    </form>
  );
}

function TransferDialog({
  name,
  busy,
  failure,
  close,
  onTransfer,
}: {
  name: string;
  busy: boolean;
  failure: ReactNode;
  close(): void;
  onTransfer(npub: string): void;
}) {
  const [recipient, setRecipient] = useState("");
  const valid = /^npub1[02-9ac-hj-np-z]{58}$/.test(recipient);
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && close()}
      preventClose={busy}
      title="Transfer ownership"
      description={`Transfer ${name} to another person. You become a regular member. The recipient needs a connected Buzz identity first, and this can’t be undone.`}
      actions={
        <>
          <Button disabled={busy} onClick={close}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            loading={busy}
            disabled={!valid}
            onClick={() => onTransfer(recipient)}
          >
            Transfer ownership
          </Button>
        </>
      }
    >
      <Field
        label="Recipient npub"
        invalid={Boolean(recipient) && !valid}
        error={
          recipient && !valid
            ? "Enter a valid npub that starts with npub1."
            : undefined
        }
      >
        <Input
          autoComplete="off"
          spellCheck={false}
          placeholder="npub1…"
          value={recipient}
          onValueChange={(value) => setRecipient(value.trim())}
        />
      </Field>
      {failure}
    </Dialog>
  );
}
