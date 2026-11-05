// Share an app you own with the Buzz communities you've joined, from the
// toolbar of the panel that shows it. The community you're in comes first.
import { useEffect, useState, useSyncExternalStore } from "react";
import { relayAddress } from "../../../features/communities/destination";
import type { RelayData } from "../../../features/relay/service";
import { ShareIcon } from "../../../shared/design-system/icons/index";
import { InlineHeader } from "../../../shared/design-system/ui/Header";
import { IconButton } from "../../../shared/design-system/ui/IconButton";
import {
  PopoverDescription,
  PopoverPopup,
  PopoverRoot,
  PopoverTitle,
  PopoverTrigger,
} from "../../../shared/design-system/ui/Popover";
import { SettingsGroup } from "../../../shared/design-system/ui/SettingsGroup";
import { SwitchPreferenceRow } from "../../../shared/design-system/ui/SwitchPreferenceRow";
import type { AppsClient } from "./client";
import type { JoinedCommunity } from "./communities";

export type ShareAppProps = {
  url: string;
  /** A fresh client per operation, as each one is bound to one sign-in. */
  apps(): Pick<AppsClient, "find" | "shared" | "community">;
  communities(): Promise<JoinedCommunity[]>;
  /** The community Buzz is showing comes first. */
  relay: Pick<RelayData, "subscribe" | "snapshot">;
};

type Loaded = { communities: JoinedCommunity[]; shared: string[] };
const failure = (error: unknown) =>
  error instanceof Error ? error.message : "Something went wrong.";
const sameCommunity = (a: string, b: string | undefined) => {
  try {
    return !!b && relayAddress(a) === relayAddress(b);
  } catch {
    return false;
  }
};

/** Nothing renders unless the signed-in account owns the app. */
export function ShareApp({ url, apps, communities, relay }: ShareAppProps) {
  const here = useSyncExternalStore(
    relay.subscribe,
    () => relay.snapshot().origin,
  );
  const [id, setId] = useState<string>();
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState<Loaded>();
  const [loadError, setLoadError] = useState("");
  const [pending, setPending] = useState<string>();
  const [rowError, setRowError] = useState<{ id: string; message: string }>();

  useEffect(() => {
    let current = true;
    setId(undefined);
    apps()
      .find(url)
      .then((found) => current && setId(found))
      // Not owned, signed out or unreachable: there is nothing to share here.
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [apps, url]);

  useEffect(() => {
    if (!open || !id) return;
    let current = true;
    setLoaded(undefined);
    setLoadError("");
    setRowError(undefined);
    Promise.all([communities(), apps().shared(id)])
      .then(
        ([joined, shared]) =>
          current && setLoaded({ communities: joined, shared }),
      )
      .catch((error: unknown) => current && setLoadError(failure(error)));
    return () => {
      current = false;
    };
  }, [open, id, apps, communities]);

  if (!id) return null;

  const toggle = async (community: JoinedCommunity, on: boolean) => {
    setPending(community.id);
    setRowError(undefined);
    try {
      const shared = await apps().community(
        id,
        community.id,
        on ? "grant" : "revoke",
      );
      // Compose omits the list once nothing is shared.
      const ids = shared.shared_community_ids;
      setLoaded(
        (value) =>
          value && {
            ...value,
            shared: Array.isArray(ids)
              ? ids.filter((value) => typeof value === "string")
              : [],
          },
      );
    } catch (error) {
      setRowError({ id: community.id, message: failure(error) });
    } finally {
      setPending(undefined);
    }
  };

  const row = (community: JoinedCommunity, label: string) => (
    <SwitchPreferenceRow
      key={community.id}
      label={label}
      {...(rowError?.id === community.id
        ? { description: rowError.message }
        : pending === community.id && { description: "Saving…" })}
      checked={loaded?.shared.includes(community.id) ?? false}
      disabled={pending !== undefined}
      onCheckedChange={(on) => void toggle(community, on)}
    />
  );
  const current = loaded?.communities.find((community) =>
    sameCommunity(community.address, here),
  );
  const others =
    loaded?.communities.filter((community) => community !== current) ?? [];

  return (
    <PopoverRoot open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <IconButton
            size="toolbar"
            variant="quiet"
            aria-label="Share"
            icon={<ShareIcon size={16} />}
          />
        }
      />
      <PopoverPopup side="bottom" align="end">
        <div className="grid gap-3">
          <div className="grid gap-1">
            <PopoverTitle>Share app</PopoverTitle>
            <PopoverDescription>
              {loadError ||
                (!loaded
                  ? "Loading your communities…"
                  : loaded.communities.length
                    ? "Members of the communities you turn on can open it."
                    : "You haven’t joined any communities you can share with.")}
            </PopoverDescription>
          </div>
          {loaded && (
            <>
              {current && (
                <SettingsGroup>
                  {row(current, `Share with ${current.name}`)}
                </SettingsGroup>
              )}
              {others.length > 0 && (
                <div className="grid gap-2">
                  {current && (
                    <InlineHeader level={4} title="Other communities" />
                  )}
                  <SettingsGroup>
                    {others.map((community) => row(community, community.name))}
                  </SettingsGroup>
                </div>
              )}
            </>
          )}
        </div>
      </PopoverPopup>
    </PopoverRoot>
  );
}
