import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { AlertDialog } from "../../shared/design-system/ui/AlertDialog";
import { Button } from "../../shared/design-system/ui/Button";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import {
  CaretDownIcon,
  GlobeIcon,
  PlusIcon,
  UsersPlusIcon,
} from "../../shared/design-system/icons/index";
import { useToastNotification } from "../../shared/design-system/ui/Toast";
import type { SettingsCards } from "../settings/service";
import type { OpenTarget } from "../navigation/targets";
import { communityFromScope } from "../relay/gifs";
import { useRelayConnection } from "../relay/react";
import type { Communities, Membership } from "./service";
import {
  CommunityDepartureError,
  deviceRemovalFailureText,
  leaveCleanupFailureText,
  leaveCommunity,
  leaveCommunityFailureText,
  leftCommunityText,
  removeCommunityFromDevice,
  removedFromDeviceText,
} from "./departure";
import { CommunityDialog } from "./CommunityDialog";
import type { InviteLink } from "./invite-link";
import { CommunityPickerItem, MEMBERSHIP_SECTION } from "./CommunityPickerItem";
import { communityDestination } from "./destination";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import {
  PopoverRoot,
  PopoverTrigger,
  PopoverPopup,
} from "../../shared/design-system/ui/Popover";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import styles from "./Communities.module.css";
import {
  communityName,
  communityDefaultName,
  communityActionLabel,
} from "./names";
import { useCommunityRole } from "./useCommunityRole";

const noSubscription = () => () => {};

/** Shell navigation only: selecting a community remains owned by Communities. */
export function CommunityPicker({
  communities,
  invite,
  onInviteClose,
  onSelect,
  onOpenTarget,
  settingsCards,
}: {
  communities: Communities;
  invite?: (InviteLink & { requestId: number }) | undefined;
  onInviteClose?: ((requestId: number) => void) | undefined;
  settingsCards?: Pick<SettingsCards, "subscribe" | "has"> | undefined;
  onSelect?: ((id: string | null) => void) | undefined;
  /** Menu destinations (Invites, hosting) open through the host's navigation. */
  onOpenTarget?: ((target: OpenTarget) => void) | undefined;
}) {
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [joining, setJoining] = useState(false);
  const navigated = useRef(false);
  const wasJoining = useRef(false);
  useEffect(() => {
    if (wasJoining.current && !joining) triggerRef.current?.focus();
    wasJoining.current = joining;
  }, [joining]);
  // The confirm dialog belongs to the picker so it outlives the item it removes.
  const [leaving, setLeaving] = useState<{
    membership: Membership;
    pending: false | "leave" | "remove";
    /** Why the relay did not take the leave; removal stays on offer. */
    error?: string;
  } | null>(null);
  // Each departure attempt; a relay wait abandoned for a local removal must
  // not report or navigate when it finally settles.
  const departure = useRef(0);
  const wasLeaving = useRef<Membership | null>(null);
  const notify = useToastNotification();
  const client = useSyncExternalStore(
    communities.subscribe,
    communities.snapshot,
  );
  useEffect(() => {
    // The picker closes before confirmation. Its surviving trigger owns
    // return focus whether the community was retained or removed.
    if (wasLeaving.current && !leaving) triggerRef.current?.focus();
    wasLeaving.current = leaving?.membership ?? null;
  }, [leaving]);
  // The compatibility reader follows selection, so this is only ever the
  // selected community's session; inactive communities stay unacquired.
  const connection = useRelayConnection(communities.relay);
  const selectedOrigin = client.selected
    ? communityDestination(client.selected).url
    : null;
  const session =
    connection.status === "ready" &&
    connection.scope &&
    communityFromScope(connection.scope) === selectedOrigin
      ? connection.session
      : undefined;
  // Roles come from the relay-signed roster, as the Membership card derives
  // them, verified against the authority the selected session already holds
  // rather than a second session contract request. Skip the read where no
  // item could use it.
  const membershipAvailable = useSyncExternalStore(
    settingsCards?.subscribe ?? noSubscription,
    // Registration is not authorization: the picker refreshes the role on menu
    // open even if Settings last cached a non-admin role.
    () => settingsCards?.has(MEMBERSHIP_SECTION) ?? false,
  );
  const hostedAvailable = useSyncExternalStore(
    settingsCards?.subscribe ?? noSubscription,
    () => settingsCards?.has("block.hosted-communities/hosted") ?? false,
  );
  const invites = !!onOpenTarget && membershipAvailable;
  const role = useCommunityRole(invites ? session : undefined, client.viewer);
  useEffect(() => communities.retainPresentation(), [communities]);
  const select = (id: string | null) => {
    setSwitcherOpen(false);
    if (onSelect) onSelect(id);
    else communities.select(id);
  };
  /** Publish first; the device forgets the community only once the relay has
   * released the membership, reports it never held one, or refuses the viewer
   * as banned. Anything else keeps the membership and the menu item for a
   * retry. */
  const leave = async () => {
    if (!leaving || leaving.pending) return;
    const { membership } = leaving;
    const attempt = ++departure.current;
    setLeaving({ membership, pending: "leave" });
    let result: Awaited<ReturnType<typeof leaveCommunity>>;
    try {
      result = await leaveCommunity(communities, membership);
    } catch (error) {
      if (attempt !== departure.current) return;
      // Once the relay accepts the leave, a device persistence failure has
      // different recovery copy from a request it never settled.
      const failure =
        error instanceof CommunityDepartureError ? error : undefined;
      if (failure?.phase === "device") {
        notify(
          leaveCleanupFailureText(
            communityActionLabel(membership),
            failure.reason,
            failure.outcome,
          ),
          "error",
        );
        setLeaving(null);
        return;
      }
      // A relay that never settled the leave may be gone for good. The dialog
      // stays open so the viewer can still forget it on this device.
      setLeaving({
        membership,
        pending: false,
        error: leaveCommunityFailureText(
          communityActionLabel(membership),
          failure?.reason ?? error,
        ),
      });
      return;
    }
    if (attempt !== departure.current) return;
    const { wasSelected, residue, outcome } = result;
    // The community is gone from this device whatever happens next, so only
    // the service call above may read as a cleanup failure.
    afterDeparture(membership, wasSelected);
    notify(
      leftCommunityText(
        communityActionLabel(membership),
        outcome,
        residue.length > 0,
      ),
      outcome === "left" ? "success" : "info",
    );
    setLeaving(null);
  };
  /** Forgets the community on this device only, without asking its relay, so a
   * dead or unreachable community can still be removed. The membership stays
   * on the relay. A leave still waiting on the relay is abandoned: its late
   * answer finds the community already gone and reports nothing. */
  const remove = async () => {
    if (!leaving || leaving.pending === "remove") return;
    const { membership } = leaving;
    const attempt = ++departure.current;
    setLeaving({ membership, pending: "remove" });
    let result: Awaited<ReturnType<typeof removeCommunityFromDevice>>;
    try {
      result = await removeCommunityFromDevice(communities, membership);
    } catch (error) {
      if (attempt !== departure.current) return;
      notify(
        deviceRemovalFailureText(
          communityActionLabel(membership),
          error instanceof CommunityDepartureError ? error.reason : error,
        ),
        "error",
      );
      setLeaving(null);
      return;
    }
    if (attempt !== departure.current) return;
    afterDeparture(membership, result.wasSelected);
    notify(
      removedFromDeviceText(
        communityActionLabel(membership),
        result.residue.length > 0,
      ),
      "success",
    );
    setLeaving(null);
  };
  const afterDeparture = (membership: Membership, wasSelected: boolean) => {
    if (wasSelected) {
      // The service already fell back to Personal space. Telling the host too
      // gives the leave the same navigation and ingress recovery as clicking
      // Personal space, instead of leaving a page scoped to a gone community.
      try {
        onSelect?.(null);
      } catch (error) {
        // A host that cannot navigate is the host's failure, not the device's.
        console.error(
          `Couldn't select Personal space after leaving ${communityName(membership)}`,
          error,
        );
      }
    }
  };
  const active = client.memberships.find(
    (membership) => membership.id === client.selected,
  );
  return (
    <>
      <nav aria-label="Communities" className={styles.picker}>
        <PopoverRoot
          open={switcherOpen}
          onOpenChange={(open) => {
            if (open) navigated.current = false;
            setSwitcherOpen(open);
          }}
        >
          <PopoverTrigger
            render={
              client.memberships.length === 0 ? (
                <Button
                  ref={triggerRef}
                  size="sm"
                  variant="subtle"
                  aria-label="Community switcher: Communities"
                >
                  Communities
                  <CaretDownIcon size={16} aria-hidden="true" />
                </Button>
              ) : (
                <IconButton
                  ref={triggerRef}
                  size="md"
                  variant="avatar"
                  shape="round"
                  aria-label={`Community switcher: ${active ? communityName(active) : "Personal space"}`}
                  title={active ? communityName(active) : "Personal space"}
                  icon={
                    active ? (
                      <Avatar
                        size="small"
                        shape="squircle"
                        alt=""
                        fallback={communityName(active)}
                        src={active.publishedIcon ?? active.icon}
                      />
                    ) : (
                      <GlobeIcon size={22} aria-hidden="true" />
                    )
                  }
                />
              )
            }
          />
          <PopoverPopup
            aria-label="Switch community"
            onKeyDown={(event) => {
              if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key))
                return;
              const rows = Array.from(
                event.currentTarget.querySelectorAll<HTMLButtonElement>(
                  "button:not([disabled])",
                ),
              );
              const index = rows.indexOf(
                document.activeElement as HTMLButtonElement,
              );
              event.preventDefault();
              const next =
                event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? rows.length - 1
                    : (index +
                        (event.key === "ArrowDown" ? 1 : -1) +
                        rows.length) %
                      rows.length;
              rows[next]?.focus();
            }}
            align="end"
            padding="list"
            finalFocus={() =>
              joining || leaving
                ? false
                : navigated.current
                  ? document.getElementById("main-content")
                  : triggerRef.current
            }
          >
            <NavigationItem
              label="Personal space"
              selected={client.selected === null}
              aria-current={client.selected === null ? "true" : undefined}
              icon={<GlobeIcon size={20} />}
              onClick={() => select(null)}
            />
            {client.memberships.map((membership) => {
              const selected = client.selected === membership.id;
              return (
                <CommunityPickerItem
                  key={membership.id}
                  membership={membership}
                  icon={membership.publishedIcon ?? membership.icon}
                  selected={selected}
                  viewer={client.viewer}
                  session={selected ? session : undefined}
                  manager={selected && invites && role.manager}
                  leaving={
                    leaving?.membership.id === membership.id &&
                    !!leaving.pending
                  }
                  onSelect={select}
                  onOpenTarget={
                    onOpenTarget
                      ? (target) => {
                          navigated.current = true;
                          setSwitcherOpen(false);
                          onOpenTarget(target);
                        }
                      : undefined
                  }
                  // Roles can change while the app runs; opening the selected
                  // community's menu re-reads the roster it gates on.
                  onMenuOpen={selected && invites ? role.refresh : undefined}
                  onLeave={(target) => {
                    setSwitcherOpen(false);
                    setLeaving({ membership: target, pending: false });
                  }}
                />
              );
            })}
            <NavigationItem
              label="Join a community"
              icon={<UsersPlusIcon size={20} />}
              onClick={() => {
                setSwitcherOpen(false);
                setJoining(true);
              }}
            />
            {onOpenTarget && hostedAvailable && (
              <NavigationItem
                label="Create community"
                icon={<PlusIcon size={20} />}
                onClick={() => {
                  navigated.current = true;
                  setSwitcherOpen(false);
                  onOpenTarget({
                    version: 1,
                    kind: "settings",
                    section: "block.hosted-communities/hosted",
                  });
                }}
              />
            )}
          </PopoverPopup>
        </PopoverRoot>
      </nav>
      {(joining || invite) && (
        <CommunityDialog
          key={invite ? invite.requestId : "manual"}
          communities={communities}
          mode="join"
          invite={invite}
          onJoined={(id) => select(id)}
          close={() => {
            setJoining(false);
            if (invite) onInviteClose?.(invite.requestId);
          }}
        />
      )}
      {leaving && (
        <AlertDialog
          title={`Leave ${communityDefaultName(leaving.membership)}?`}
          description={`This sends a leave request to the community’s relay, then removes ${communityDefaultName(leaving.membership)} from this device along with its saved drafts and reading positions. Rejoining may need a new invite. If the community can’t be reached, remove it from this device instead; your membership stays and you can add it again later.`}
          pending={!!leaving.pending}
          onClose={() => setLeaving(null)}
          // The picker's own effect places focus once the dialog is gone.
          finalFocus={false}
          actions={
            <>
              <Button
                disabled={!!leaving.pending}
                onClick={() => setLeaving(null)}
              >
                Cancel
              </Button>
              {/* Stays usable while a leave waits on a relay that may never
                  answer. */}
              <Button
                disabled={leaving.pending === "remove"}
                loading={leaving.pending === "remove"}
                onClick={() => void remove()}
              >
                Remove from this device
              </Button>
              <Button
                variant="destructive"
                disabled={leaving.pending === "remove"}
                loading={leaving.pending === "leave"}
                onClick={() => void leave()}
              >
                Leave community
              </Button>
            </>
          }
        >
          <div className="min-w-0 space-y-2 text-body-sm">
            {leaving.membership.localName &&
              leaving.membership.localName !==
                communityDefaultName(leaving.membership) && (
                <p className="text-muted">
                  Shown as {leaving.membership.localName} on this device
                </p>
              )}
            <p className="break-all">
              {communityDestination(leaving.membership.id).url}
            </p>
            {leaving.error && (
              <p role="alert" className="text-danger">
                {leaving.error}
              </p>
            )}
          </div>
        </AlertDialog>
      )}
    </>
  );
}
