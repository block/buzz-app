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

/** Sets up decision providers and chooses, for each joined community, the
 * provider that answers its decisions. Providers are plugins. Each one's
 * settings and the communities where it can answer are shown once, under
 * Providers. Each community's menu offers the providers that can answer
 * there; the service routes a community without a working choice to the
 * defaults. */
export function DecisionsSettings({
  decisions,
  active,
  onSection,
  memberships = [],
}: {
  decisions: Pick<
    DecisionsService,
    "backend" | "status" | "subscribe" | "setBackend" | "providers"
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
      () =>
        JSON.stringify({
          available: decisions
            .providers()
            .map((provider) =>
              communities.length === 0
                ? [statusOf(provider)]
                : communities.map(({ url }) => statusOf(provider, url)),
            ),
          answering: communities.map(({ url }) => [
            decisions.backend(url) ?? "",
            decisions.status(url),
          ]),
        }),
      () => JSON.stringify({ available: [], answering: [] }),
    ),
  ) as {
    available: DecisionProviderStatus[][];
    answering: [string, DecisionProviderStatus | "unavailable"][];
  };
  const answers = (status: DecisionProviderStatus | undefined) =>
    status === "ready" || status === "unconfirmed";
  const availability = (provider: RegisteredProvider, index: number) => {
    const statuses = state.available[index] ?? [];
    if (communities.length === 0)
      return answers(statuses[0])
        ? "Ready"
        : statuses[0] === "checking"
          ? "Checking…"
          : "Not set up";
    const where = communities.filter((_, each) => answers(statuses[each]));
    if (where.length === communities.length)
      return "Available in all your communities";
    if (where.length > 0)
      return `Available in ${where.map(({ name }) => name).join(", ")}`;
    if (statuses.includes("checking")) return "Checking…";
    return provider.key === BUILDERLAB
      ? "None of your communities offer Builderlab decisions to this account. For access, contact your account administrator."
      : "Not set up";
  };
  const choose = (key: string, community: string) => {
    if (active()) decisions.setBackend(key, community);
  };
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
      ) : (
        <div
          data-buzz-ui=""
          className="mt-section-gap flex flex-col items-start gap-section-gap"
        >
          <div className="w-full">
            <InlineHeader
              title="Providers"
              subtitle="Set up each provider here, then choose one for each community below."
            />
            <div className="flex flex-col gap-4">
              {providers.map((provider, index) => (
                <SettingsGroup key={provider.key}>
                  <PreferenceRow
                    icon={providerMark(provider.key, 24)}
                    title={provider.label}
                    subtitle={
                      <span role="status">{availability(provider, index)}</span>
                    }
                  />
                  {provider.Settings && (
                    // A provider's settings are plugin code: if they fail,
                    // only this part does, and Manage plugins can turn it off.
                    <OwnedContribution
                      entry={provider}
                      registry={{ snapshot: decisions.providers }}
                      fallback={
                        <p
                          role="alert"
                          className="m-0 py-4 text-body-sm text-secondary"
                        >
                          {provider.label} settings are unavailable. You can
                          turn its plugin off in{" "}
                          <SettingsSectionLink
                            section="plugins"
                            open={onSection}
                          >
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
                              />
                            </div>
                          )
                        );
                      }}
                    </OwnedContribution>
                  )}
                </SettingsGroup>
              ))}
            </div>
          </div>
          {communities.length > 0 && (
            <div className="w-full">
              <InlineHeader
                title="Communities"
                subtitle="Choose which provider answers each community’s decisions."
              />
              <SettingsGroup>
                {communities.map(({ membership, name, url }, row) => {
                  const [backend = "", status = "unavailable"] =
                    state.answering[row] ?? [];
                  const current = providers.find(
                    (provider) => provider.key === backend,
                  );
                  return (
                    <PreferenceRow
                      key={url}
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
                      subtitle={
                        !current
                          ? "No provider can answer here"
                          : status === "needs-setup"
                            ? `Set up ${current.label} above to use decisions here`
                            : status === "checking"
                              ? "Checking…"
                              : undefined
                      }
                      trailing={({ "aria-describedby": describedBy }) => (
                        <Select
                          label={`Decision provider for ${name}`}
                          variant="compact"
                          describedBy={describedBy}
                          leading={current && providerMark(current.key, 20)}
                          value={backend}
                          disabled={!active()}
                          onValueChange={(key) => choose(key, url)}
                          groups={[
                            {
                              label: "Providers",
                              options: providers.map((provider, index) => {
                                const offered =
                                  answers(state.available[index]?.[row]) ||
                                  state.available[index]?.[row] === "checking";
                                return {
                                  value: provider.key,
                                  label: provider.label,
                                  leading: providerMark(provider.key, 20),
                                  disabled:
                                    !offered && provider.key !== backend,
                                  description: offered
                                    ? undefined
                                    : provider.key === BUILDERLAB
                                      ? "Not offered in this community"
                                      : "Set it up above",
                                };
                              }),
                            },
                          ]}
                        />
                      )}
                    />
                  );
                })}
              </SettingsGroup>
            </div>
          )}
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
