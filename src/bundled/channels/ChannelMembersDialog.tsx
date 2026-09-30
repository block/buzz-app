import { motion, useReducedMotion } from "motion/react";
import { Button as BaseButton } from "@base-ui/react/button";
import referenceStyles from "../../shared/InlineReference.module.css";
import { npubEncode } from "nostr-tools/nip19";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { RelaySession } from "../../features/relay/session";
import type { AgentControl } from "../../features/agents/control";
import { useAgentChoices } from "../../features/agents/use-choices";
import { useIdentityNames } from "../../features/identity-names/react";
import { usePresenceStatus } from "../../features/presence/react";
import { profileTarget } from "../../features/profiles/target";
import styles from "./ChannelMembersDialog.module.css";
import { canAddMembers } from "../../features/channel-members/members";
import {
  formatPublicKey,
  publicKeyLabels,
} from "../../shared/identity/public-key";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { Button } from "../../shared/design-system/ui/Button";
import { SearchField } from "../../shared/design-system/ui/SearchField";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import type { AriaAttributes } from "react";
import { AgentOwnerPreview } from "../../features/profiles/AgentOwnerPreview";
import { IdentityRow } from "../../shared/identity/IdentityRow";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import {
  ArrowsClockwiseIcon,
  UsersIcon,
} from "../../shared/design-system/icons";
import {
  MemberRow,
  InvitationRow,
  MemberAdministrationStatus,
  useMemberAdministration,
} from "./MemberAdministration";
import { useMemberSearch } from "./useMemberSearch";
import { useMemberOwners } from "./useMemberOwners";

/** Mounted rows share the same bounded presence owner as message bylines. */
function MemberAvatar({
  session,
  pubkey,
  name,
  picture,
  agent,
  descriptionId,
}: {
  session: RelaySession;
  pubkey: string;
  name: string;
  picture: string | undefined;
  agent: boolean;
  descriptionId: string;
}) {
  const presence = usePresenceStatus(session.presence, pubkey);
  return (
    <>
      <Avatar
        alt=""
        fallback={name}
        src={picture ? session.media(picture, "small") : undefined}
        size="default"
        shape={agent ? "squircle" : "circle"}
        statusBadge={presence === "unknown" ? undefined : presence}
      />
      <span className="sr-only" id={descriptionId}>
        {presence === "unknown" ? "" : `Presence: ${presence}`}
      </span>
    </>
  );
}

type ProfileNavigation = {
  canOpenLink?: ((target: string) => boolean) | undefined;
  onOpenLink?:
    | ((target: string, returnFocus?: HTMLElement) => boolean)
    | undefined;
};

export function ChannelMembersButton({
  session,
  channelId,
  control,
  canOpenLink,
  onOpenLink,
}: {
  session: RelaySession;
  channelId: string;
  control?: AgentControl | undefined;
} & ProfileNavigation) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <>
      <IconButton
        ref={trigger}
        size="sm"
        aria-label="Channel members"
        title="Channel members"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
        icon={<UsersIcon size={19} aria-hidden="true" />}
      />
      {open && (
        <ChannelMembersDialog
          session={session}
          channelId={channelId}
          control={control}
          canOpenLink={canOpenLink}
          onOpenLink={onOpenLink}
          close={() => setOpen(false)}
          trigger={trigger}
        />
      )}
    </>
  );
}

/** Members are shared relay truth; only search and in-progress presentation belong to this dialog. */
export function ChannelMembersDialog({
  session,
  channelId,
  control,
  close,
  trigger,
  canOpenLink,
  onOpenLink,
}: {
  session: RelaySession;
  channelId: string;
  control?: AgentControl | undefined;
  close(): void;
  trigger: React.RefObject<HTMLButtonElement | null>;
} & ProfileNavigation) {
  const reducedMotion = useReducedMotion();
  const presenceId = useId();
  const openingProfile = useRef(false);
  const input = useRef<HTMLElement>(null);
  const focusedAdd = useRef<{ key: string; button: HTMLButtonElement } | null>(
    null,
  );
  const lifetime = useRef<AbortController>(undefined);
  const [query, setQuery] = useState("");
  const additions = useSyncExternalStore(
    session.memberAdditions.subscribe,
    session.memberAdditions.snapshot,
    session.memberAdditions.snapshot,
  ).filter((item) => item.channelId === channelId);
  const busy = new Set(
    additions.filter((item) => item.pending).map((item) => item.pubkey),
  );
  const errors = Object.fromEntries(
    additions
      .filter((item) => item.error)
      .map((item) => [item.pubkey, item.error]),
  );
  const [notice, setNotice] = useState("");
  const [rosterError, setRosterError] = useState("");
  const [nameError, setNameError] = useState("");
  const [rosterBusy, setRosterBusy] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const [namesBusy, setNamesBusy] = useState(false);
  const [agentsBusy, setAgentsBusy] = useState(false);
  const list = useSyncExternalStore(
    session.channels.subscribeList,
    session.channels.list,
    session.channels.list,
  );
  const profiles = useSyncExternalStore(
    session.profiles.subscribe,
    session.profiles.snapshot,
    session.profiles.snapshot,
  );
  const archives = useSyncExternalStore(
    session.archives.subscribe,
    session.archives.snapshot,
    session.archives.snapshot,
  );
  const agents = useAgentChoices(session);
  const resolveName = useIdentityNames(session.names);
  const channel =
    list.channels.find((item) => item.id === channelId) ??
    session.channels.get?.(channelId);
  const canAdd = canAddMembers(session, channel);
  const search = useMemberSearch(session, query, canAdd);
  // biome-ignore lint/correctness/useExhaustiveDependencies: destination changes retire addition notices.
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    setAgentsBusy(false);
    return () => {
      controller.abort();
      lifetime.current = undefined;
    };
  }, [session, channelId]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh explicitly retries the roster read.
  useEffect(() => {
    let current = true;
    setRosterBusy(true);
    setRosterError("");
    void session
      .read([{ kinds: [39002], "#d": [channelId], limit: 1 }], { fresh: true })
      .then(
        (events) => {
          if (
            current &&
            !events.some(
              (event) =>
                event.kind === 39002 &&
                event.tags.some(
                  ([tag, value]) => tag === "d" && value === channelId,
                ),
            )
          )
            setRosterError(
              "The member list could not be confirmed. Try again.",
            );
        },
        () => {
          if (current)
            setRosterError("The member list could not load. Try again.");
        },
      )
      .finally(() => {
        if (current) setRosterBusy(false);
      });
    void session.archives.ensure();
    return () => {
      current = false;
    };
  }, [session, channelId, refresh]);
  const memberKey = channel?.members?.join(":") ?? "";
  const administration = useMemberAdministration(
    session,
    channelId,
    memberKey,
    !!channel && !channel.cached,
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh retries missing names with the other dialog reads.
  useEffect(() => {
    setNameError("");
    setNamesBusy(!!memberKey);
    if (!memberKey) return;
    let current = true;
    void session.profiles
      .ensure(memberKey.split(":"), "background")
      .catch(() => {
        if (current)
          setNameError(
            "Some names could not load. Public keys still identify members. Try again.",
          );
      })
      .finally(() => {
        if (current) setNamesBusy(false);
      });
    return () => {
      current = false;
    };
  }, [session, memberKey, refresh]);
  const known = new Map(
    agents.identities.map((agent) => [agent.pubkey, agent]),
  );
  const members = new Set(channel?.members ?? []);
  const archived = new Set(archives.archived);
  const label = (key: string, fallback?: string) =>
    resolveName(
      key,
      profiles.get(key)?.name ??
        fallback ??
        formatPublicKey(key) ??
        "Unknown member",
    );
  const matches = (key: string, name: string) =>
    `${name} ${key} ${npubEncode(key)}`
      .toLowerCase()
      .includes(query.trim().toLowerCase());
  const currentMembers = [...members].sort(
    (a, b) => label(a).localeCompare(label(b)) || a.localeCompare(b),
  );
  const groups = ["Owners", "Admins", "Members"].map((name) => {
    const keys = currentMembers.filter((key) => {
      const role = administration.authority.roles[key];
      const group =
        role === "owner" ? "Owners" : role === "admin" ? "Admins" : "Members";
      return group === name;
    });
    return {
      name,
      count: keys.length,
      keys: keys.filter((key) => matches(key, label(key))),
    };
  });
  const candidates = new Map(
    search.people.map((person) => [person.pubkey, person]),
  );
  if (query.trim())
    for (const agent of agents.identities) {
      if (matches(agent.pubkey, label(agent.pubkey, agent.name)))
        candidates.set(agent.pubkey, {
          pubkey: agent.pubkey,
          name: agent.name,
          isAgent: true,
        });
    }
  const available = [...candidates.values()].filter(
    (person) => !members.has(person.pubkey) && !archived.has(person.pubkey),
  );
  const agentKeys = [
    ...new Set([
      ...currentMembers.filter(
        (key) =>
          matches(key, label(key)) &&
          (known.has(key) || profiles.get(key)?.isAgent),
      ),
      ...available
        .filter(
          (person) =>
            person.isAgent ||
            known.has(person.pubkey) ||
            profiles.get(person.pubkey)?.isAgent,
        )
        .map((person) => person.pubkey),
    ]),
  ]
    .sort()
    .join(":");
  const ownership = useMemberOwners(session, agentKeys, refresh);
  const refreshing =
    ownership.busy ||
    rosterBusy ||
    administration.status === "loading" ||
    namesBusy ||
    search.loading ||
    agents.pending ||
    agentsBusy ||
    archives.status === "loading";
  const mutationPending =
    busy.size > 0 || administration.operation?.status === "pending";
  const refreshMembers = () => {
    if (refreshing || mutationPending) return;
    setRosterBusy(true);
    setRefresh((value) => value + 1);
    void session.memberAdministration.refresh(channelId).catch(() => {});
    // Native inventory retains ready data during refresh, so its snapshot alone
    // does not expose every in-flight read.
    const signal = lifetime.current?.signal;
    setAgentsBusy(true);
    void session.agentChoices.refresh().finally(() => {
      if (!signal?.aborted) setAgentsBusy(false);
    });
    void session.archives.refresh();
    search.refresh();
  };
  const keys = publicKeyLabels([...members, ...candidates.keys()]);
  // A confirmed addition replaces its focused Add button with a member row.
  // DOM removal does not emit blur, so restore focus only if it was not moved elsewhere.
  useLayoutEffect(() => {
    const previous = focusedAdd.current;
    if (!previous || !memberKey.split(":").includes(previous.key)) return;
    focusedAdd.current = null;
    if (
      document.activeElement === previous.button ||
      document.activeElement === document.body
    )
      input.current?.focus();
  }, [memberKey]);
  const add = async (key: string) => {
    const signal = lifetime.current?.signal;
    if (!signal) return;
    setNotice("");
    try {
      await session.memberAdditions.add(channelId, key, control);
      if (!signal.aborted) setNotice(`${label(key)} is in the channel.`);
    } catch {
      // Session-owned recovery remains visible if this dialog closes and reopens.
    }
  };

  const row = (
    key: string,
    name: string,
    adding: boolean,
    picture?: string,
    agent?: boolean,
  ) => {
    const isAgent = agent || known.has(key) || profiles.get(key)?.isAgent;
    const artwork = picture ?? profiles.get(key)?.picture;
    const target = profileTarget(key);
    const clickable = !!target && !!onOpenLink && !!canOpenLink?.(target);
    const role = administration.authority.roles[key];
    const roleLabel =
      isAgent && role === "bot"
        ? "member"
        : (role ??
          (administration.status === "idle" ||
          administration.status === "loading"
            ? undefined
            : "Role unverified"));
    const expanded = {
      height: "auto",
      marginTop: "var(--space-half)",
      opacity: 1,
    };
    const avatar = (
      <MemberAvatar
        session={session}
        pubkey={key}
        name={name}
        picture={artwork}
        agent={!!isAgent}
        descriptionId={`${presenceId}-${key}`}
      />
    );
    const openProfile = (destination: string | undefined) => {
      if (!destination || !canOpenLink?.(destination)) return false;
      // Hand modal focus to the existing panel, with a stable return target.
      openingProfile.current = true;
      if (onOpenLink?.(destination, trigger.current ?? undefined)) {
        close();
        return true;
      }
      openingProfile.current = false;
      return false;
    };
    const viewProfile = () => openProfile(target);
    const owner = isAgent ? ownership.owners.get(key) : undefined;
    const ownerTarget = owner ? profileTarget(owner) : undefined;
    const ownerName = owner
      ? `${label(owner)}${owner === session.viewer ? " (you)" : ""}`
      : "";
    const profile = (previewProps: AriaAttributes) => (
      <div className={styles.profileContent}>
        {clickable && (
          <div className={styles.profileHitTarget}>
            <NavigationItem
              {...previewProps}
              label=""
              icon={avatar}
              aria-label={`Open profile for ${name} (${keys.get(key)})${isAgent ? ", agent" : ""}${adding ? ", not in this channel" : roleLabel ? `, ${roleLabel}` : ""}${!adding && archived.has(key) ? ", archived" : ""}`}
              title={npubEncode(key)}
              aria-describedby={`${previewProps["aria-describedby"]} ${presenceId}-${key}`}
              onClick={viewProfile}
            />
          </div>
        )}
        <div
          className={styles.staticProfile}
          data-profile-link={clickable || undefined}
          title={npubEncode(key)}
        >
          {!clickable && avatar}
          <span className="min-w-0 flex-1">
            <span className={styles.identity}>
              <span className={styles.identityName}>
                <span className={`${styles.name} text-body-sm`}>
                  {name}
                  {key === session.viewer ? " (you)" : ""}
                </span>
              </span>
              {owner && (
                <span className={styles.manager}>
                  {" managed by "}
                  {ownerTarget && onOpenLink && canOpenLink?.(ownerTarget) ? (
                    <BaseButton
                      className={referenceStyles.link}
                      aria-label={`Open owner profile: ${ownerName}`}
                      onClick={() => openProfile(ownerTarget)}
                    >
                      {ownerName}
                    </BaseButton>
                  ) : (
                    ownerName
                  )}
                </span>
              )}
            </span>
            <motion.span
              className={styles.metadata}
              variants={{
                rest: { height: 0, marginTop: 0, opacity: 0 },
                revealed: expanded,
                focused: { ...expanded, transition: { duration: 0 } },
              }}
              transition={{
                duration: reducedMotion ? 0 : 0.14,
                ease: [0.23, 1, 0.32, 1],
              }}
            >
              <span className={styles.metadataContent}>
                <span
                  className={`${styles.publicKey} text-mono text-body-sm text-subtle`}
                  aria-hidden="true"
                >
                  {keys.get(key)}
                </span>
              </span>
            </motion.span>
          </span>
        </div>
      </div>
    );
    const identity = (
      <IdentityRow
        pubkey={key}
        name={`${name}${key === session.viewer ? " (you)" : ""}`}
        picture={artwork ? session.media(artwork, "small") : undefined}
        isAgent={isAgent}
        keyLabel={keys.get(key)}
        detail={archived.has(key) ? "Archived" : undefined}
        previewDetail={
          isAgent ? (
            <AgentOwnerPreview session={session} pubkey={key} />
          ) : undefined
        }
        renderContent={profile}
        render={clickable ? (content) => content : undefined}
      />
    );
    return adding ? (
      <InvitationRow key={key}>
        <div className={styles.profile}>{identity}</div>
        <span className={styles.addAction}>
          <Button
            variant="prominent"
            size="xs"
            aria-label={`Add ${name} (${keys.get(key)})`}
            aria-disabled={busy.has(key) || undefined}
            disabled={rosterBusy || !!rosterError}
            onBlur={(event) => {
              if (focusedAdd.current?.button === event.currentTarget)
                focusedAdd.current = null;
            }}
            onClick={(event) => {
              if (busy.has(key)) return;
              if (document.activeElement === event.currentTarget)
                focusedAdd.current = { key, button: event.currentTarget };
              void add(key);
            }}
          >
            {busy.has(key) ? "Adding…" : "Add"}
          </Button>
        </span>
      </InvitationRow>
    ) : (
      <MemberRow
        key={key}
        session={session}
        channelId={channelId}
        pubkey={key}
        name={name}
        returnFocus={input}
        onViewProfile={clickable ? viewProfile : undefined}
      >
        {identity}
      </MemberRow>
    );
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
      title="Channel members"
      height="stable"
      bodyLayout="flex"
      description={channel?.name}
      closeLabel="Close channel members"
      headerActions={
        <IconButton
          variant="ghost"
          size="compact"
          aria-label="Refresh member data"
          title="Refresh member data"
          aria-busy={refreshing}
          disabled={refreshing || mutationPending}
          focusableWhenDisabled
          onClick={refreshMembers}
          icon={
            <ArrowsClockwiseIcon
              size={16}
              aria-hidden="true"
              className={refreshing ? "motion-safe:animate-spin" : undefined}
            />
          }
        />
      }
      initialFocus={input}
      finalFocus={() => (openingProfile.current ? false : trigger.current)}
    >
      <div className={styles.layout}>
        <div className="shrink-0">
          <SearchField
            inputRef={input}
            label="Search people and agents"
            placeholder={canAdd ? "Add people and agents" : "Search members"}
            value={query}
            onValueChange={setQuery}
            maxLength={256}
          />
        </div>
        <section className={styles.memberList} aria-label="Member list">
          {!canAdd && (
            <p className="text-body-sm text-subtle">
              {channel?.channelType === "dm"
                ? "DM membership cannot be changed here."
                : channel?.archived
                  ? "Archived channels cannot add members."
                  : !session.outbox?.supports(9000)
                    ? "Adding members is unavailable in this connection."
                    : "Join this channel to add people and agents."}
            </p>
          )}
          {rosterError && (
            <p role="alert" className="text-body-sm text-danger">
              {rosterError}
            </p>
          )}
          <MemberAdministrationStatus session={session} channelId={channelId} />
          {groups
            .filter((group) => group.keys.length || group.name === "Members")
            .map((group) => (
              <section key={group.name} aria-label={group.name}>
                <h3
                  className={`${styles.groupHeading} px-control-inset pb-2 text-caption text-subtle`}
                >
                  {group.name} · {group.count}
                </h3>
                <ul>{group.keys.map((key) => row(key, label(key), false))}</ul>
                {group.name === "Members" &&
                  !groups.some((item) => item.keys.length) &&
                  !rosterBusy && (
                    <p className="px-control-inset text-body-sm text-subtle">
                      {query
                        ? "No members match your search."
                        : "No members to show."}
                    </p>
                  )}
              </section>
            ))}
          {canAdd && query.trim() && (
            <section
              className={styles.memberGroup}
              aria-label="Not in this channel"
            >
              <h3
                className={`${styles.groupHeading} px-control-inset pb-2 text-caption text-subtle`}
              >
                Not in this channel
              </h3>
              {available.map((person) =>
                row(
                  person.pubkey,
                  label(person.pubkey, person.name),
                  true,
                  person.picture,
                  person.isAgent,
                ),
              )}
              {search.loading && (
                <p
                  role="status"
                  className="px-control-inset text-body-sm text-subtle"
                >
                  Searching…
                </p>
              )}
              {!search.loading && !search.error && !available.length && (
                <p className="px-control-inset text-body-sm text-subtle">
                  No other matching people or agents.
                </p>
              )}
              {search.error && (
                <p
                  role="alert"
                  className="px-control-inset text-body-sm text-danger"
                >
                  {search.error}
                </p>
              )}
              {search.more && (
                <div className="flex justify-center">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={search.next}
                    disabled={search.loading}
                  >
                    Show more results
                  </Button>
                </div>
              )}
            </section>
          )}
          {nameError && (
            <p role="status" className="text-body-sm text-subtle">
              {nameError}
            </p>
          )}
          {ownership.failed && (
            <p role="status" className="text-body-sm text-subtle">
              Some agent managers or their names could not load. Try again.
            </p>
          )}
          {agents.error && (
            <p role="alert" className="text-body-sm text-danger">
              Some agents could not load.
            </p>
          )}
          {archives.status === "error" && (
            <p role="alert" className="text-body-sm text-danger">
              Archived identities could not be checked.
            </p>
          )}
          {Object.entries(errors).map(([key, error]) => (
            <p role="alert" key={key} className="text-body-sm text-danger">
              {label(key)}: {error}{" "}
              {!additions.find((item) => item.pubkey === key)?.removed && (
                <Button
                  variant="outline"
                  disabled={busy.has(key) || !canAdd}
                  onClick={() => void add(key)}
                >
                  {busy.has(key) ? "Retrying…" : "Retry"}
                </Button>
              )}
            </p>
          ))}
          {notice && (
            <p role="status" className="text-body-sm text-subtle">
              {notice}
            </p>
          )}
        </section>
      </div>
    </Dialog>
  );
}
