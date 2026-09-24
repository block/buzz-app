import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { decode } from "nostr-tools/nip19";
import { communityFromScope } from "../../features/relay/gifs";
import { useRelayConnection } from "../../features/relay/react";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import { formatPublicKey } from "../../shared/identity/public-key";
import { DotsThreeIcon } from "../../shared/design-system/icons/index";
import { AlertDialog } from "../../shared/design-system/ui/AlertDialog";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { Field } from "../../shared/design-system/ui/Field";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { Input } from "../../shared/design-system/ui/Input";
import {
  MenuItem,
  MenuPopup,
  MenuRoot,
  MenuTrigger,
} from "../../shared/design-system/ui/Menu";
import { SearchField } from "../../shared/design-system/ui/SearchField";
import { Select } from "../../shared/design-system/ui/Select";
import {
  allowedActions,
  changeMember,
  MEMBERSHIP_KIND,
  membersFromSnapshot,
  mintInvite,
  relayAuthor,
  type Action,
  type Invite,
  type Member,
  type MemberChange,
} from "./api";

const DAY = 24 * 60 * 60;
const EXPIRY = [1, 3, 7, 30].map((days) => ({
  value: String(days * DAY),
  label: days === 1 ? "1 day" : `${days} days`,
}));
const USES = [
  { value: "", label: "No limit" },
  ...[1, 5, 10, 25].map((uses) => ({
    value: String(uses),
    label: uses === 1 ? "1 use" : `${uses} uses`,
  })),
];
const message = (reason: unknown) =>
  reason instanceof Error ? reason.message : String(reason);

export function CommunityAdmin({
  relay,
  active,
}: {
  relay: RelayData;
  active(): boolean;
}) {
  const connection = useRelayConnection(relay);
  const community =
    connection.status === "ready" && connection.scope
      ? communityFromScope(connection.scope)
      : null;
  return (
    <section aria-labelledby="community-admin-title">
      <h2 id="community-admin-title" className="mt-0 mb-2 text-label">
        Invites
      </h2>
      <p className="text-body-sm text-muted">
        Manage members and community access.
      </p>
      {community && connection.viewer ? (
        <Members
          key={`${connection.scope}:${connection.generation}`}
          session={connection.session}
          community={community}
          viewer={connection.viewer}
          active={active}
        />
      ) : (
        <p role="status">Choose a connected community to manage members.</p>
      )}
    </section>
  );
}

type Pending = { member: Member; action: Action };

function Members({
  session,
  community,
  viewer,
  active,
}: {
  session: RelaySession;
  community: string;
  viewer: string;
  active(): boolean;
}) {
  const [members, setMembers] = useState<Member[] | null>();
  const [error, setError] = useState("");
  // A failed read never erases a confirmed write; it only marks the list stale.
  const [readError, setReadError] = useState("");
  const [notice, setNotice] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [inviting, setInviting] = useState(false);
  const reading = useRef<AbortController | null>(null);
  const profiles = useSyncExternalStore(
    session.profiles.subscribe,
    session.profiles.snapshot,
  );
  /** Read-only roster refresh; the newest request wins and never rethrows. */
  const refresh = useCallback(async () => {
    reading.current?.abort();
    const controller = new AbortController();
    reading.current = controller;
    const { signal } = controller;
    setRefreshing(true);
    try {
      const author = await relayAuthor(community);
      const events = await session.read(
        [{ kinds: [MEMBERSHIP_KIND], authors: [author], limit: 1 }],
        { fresh: true, signal },
      );
      const latest = [...events].sort((a, b) => b.created_at - a.created_at)[0];
      const next = latest ? membersFromSnapshot(latest, author) : null;
      if (signal.aborted) return;
      setMembers(next);
      setReadError("");
      if (next) void session.profiles.ensure(next.map((m) => m.pubkey));
    } catch (reason) {
      if (signal.aborted) return;
      setMembers((current) => current ?? null);
      setReadError(`Could not load members: ${message(reason)}`);
    } finally {
      if (!signal.aborted) setRefreshing(false);
    }
  }, [session, community]);
  useEffect(() => {
    void refresh();
    return () => reading.current?.abort();
  }, [refresh]);
  const role = members?.find((m) => m.pubkey === viewer)?.role;
  const manager = role === "owner" || role === "admin";
  const stale = !!readError;
  const name = (pubkey: string) =>
    profiles.get(pubkey)?.name || formatPublicKey(pubkey) || pubkey;
  /** Sends one command. Rejects only when the write itself is not confirmed. */
  async function apply(change: MemberChange) {
    if (!active()) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      try {
        await changeMember(community, change);
      } catch (reason) {
        setError(message(reason));
        throw reason;
      }
      setNotice("Change accepted by the relay.");
      // Stay busy until the roster reflects the write, so no stale row acts.
      await refresh();
    } finally {
      setBusy(false);
    }
  }
  const refreshButton = (
    <Button
      loading={refreshing}
      disabled={refreshing || busy}
      onClick={() => void refresh()}
    >
      {readError ? "Retry" : "Refresh"}
    </Button>
  );
  const status = (
    <>
      {notice && (
        <p role="status" className="m-0 text-body-sm">
          {notice}
        </p>
      )}
      {readError && (
        <p role="alert" className="m-0 text-body-sm">
          {readError}
          {members ? " The list below may be out of date." : ""}
        </p>
      )}
    </>
  );
  if (members === undefined) return <p role="status">Loading members…</p>;
  if (members === null || !manager)
    return (
      <div className="mt-4 flex flex-col items-start gap-3">
        {status}
        {!readError && (
          <p role="status" className="m-0">
            {members === null
              ? "This community does not publish a member list, so it has no member administration."
              : "Only community owners and admins can invite people or manage members."}
          </p>
        )}
        {refreshButton}
      </div>
    );
  const needle = query.trim().toLowerCase();
  const shown = members
    .filter(
      (m) =>
        !needle ||
        name(m.pubkey).toLowerCase().includes(needle) ||
        m.pubkey.includes(needle),
    )
    .sort(
      (a, b) =>
        ["owner", "admin", "member"].indexOf(a.role) -
          ["owner", "admin", "member"].indexOf(b.role) ||
        name(a.pubkey).localeCompare(name(b.pubkey)),
    );
  const verb = {
    promote: "Make admin",
    demote: "Make member",
    remove: "Remove",
  } as const;
  return (
    <>
      <div className="mt-4 flex justify-end gap-2">
        {refreshButton}
        <Button variant="primary" onClick={() => setInviting(true)}>
          Invite to community
        </Button>
      </div>
      {status}
      {error && (
        <p role="alert" className="text-body-sm">
          {error}
        </p>
      )}
      <h3 className="mt-6 text-label">
        Members <span className="text-muted">{members.length}</span>
      </h3>
      <div className="rounded-xl border border-default p-4">
        <SearchField
          label="Search members"
          placeholder="Search members"
          value={query}
          onValueChange={setQuery}
        />
        <ul className="m-0 mt-3 list-none p-0" aria-label="Members">
          {shown.map((member) => {
            // A stale list must not offer another destructive command.
            const actions = stale
              ? []
              : allowedActions(role, member, member.pubkey === viewer);
            const label = name(member.pubkey);
            return (
              <li key={member.pubkey} className="flex items-center gap-3 py-2">
                <Avatar
                  src={profiles.get(member.pubkey)?.picture}
                  alt=""
                  fallback={label}
                />
                <div className="min-w-0 flex-1">
                  <p className="m-0 truncate text-body">{label}</p>
                  <p className="m-0 text-body-sm text-muted">
                    {member.role[0]?.toUpperCase() + member.role.slice(1)}
                    {member.pubkey === viewer ? " · You" : ""}
                  </p>
                </div>
                {actions.length > 0 && (
                  <MenuRoot>
                    <MenuTrigger
                      render={
                        <IconButton
                          aria-label={`Actions for ${label}`}
                          icon={<DotsThreeIcon />}
                          disabled={busy}
                        />
                      }
                    />
                    <MenuPopup align="end">
                      {actions.map((action) => (
                        <MenuItem
                          key={action}
                          onClick={() => setPending({ member, action })}
                        >
                          {verb[action]}
                        </MenuItem>
                      ))}
                    </MenuPopup>
                  </MenuRoot>
                )}
              </li>
            );
          })}
        </ul>
        {!shown.length && (
          <p role="status" className="text-body-sm text-muted">
            No members match.
          </p>
        )}
      </div>
      {pending && (
        <AlertDialog
          title={`${verb[pending.action]}: ${name(pending.member.pubkey)}?`}
          description={
            pending.action === "remove"
              ? "They lose access to this community until they are invited again."
              : pending.action === "promote"
                ? "Admins can invite people and remove members."
                : "They will no longer be able to invite people or manage members."
          }
          pending={busy}
          onClose={() => setPending(null)}
          actions={
            <>
              <Button disabled={busy} onClick={() => setPending(null)}>
                Cancel
              </Button>
              <Button
                variant={
                  pending.action === "remove" ? "destructive" : "primary"
                }
                loading={busy}
                onClick={() =>
                  void apply(
                    pending.action === "remove"
                      ? { action: "remove", pubkey: pending.member.pubkey }
                      : {
                          action: "role",
                          pubkey: pending.member.pubkey,
                          role:
                            pending.action === "promote" ? "admin" : "member",
                        },
                  )
                    .then(() => setPending(null))
                    .catch(() => setPending(null))
                }
              >
                {verb[pending.action]}
              </Button>
            </>
          }
        />
      )}
      <InviteDialog
        open={inviting}
        close={() => setInviting(false)}
        community={community}
        owner={role === "owner"}
        active={active}
        add={(pubkey, next) => apply({ action: "add", pubkey, role: next })}
      />
    </>
  );
}

function publicKey(input: string) {
  const value = input.trim();
  if (/^[0-9a-f]{64}$/i.test(value)) return value.toLowerCase();
  try {
    const decoded = decode(value);
    if (decoded.type === "npub") return decoded.data;
  } catch {
    // Reported below.
  }
  throw new Error("Enter an npub or 64-character hex public key.");
}

function InviteDialog({
  open,
  close,
  community,
  owner,
  active,
  add,
}: {
  open: boolean;
  close(): void;
  community: string;
  owner: boolean;
  active(): boolean;
  add(pubkey: string, role: "admin" | "member"): Promise<void>;
}) {
  const [ttl, setTtl] = useState(String(3 * DAY));
  const [uses, setUses] = useState("");
  const [invite, setInvite] = useState<Invite | null>(null);
  const [key, setKey] = useState("");
  const [role, setRole] = useState<"admin" | "member">("member");
  const [busy, setBusy] = useState<"" | "mint" | "add">("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  async function run(kind: "mint" | "add", work: () => Promise<void>) {
    if (!active()) return;
    setBusy(kind);
    setError("");
    setNotice("");
    try {
      await work();
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy("");
    }
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) return;
        setInvite(null);
        setError("");
        setNotice("");
        close();
      }}
      preventClose={!!busy}
      title="Invite to community"
      description="Add someone directly or create a link they can use to join."
    >
      <div className="flex flex-col gap-4">
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void run("add", async () => {
              await add(publicKey(key), owner ? role : "member");
              setKey("");
              setNotice("Member added.");
            });
          }}
        >
          <Field label="Public key">
            <Input
              value={key}
              placeholder="npub1…"
              onValueChange={setKey}
              disabled={!!busy}
            />
          </Field>
          {owner && (
            <Select
              variant="field"
              label="Role"
              value={role}
              onValueChange={(value) => setRole(value as "admin" | "member")}
              groups={[
                {
                  label: "Role",
                  options: [
                    { value: "member", label: "Member" },
                    { value: "admin", label: "Admin" },
                  ],
                },
              ]}
            />
          )}
          <Button
            type="submit"
            loading={busy === "add"}
            disabled={!key.trim() || !!busy}
          >
            Add member
          </Button>
        </form>
        <hr className="m-0 border-default" />
        <div className="flex flex-wrap gap-3">
          <Select
            variant="field"
            label="Expires after"
            value={ttl}
            onValueChange={setTtl}
            groups={[{ label: "Expires after", options: EXPIRY }]}
          />
          <Select
            variant="field"
            label="Maximum uses"
            value={uses}
            onValueChange={setUses}
            groups={[{ label: "Maximum uses", options: USES }]}
          />
        </div>
        <Button
          loading={busy === "mint"}
          disabled={!!busy}
          onClick={() =>
            void run("mint", async () => {
              setInvite(null);
              setInvite(
                await mintInvite(
                  community,
                  Number(ttl),
                  uses ? Number(uses) : null,
                ),
              );
            })
          }
        >
          {invite ? "Create another link" : "Create invite link"}
        </Button>
        {invite && (
          <div className="flex flex-col gap-2">
            <Field label="Invite link">
              <Input value={invite.url} readOnly />
            </Field>
            <p className="m-0 text-body-sm text-muted">
              Expires {new Date(invite.expires_at * 1000).toLocaleString()} ·{" "}
              {invite.max_uses === null
                ? "No use limit"
                : `${invite.uses_remaining ?? invite.max_uses} of ${invite.max_uses} uses left`}
            </p>
            <Button
              onClick={() =>
                navigator.clipboard
                  .writeText(invite.url)
                  .then(() => setNotice("Invite link copied."))
                  .catch(() => setError("Could not copy the invite link."))
              }
            >
              Copy link
            </Button>
          </div>
        )}
        {error && (
          <p role="alert" className="m-0 text-body-sm">
            {error}
          </p>
        )}
        {notice && (
          <p role="status" className="m-0 text-body-sm">
            {notice}
          </p>
        )}
      </div>
    </Dialog>
  );
}
