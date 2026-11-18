import {
  useEffect,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  DEFAULT_DECISION_PROVIDER,
  DEFAULT_DECISION_PROVIDERS,
  statusOf,
  type DecisionProvider,
  type DecisionProviderStatus,
  type DecisionsService,
  type RegisteredProvider,
} from "../features/decisions/service";
import { SettingsSectionLink } from "../features/navigation/SettingsSectionLink";
import { OwnedContribution } from "../plugins/OwnedContribution";
import typesafeMark from "../shared/assets/typesafe-mark.png";
import { BuilderlabLogoIcon } from "../shared/design-system/icons";
import { Header, InlineHeader } from "../shared/design-system/ui/Header";
import { SettingsGroup } from "../shared/design-system/ui/SettingsGroup";
import { Select } from "../shared/design-system/ui/Select";
import { PreferenceRow } from "../shared/design-system/ui/PreferenceRow";
import { Avatar } from "../shared/design-system/ui/Avatar";
import type { Membership } from "../features/communities/service";
import { communityDestination } from "../features/communities/destination";
import { communityIcon } from "../features/communities/community-icon";
import { communityName } from "../features/communities/names";

const BUILDERLAB = DEFAULT_DECISION_PROVIDERS[0];

type Status = DecisionProviderStatus | "unavailable";
/** One community's row, as Settings shows it. */
type CommunityState = Readonly<{
  /** The provider in its menu: the user's choice while it is on, else the
   * one that answers. "" when neither is on. */
  shown: string;
  /** The provider that answers now, which differs from `shown` while a
   * chosen default is not set up. */
  answering: string;
  status: Status;
  /** Provider key -> whether it can be chosen here. */
  offered: Readonly<Record<string, boolean>>;
  /** Provider key -> its setup scope here. */
  scope: Readonly<Record<string, string>>;
}>;

const offeredIn = (provider: DecisionProvider, community: string) => {
  try {
    return provider.offered?.(community) ?? true;
  } catch {
    return false;
  }
};
const scopeIn = (provider: DecisionProvider, community: string) => {
  try {
    return provider.setupScope?.(community) ?? "";
  } catch {
    return "";
  }
};

/** Chooses, for each joined community, the provider that answers its
 * decisions, and sets that provider up there: a Builderlab sign-in for the
 * community's sign-in server, which communities on one server share, or the
 * TypeSafe key, which every community shares. Providers are plugins. Each
 * community's menu offers the providers that can be set up there; the
 * service routes a community whose choice is not set up yet to TypeSafe.
 * With no communities, it lists each provider's settings. */
export function DecisionsSettings({
  decisions,
  active,
  onSection,
  memberships = [],
}: {
  decisions: Pick<
    DecisionsService,
    "backend" | "status" | "subscribe" | "setBackend" | "providers" | "chosenIn"
  >;
  active(): boolean;
  onSection?: ((section: string) => void) | undefined;
  memberships?: readonly Membership[] | undefined;
}) {
  const providers = useSyncExternalStore(
    decisions.subscribe,
    decisions.providers,
    decisions.providers,
  );
  const communities = memberships.flatMap((membership) => {
    try {
      return [
        {
          membership,
          name: communityName(membership),
          url: communityDestination(membership.id).url,
        },
      ];
    } catch {
      return [];
    }
  });
  // One string, so the external store compares states, not new arrays.
  // Re-read on every change: a provider's status is its own.
  const state = JSON.parse(
    useSyncExternalStore(
      decisions.subscribe,
      () => {
        const registered = decisions.providers();
        return JSON.stringify({
          providers: registered.map((provider) => statusOf(provider)),
          communities: communities.map(({ url }): CommunityState => {
            const chosen = decisions.chosenIn(url);
            const answering = decisions.backend(url) ?? "";
            return {
              shown: registered.some((provider) => provider.key === chosen)
                ? (chosen as string)
                : answering,
              answering,
              status: decisions.status(url),
              offered: Object.fromEntries(
                registered.map((provider) => [
                  provider.key,
                  offeredIn(provider, url),
                ]),
              ),
              scope: Object.fromEntries(
                registered.map((provider) => [
                  provider.key,
                  scopeIn(provider, url),
                ]),
              ),
            };
          }),
        });
      },
      () => JSON.stringify({ providers: [], communities: [] }),
    ),
  ) as { providers: DecisionProviderStatus[]; communities: CommunityState[] };
  const label = (key: string) =>
    providers.find((provider) => provider.key === key)?.label ?? key;
  const choose = (key: string, community: string) => {
    if (active()) decisions.setBackend(key, community);
  };
  /** What a community's row says under its name, if anything. */
  const note = (row: CommunityState) => {
    if (!row.shown) return "No provider can answer here";
    if (row.answering && row.answering !== row.shown)
      return `${label(row.shown)} can’t answer here yet, so ${label(row.answering)} answers`;
    if (!row.answering) return "No provider can answer here";
    if (row.status === "checking") return "Checking…";
    if (row.status === "needs-setup")
      return `Set up ${label(row.answering)} to use decisions here`;
    return undefined;
  };
  /** The other communities that share `index`'s setup of its provider. */
  const sharing = (index: number) => {
    const row = state.communities[index];
    if (!row?.shown) return [];
    return communities.filter((_, other) => {
      const each = state.communities[other];
      return (
        other !== index &&
        each?.shown === row.shown &&
        each.scope[row.shown] === row.scope[row.shown]
      );
    });
  };
  const settingsOf = (
    provider: RegisteredProvider,
    community: string | undefined,
  ) =>
    provider.Settings && (
      // A provider's settings are plugin code: if they fail, only this part
      // does, and Manage plugins can turn it off.
      <OwnedContribution
        entry={provider}
        registry={{ snapshot: decisions.providers }}
        fallback={
          <p role="alert" className="m-0 py-4 text-body-sm text-secondary">
            {provider.label} settings are unavailable. You can turn its plugin
            off in{" "}
            <SettingsSectionLink section="plugins" open={onSection}>
              Manage plugins
            </SettingsSectionLink>
            .
          </p>
        }
      >
        {(entry, owned) => {
          const Settings = entry.Settings;
          return (
            Settings && (
              <div className="grid gap-4 py-4">
                <Settings
                  active={() => active() && owned()}
                  grouped={false}
                  {...(community === undefined ? {} : { community })}
                />
              </div>
            )
          );
        }}
      </OwnedContribution>
    );
  // A provider can go away while its controls have focus, for example when
  // a sign-out removes Builderlab. The service notifies before React
  // re-renders, so the old controls are still in the page: note whether
  // focus is in this section, then hand it to the section itself if the
  // update dropped it.
  const section = useRef<HTMLElement>(null);
  const hadFocus = useRef(false);
  useEffect(
    () =>
      decisions.subscribe(() => {
        hadFocus.current ||= !!section.current?.contains(
          document.activeElement,
        );
      }),
    [decisions],
  );
  useLayoutEffect(() => {
    if (!hadFocus.current) return;
    hadFocus.current = false;
    const element = section.current;
    const focused = document.activeElement;
    if (
      !element ||
      (focused && focused !== document.body && focused.isConnected)
    )
      return;
    element.focus({ preventScroll: true });
  });
  return (
    <section
      ref={section}
      tabIndex={-1}
      aria-labelledby="decisions-settings-title"
    >
      <Header
        id="decisions-settings-title"
        title="Decisions API"
        subtitle={
          <>
            <strong>Agents</strong>, <strong>plugins</strong> and features like{" "}
            <strong>Attention</strong> can use this API for quick, inexpensive
            judgments, such as whether a watched event should wake your agent.
            The provider you choose for a community handles its questions and
            receives the message text sent with them, which may come from
            private channels.
          </>
        }
      />
      {providers.length === 0 ? (
        <p role="status" className="mt-4 text-body-sm text-secondary">
          No decision provider is turned on. Turn one on in{" "}
          <SettingsSectionLink section="plugins" open={onSection}>
            Manage plugins
          </SettingsSectionLink>
          .
        </p>
      ) : communities.length === 0 ? (
        <div
          data-buzz-ui=""
          className="mt-section-gap flex w-full flex-col gap-4"
        >
          {providers.map((provider, index) => {
            const status = state.providers[index];
            return (
              <SettingsGroup key={provider.key}>
                <PreferenceRow
                  icon={providerMark(provider.key, 24)}
                  title={provider.label}
                  subtitle={
                    <span role="status">
                      {status === "ready" || status === "unconfirmed"
                        ? "Ready"
                        : status === "checking"
                          ? "Checking…"
                          : "Not set up"}
                    </span>
                  }
                />
                {settingsOf(provider, undefined)}
              </SettingsGroup>
            );
          })}
        </div>
      ) : (
        <div
          data-buzz-ui=""
          className="mt-section-gap flex w-full flex-col gap-4"
        >
          <InlineHeader
            title="Communities"
            subtitle="Choose which provider answers each community’s decisions, and set it up there."
          />
          {communities.map(({ membership, name, url }, index) => {
            const row = state.communities[index];
            const current = providers.find(
              (provider) => provider.key === row?.shown,
            );
            const shared = sharing(index);
            const subtitle = row && note(row);
            return (
              <SettingsGroup key={url}>
                <PreferenceRow
                  icon={
                    <Avatar
                      src={communityIcon(
                        membership.publishedIcon ?? membership.icon,
                      )}
                      alt=""
                      fallback={name}
                      shape="squircle"
                      size="small"
                    />
                  }
                  title={name}
                  subtitle={subtitle && <span role="status">{subtitle}</span>}
                  trailing={({ "aria-describedby": describedBy }) => (
                    <Select
                      label={`Decision provider for ${name}`}
                      variant="compact"
                      describedBy={describedBy}
                      leading={current && providerMark(current.key, 20)}
                      value={row?.shown ?? ""}
                      disabled={!active()}
                      onValueChange={(key) => choose(key, url)}
                      groups={[
                        {
                          label: "Providers",
                          options: providers.map((provider) => {
                            const offered = row?.offered[provider.key] ?? false;
                            return {
                              value: provider.key,
                              label: provider.label,
                              leading: providerMark(provider.key, 20),
                              disabled: !offered && provider.key !== row?.shown,
                              description: offered
                                ? undefined
                                : "Not offered in this community",
                            };
                          }),
                        },
                      ]}
                    />
                  )}
                />
                {current && settingsOf(current, url)}
                {current && shared.length > 0 && (
                  <p className="m-0 pb-4 text-body-sm text-secondary">
                    {current.key === BUILDERLAB
                      ? "Same Builderlab account as "
                      : `Same ${current.label} setup as `}
                    {shared.map((each) => each.name).join(", ")}.
                  </p>
                )}
              </SettingsGroup>
            );
          })}
        </div>
      )}
    </section>
  );
}

/** The bundled providers' marks; other providers have none. */
function providerMark(key: string, size: number): ReactNode {
  if (key === BUILDERLAB)
    return <BuilderlabLogoIcon size={size} aria-hidden="true" />;
  if (key === DEFAULT_DECISION_PROVIDER)
    return (
      <span
        aria-hidden="true"
        style={{
          width: size,
          height: size,
          display: "inline-block",
          backgroundColor: "currentColor",
          maskImage: `url(${typesafeMark})`,
          maskSize: "contain",
          maskPosition: "center",
          maskRepeat: "no-repeat",
        }}
      />
    );
  return undefined;
}
