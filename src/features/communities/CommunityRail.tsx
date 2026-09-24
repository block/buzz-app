import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { GlobeIcon, PlusIcon } from "../../shared/design-system/icons/index";
import type { Communities } from "./service";
import { CommunityDialog } from "./CommunityDialog";
import { Tooltip } from "../../shared/design-system/ui/Tooltip";
import styles from "./Communities.module.css";
import { fetchCommunityIcon } from "./community-icon";

/** Shell navigation only: selecting a community remains owned by Communities. */
export function CommunityRail({
  communities,
  onSelect,
}: {
  communities: Communities;
  onSelect?: ((id: string | null) => void) | undefined;
}) {
  const [joining, setJoining] = useState(false);
  const addRef = useRef<HTMLButtonElement>(null);
  const wasJoining = useRef(false);
  useEffect(() => {
    if (wasJoining.current && !joining) addRef.current?.focus();
    wasJoining.current = joining;
  }, [joining]);
  const client = useSyncExternalStore(
    communities.subscribe,
    communities.snapshot,
  );
  const [icons, setIcons] = useState<Record<string, string>>({});
  const membershipIds = client.memberships
    .map((membership) => membership.id)
    .join("\n");
  useEffect(() => {
    if (client.status !== "ready") return;
    const controller = new AbortController();
    // Icon discovery is optional. Reserve browser connections for foreground work
    // even when saved relays hold their NIP-11 responses indefinitely.
    const ids = membershipIds.split("\n").filter(Boolean);
    let next = 0;
    const workers = Array.from(
      { length: Math.min(2, ids.length) },
      async () => {
        while (next < ids.length && !controller.signal.aborted) {
          const id = ids[next++];
          if (id === undefined) break;
          try {
            const icon = await fetchCommunityIcon(id, controller.signal);
            if (icon !== undefined && !controller.signal.aborted)
              setIcons((previous) => ({ ...previous, [id]: icon }));
          } catch {
            // Unreachable relay: retain saved icon or initials.
          }
        }
      },
    );
    void Promise.all(workers);
    return () => controller.abort();
  }, [client.status, membershipIds]);
  const select = (id: string | null) => {
    if (onSelect) onSelect(id);
    else communities.select(id);
  };
  return (
    <>
      <nav aria-label="Communities" className={styles.rail}>
        <Tooltip content="Personal space" side="right">
          <IconButton
            aria-label="Personal space"
            aria-current={client.selected === null ? "true" : undefined}
            data-selected={client.selected === null || undefined}
            icon={<GlobeIcon size={22} aria-hidden="true" />}
            onClick={() => select(null)}
          />
        </Tooltip>
        {client.memberships.map((membership) => (
          <Tooltip content={membership.name} side="right" key={membership.id}>
            <IconButton
              aria-label={`Switch to ${membership.name}`}
              aria-current={
                client.selected === membership.id ? "true" : undefined
              }
              data-selected={client.selected === membership.id || undefined}
              icon={
                <Avatar
                  size="small"
                  shape="squircle"
                  alt=""
                  fallback={membership.name}
                  src={icons[membership.id] ?? membership.icon}
                />
              }
              onClick={() => select(membership.id)}
            />
          </Tooltip>
        ))}
        <Tooltip content="Add a community" side="right">
          <IconButton
            ref={addRef}
            aria-label="Add a community"
            icon={<PlusIcon size={22} aria-hidden="true" />}
            onClick={() => setJoining(true)}
          />
        </Tooltip>
      </nav>
      {joining && (
        <CommunityDialog
          communities={communities}
          mode="join"
          onJoined={(id) => select(id)}
          close={() => setJoining(false)}
        />
      )}
    </>
  );
}
