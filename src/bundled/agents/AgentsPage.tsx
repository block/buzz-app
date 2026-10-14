import { AgentDetails } from "./AgentDetails";
import { PanelWorkspace } from "../../features/panels/PanelWorkspace";
import { AgentMessageButton } from "./AgentMessageButton";
import { ProviderDialog } from "./ProviderDialog";
// Agents and teams, with creation, import and marketplace entry from New agent.
import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import styles from "./AgentsPage.module.css";
import cardStyles from "./AgentCard.module.css";
import { AgentBrowse } from "./AgentBrowse";
import { AgentCard, AgentPortrait } from "./AgentCard";
import { AgentCreateDialog, TypeIcon } from "./AgentCreateDialog";
import { NewAgentTile } from "./NewAgentTile";
import type { ChannelChoice } from "../../features/agents/attention";
import { AgentDelete } from "../../features/agents/AgentManage";
import { AttentionSummary } from "../../features/agents/AttentionPanel";
import { useAgents, useChannelChoices } from "../../features/agents/react";
import type {
  PortableAgent,
  PortableAgents,
  PortSource,
} from "../../features/agents/native";
import type {
  Agent,
  Agents,
  RegisteredAgentType,
  Team,
} from "../../features/agents/service";
import { useRelayConnection } from "../../features/relay/react";
import type { RelayData } from "../../features/relay/service";
import type { Navigation } from "../../features/navigation/controller";
import type { PageNavigation } from "../../features/navigation/service";
import { ContributionBoundary } from "../../features/conversation/ContributionBoundary";
import {
  CircleNotchIcon,
  DotsThreeIcon,
  DownloadIcon,
  StorefrontIcon,
  PlusIcon,
  RobotIcon,
  XIcon,
} from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { Checkbox } from "../../shared/design-system/ui/Checkbox";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { EmptyState } from "../../shared/design-system/ui/EmptyState";
import { Field } from "../../shared/design-system/ui/Field";
import { Panel } from "../../shared/design-system/ui/Panel";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { Input } from "../../shared/design-system/ui/Input";
import {
  MenuPopup,
  MenuIcon,
  MenuItem,
  MenuRoot,
  MenuSubmenu,
  MenuSubmenuPopup,
  MenuSubmenuTrigger,
  MenuTrigger,
} from "../../shared/design-system/ui/Menu";
import { PanelHeader } from "../../shared/design-system/ui/PanelHeader";
import { Select } from "../../shared/design-system/ui/Select";
import { Tabs } from "../../shared/design-system/ui/Tabs";
import { Textarea } from "../../shared/design-system/ui/Textarea";
import { Tooltip } from "../../shared/design-system/ui/Tooltip";
import {
  canonicalPublicKey,
  publicKeyLabels,
} from "../../shared/identity/public-key";
import { agentProviderRoute, agentProviderTarget } from "./routes";

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** The type's one-line summary of an agent; its title when it has none. */
function summaryOf(agent: Agent, type: RegisteredAgentType | undefined) {
  if (agent.place === "elsewhere") return "On another device";
  if (agent.unfinished) return "Setup unfinished";
  if (!type) return "Type unavailable";
  try {
    return type.summary?.(agent).trim() || type.title;
  } catch {
    return type.title;
  }
}

type Tab = "yours" | "teams";
const TABS = [
  { value: "yours", label: "Your agents", panelId: "agents-yours" },
  { value: "teams", label: "Your teams", panelId: "agents-teams" },
] as const;

export function AgentsPage({
  agents,
  relay,
  navigation,
  navigator,
}: {
  agents: Agents;
  relay: RelayData;
  navigation?: PageNavigation;
  navigator?: Navigation;
}) {
  const { snapshot, types } = useAgents(agents);
  const connection = useRelayConnection(relay);
  const channels = useChannelChoices(
    connection.status === "ready" ? connection.session.channels : undefined,
  );
  const [tab, setTab] = useState<Tab>("yours");
  const [selectedKey, setSelectedKey] = useState<string>();
  const [creating, setCreating] = useState(false);
  const [flow, setFlow] = useState<"import" | "browse">();
  const newAgentButton = useRef<HTMLButtonElement>(null);
  const newAgentLabel = useRef<HTMLSpanElement>(null);
  const [importing, setImporting] = useState(false);
  const [localProviderKey, setLocalProviderKey] = useState<string>();
  const routed = !!navigation && !!navigator;
  const providerKey = routed
    ? agentProviderRoute(
        navigation.target.kind === "page"
          ? navigation.target.route?.params
          : undefined,
      )
    : localProviderKey;
  const setProviderKey = (provider?: string, replace = false) => {
    if (!navigation || !navigator) {
      setLocalProviderKey(provider);
      return;
    }
    if (
      navigation.signal.aborted ||
      navigation.target.kind !== "page" ||
      navigation.target.pluginId !== "buzz.agents" ||
      navigation.target.pageId !== "agents" ||
      navigator.snapshot().entry.id !== navigation.entryId
    )
      return;
    const target = agentProviderTarget(navigation.target, provider);
    void (replace
      ? navigator.open(target, { replace: true })
      : navigator.open(target));
  };
  const typeOf = (agent: Agent) =>
    types.find((type) => type.key === agent.type);
  const find = (pubkey: string | undefined) =>
    snapshot.agents.find((agent) => agent.pubkey === pubkey);
  const selected = find(selectedKey);
  const browse = (pubkey?: string) => setSelectedKey(pubkey);
  const build = (pubkey: string) => browse(pubkey);
  // Importing gives an agent a key here, so a hosted type cannot take one.
  const runnable = types.filter((type) => !type.remote);
  const returnToAgents = () => {
    setFlow(undefined);
    setTab("yours");
  };

  const toolbarAction =
    snapshot.agents.length > 0 ||
    tab === "teams" ||
    snapshot.status === "error" ||
    snapshot.status === "unavailable";
  const newAgentMenu = (
    <MenuRoot>
      <MenuTrigger
        render={
          toolbarAction ? (
            <NewAgentTile ref={newAgentButton} variant="button" />
          ) : (
            <NewAgentTile
              ref={newAgentButton}
              labelRef={newAgentLabel}
              fullWidth
            />
          )
        }
      />
      <MenuPopup
        anchor={toolbarAction ? newAgentButton : newAgentLabel}
        align={toolbarAction ? "end" : "center"}
      >
        <MenuItem
          disabled={snapshot.status !== "ready" || !types.length}
          onClick={() => setCreating(true)}
        >
          <PlusIcon size={16} aria-hidden="true" /> Create a new agent
        </MenuItem>
        <MenuItem
          onClick={() => {
            browse();
            setFlow("import");
          }}
        >
          <DownloadIcon size={16} aria-hidden="true" /> Import an agent
        </MenuItem>
        <MenuItem
          onClick={() => {
            browse();
            setFlow("browse");
          }}
        >
          <StorefrontIcon size={16} aria-hidden="true" /> Browse the marketplace
        </MenuItem>
      </MenuPopup>
    </MenuRoot>
  );
  const openTeams = () => setTab("teams");
  const more = useRef<HTMLButtonElement>(null);

  const yours = (() => {
    if (snapshot.status === "unavailable")
      return (
        <EmptyState
          icon="✦"
          title="Agents runs in the desktop app"
          description="Agent keys stay in the desktop app's native custody."
        />
      );
    if (snapshot.status === "error")
      return (
        <EmptyState
          icon="!"
          title="Agents could not load"
          description={snapshot.error ?? "Try again."}
        />
      );
    return (
      <Inventory
        service={agents}
        agents={snapshot.agents}
        selected={selected?.pubkey}
        typeOf={typeOf}
        onSelect={browse}
        onBuild={build}
        newAgent={!toolbarAction && newAgentMenu}
      />
    );
  })();

  const panel =
    tab !== "yours" ? undefined : selected ? (
      selected.unfinished || selected.place === "elsewhere" ? (
        <AgentPeek
          key={selected.pubkey}
          agents={agents}
          agent={selected}
          type={typeOf(selected)}
          channels={channels}
          onClose={() => browse()}
        />
      ) : (
        <AgentDetails
          messageAction={
            <AgentMessageButton
              pubkey={selected.pubkey}
              relay={relay}
              navigator={navigator}
              navigation={navigation}
            />
          }
          key={selected.pubkey}
          agents={agents}
          agent={selected}
          type={typeOf(selected)}
          types={types}
          channels={channels}
          memories={
            connection.status === "ready"
              ? connection.session.agentMemories
              : undefined
          }
          onRemoved={() => browse()}
        />
      )
    ) : undefined;
  const body = (
    <div className={styles.inventory}>
      <div className={styles.content}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Tabs
            variant="panel"
            label="Agent tabs"
            value={tab}
            onValueChange={setTab}
            items={TABS}
          />
          {toolbarAction && newAgentMenu}
        </div>
        <section
          id={`agents-${tab}`}
          role="tabpanel"
          aria-labelledby={`agents-${tab}-tab`}
        >
          {tab === "yours" ? (
            yours
          ) : (
            <Teams
              agents={agents}
              saved={snapshot.agents.filter((agent) => agent.place === "here")}
              teams={snapshot.teams}
            />
          )}
        </section>
      </div>
    </div>
  );

  return (
    <div className="h-full min-h-0">
      <div className={styles.browse} data-side={panel ? "" : undefined}>
        <div className={styles.main}>
          <Panel aria-label="Agents">
            <div className="flex h-full min-h-0 flex-col">
              <PanelHeader
                title={
                  <Tabs
                    variant="navigation"
                    label="Agents header"
                    value="agents"
                    onValueChange={() => {}}
                    showSelection={false}
                    items={[
                      {
                        value: "agents",
                        label: "Agents",
                        icon: <RobotIcon size="1rem" />,
                      },
                    ]}
                  />
                }
                actions={
                  snapshot.status === "ready" ? (
                    <MenuRoot>
                      <MenuTrigger
                        render={
                          <IconButton
                            ref={more}
                            aria-label="More agent actions"
                            title="More agent actions"
                            size="sm"
                            icon={
                              <DotsThreeIcon size={16} aria-hidden="true" />
                            }
                          />
                        }
                      />
                      <MenuPopup align="end">
                        <ProviderSubmenu
                          types={types}
                          onSelect={setProviderKey}
                        />
                        <MenuItem
                          onClick={openTeams}
                          disabled={tab === "teams"}
                        >
                          Teams
                        </MenuItem>
                      </MenuPopup>
                    </MenuRoot>
                  ) : undefined
                }
              />
              <div className="min-h-0 flex-1">{body}</div>
            </div>
          </Panel>
        </div>
        {panel && selected && (
          <aside className={styles.side}>
            <Panel aria-label="Agent profile">
              <PanelWorkspace
                focusOnMount={false}
                adoptSelection={selected.pubkey}
                value={selected.pubkey}
                select={() => {}}
                items={[
                  {
                    id: selected.pubkey,
                    label: selected.name,
                    content: panel,
                    close: () => browse(),
                  },
                ]}
              />
            </Panel>
          </aside>
        )}
      </div>
      {flow && (
        <Dialog
          open
          title={flow === "import" ? "Import an agent" : "Marketplace"}
          size="wide"
          height="stable"
          preventClose={importing}
          finalFocus={newAgentButton}
          onOpenChange={(open) => {
            if (!open) setFlow(undefined);
          }}
        >
          {flow === "import" ? (
            <ImportAgents
              agents={agents}
              types={runnable}
              onImported={returnToAgents}
              onPendingChange={setImporting}
            />
          ) : (
            <AgentBrowse
              relay={relay}
              agents={agents}
              types={runnable}
              onImported={returnToAgents}
            />
          )}
        </Dialog>
      )}
      {creating && (
        <AgentCreateDialog
          agents={agents}
          types={types}
          community={
            connection.status === "ready" ? connection.origin : undefined
          }
          onClose={() => setCreating(false)}
          onCreated={(agent) => {
            setCreating(false);
            setTab("yours");
            build(agent.pubkey);
          }}
        />
      )}
      {providerKey && (
        <ProviderDialog
          type={types.find((type) => type.key === providerKey)}
          finalFocus={more}
          onClose={() => setProviderKey(undefined, true)}
        />
      )}
    </div>
  );
}

/** A quick device-wide health view. Controls stay in each provider's dialog. */
function ProviderSubmenu({
  types,
  onSelect,
}: {
  types: readonly RegisteredAgentType[];
  onSelect(key: string): void;
}) {
  const check = () => {
    for (const { provider } of types) if (provider) checkProvider(provider);
  };
  return (
    <MenuSubmenu>
      <MenuSubmenuTrigger onFocus={check} onPointerEnter={check}>
        Provider settings
      </MenuSubmenuTrigger>
      <MenuSubmenuPopup aria-label="Provider settings">
        {types.map((type) => {
          const fallback = (
            <MenuItem aria-label={`${type.title}, unavailable`} disabled>
              <ProviderIcon type={type} />
              {type.title}
            </MenuItem>
          );
          return (
            <ContributionBoundary key={type.key} fallback={fallback}>
              <ProviderMenuItem
                type={type}
                onSelect={() => onSelect(type.key)}
              />
            </ContributionBoundary>
          );
        })}
      </MenuSubmenuPopup>
    </MenuSubmenu>
  );
}

function checkProvider(provider: NonNullable<RegisteredAgentType["provider"]>) {
  try {
    void Promise.resolve(provider.check()).catch(() => {});
  } catch {
    // A failed contribution does not break host-owned provider controls.
  }
}

function ProviderIcon({ type }: { type: RegisteredAgentType }) {
  const Icon = type.icon;
  return Icon ? (
    <MenuIcon>
      <Icon size={17} />
    </MenuIcon>
  ) : null;
}

function ProviderMenuItem({
  type,
  onSelect,
}: {
  type: RegisteredAgentType;
  onSelect(): void;
}) {
  const provider = type.provider;
  if (!provider)
    return (
      <MenuItem aria-label={`${type.title}, unavailable`} disabled>
        <ProviderIcon type={type} />
        {type.title}
      </MenuItem>
    );
  return (
    <ProviderHealthMenuItem
      type={type}
      provider={provider}
      onSelect={onSelect}
    />
  );
}

function ProviderHealthMenuItem({
  type,
  provider,
  onSelect,
}: {
  type: RegisteredAgentType;
  provider: NonNullable<RegisteredAgentType["provider"]>;
  onSelect(): void;
}) {
  const state = useSyncExternalStore(
    provider.subscribe,
    provider.snapshot,
    provider.snapshot,
  );
  const checking = state.readiness === "checking";
  const label =
    state.readiness === "attention"
      ? (state.attentionLabel ?? `Set up ${type.title}`)
      : type.title;
  const select = () => {
    if (state.readiness === "attention") {
      const action = provider.attentionAction;
      if (action)
        try {
          action();
          return;
        } catch {
          // Fall back to the provider's recovery guidance.
        }
    }
    onSelect();
  };
  return (
    <MenuItem
      aria-label={`${label}, ${state.readiness}`}
      aria-busy={checking || undefined}
      onClick={select}
      disabled={checking}
    >
      {checking ? (
        <MenuIcon>
          <CircleNotchIcon
            size={17}
            aria-hidden="true"
            className="motion-safe:animate-spin"
          />
        </MenuIcon>
      ) : (
        <ProviderIcon type={type} />
      )}
      {label}
    </MenuItem>
  );
}

/** Cards retain arrow navigation; their embedded controls have their own tab stops. The
 * New agent tile leads the grid but is its own stop. */
function Inventory({
  service,
  agents,
  selected,
  typeOf,
  onSelect,
  onBuild,
  newAgent,
}: {
  service: Agents;
  agents: readonly Agent[];
  selected: string | undefined;
  typeOf(agent: Agent): RegisteredAgentType | undefined;
  onSelect(pubkey?: string): void;
  onBuild(pubkey: string): void;
  newAgent: ReactNode;
}) {
  const grid = useRef<HTMLDivElement>(null);
  const index = agents.findIndex((agent) => agent.pubkey === selected);
  const columns = () =>
    grid.current
      ? getComputedStyle(grid.current).gridTemplateColumns.split(" ").length
      : 1;
  const onKeyDown = (event: KeyboardEvent) => {
    if (
      !(event.target instanceof HTMLElement) ||
      event.target.getAttribute("role") !== "gridcell"
    )
      return;
    const last = agents.length - 1;
    const from = index < 0 ? -1 : index;
    const step: Record<string, number> = {
      ArrowRight: 1,
      ArrowLeft: -1,
      ArrowDown: columns(),
      ArrowUp: -columns(),
    };
    let next: number | undefined;
    if (event.key in step) {
      const delta = step[event.key] ?? 0;
      next = from < 0 ? 0 : from + delta;
      if (next < 0 || next > last)
        next = Math.abs(delta) === 1 ? Math.min(Math.max(next, 0), last) : from;
    } else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = last;
    else if (event.key === "Enter" && selected) {
      event.preventDefault();
      onBuild(selected);
      return;
    } else if (event.key === "Escape" && selected) {
      event.preventDefault();
      onSelect();
      return;
    }
    if (next === undefined) return;
    event.preventDefault();
    onSelect(agents[next]?.pubkey);
    grid.current
      ?.querySelectorAll<HTMLElement>('[role="gridcell"]')
      [next]?.focus();
  };
  return (
    <div ref={grid} className={cardStyles.grid}>
      {newAgent}
      {agents.length > 0 && (
        // biome-ignore lint/a11y/useSemanticElements: This is a wrapping layout grid of interactive cards, not tabular data.
        <div
          role="grid"
          aria-label="Agents"
          className="contents"
          onKeyDown={onKeyDown}
        >
          {agents.map((agent, position) => {
            const type = typeOf(agent);
            const active = agent.pubkey === selected;
            return (
              // biome-ignore lint/a11y/useSemanticElements: Layout grid rows group cards without table layout.
              // biome-ignore lint/a11y/useFocusableInteractive: Roving focus belongs to the gridcell, not its row wrapper.
              <div role="row" className="contents" key={agent.pubkey}>
                <InventoryCard
                  service={service}
                  type={type}
                  onBuild={() => onBuild(agent.pubkey)}
                  onRemoved={() => onSelect()}
                  role="gridcell"
                  aria-label={agent.name}
                  data-selected={active}
                  aria-selected={active}
                  tabIndex={active || (index < 0 && position === 0) ? 0 : -1}
                  data-unavailable={type ? undefined : ""}
                  onClick={(event) => {
                    if (
                      event.currentTarget.contains(event.target as Node) &&
                      !(event.target as Element).closest(
                        "[data-card-control], button, input",
                      )
                    )
                      onSelect(active ? undefined : agent.pubkey);
                  }}
                  onDoubleClick={(event) => {
                    if (
                      event.currentTarget.contains(event.target as Node) &&
                      !(event.target as Element).closest(
                        "[data-card-control], button, input",
                      )
                    )
                      onBuild(agent.pubkey);
                  }}
                  agent={agent}
                  community={agent.relay || undefined}
                  icon={<TypeIcon type={type} />}
                  detail={summaryOf(agent, type)}
                />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Card edits use the same type-owned field and service as creation/settings. */
function InventoryCard({
  service,
  type,
  onBuild,
  onRemoved,
  ...props
}: Omit<React.ComponentProps<typeof AgentCard>, "agent"> & {
  agent: Agent;
  service: Agents;
  type: RegisteredAgentType | undefined;
  onBuild(): void;
  onRemoved(): void;
}) {
  const agent = props.agent;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const editable = agent.place !== "elsewhere" && !agent.unfinished;
  const Model = editable ? type?.CreateModel : undefined;
  const save = async (config: unknown) => {
    setSaving(true);
    setError("");
    try {
      await service.save(agent.pubkey, { config });
    } catch (reason) {
      setError(message(reason));
    } finally {
      setSaving(false);
    }
  };
  const menu = (remove?: () => void) => (
    <MenuRoot>
      <MenuTrigger
        render={
          <IconButton
            aria-label={`Actions for ${agent.name}`}
            size="sm"
            icon={<DotsThreeIcon size={16} />}
          />
        }
      />
      <MenuPopup align="end">
        {editable && <MenuItem onClick={onBuild}>Open settings</MenuItem>}
        <MenuItem
          onClick={() => {
            void navigator.clipboard
              .writeText(agent.pubkey)
              .catch((reason) => setError(message(reason)));
          }}
        >
          Copy public key
        </MenuItem>
        {remove && (
          <MenuItem tone="danger" onClick={remove}>
            Delete agent
          </MenuItem>
        )}
      </MenuPopup>
    </MenuRoot>
  );
  return (
    <AgentCard
      {...props}
      icon={Model ? undefined : props.icon}
      detail={Model ? undefined : props.detail}
      menu={
        agent.place === "elsewhere" ? (
          menu()
        ) : (
          <AgentDelete
            agents={service}
            agent={agent}
            onRemoved={onRemoved}
            trigger={menu}
          />
        )
      }
    >
      <div
        data-card-control=""
        className="flex min-w-0 max-w-full flex-col items-center gap-2"
      >
        {Model && (
          <Model
            config={agent.config}
            modelAppearance="subtle"
            disabled={saving}
            onChange={(config) => void save(config)}
          />
        )}
        {error && (
          <span role="alert" className="text-body-sm text-danger">
            {error}
          </span>
        )}
      </div>
    </AgentCard>
  );
}

function SideHeader({ title, onClose }: { title: ReactNode; onClose(): void }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <div className="min-w-0">{title}</div>
      <IconButton
        aria-label="Close"
        size="sm"
        icon={<XIcon size={16} aria-hidden="true" />}
        onClick={onClose}
      />
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="grid gap-2" aria-label={title}>
      <h4 className="m-0 text-caption text-secondary">{title}</h4>
      {children}
    </section>
  );
}

function AgentPeek({
  agents,
  agent,
  type,
  channels,
  onClose,
}: {
  agents: Agents;
  agent: Agent;
  type: RegisteredAgentType | undefined;
  channels: readonly ChannelChoice[];
  onClose(): void;
}) {
  const [finishing, setFinishing] = useState(false);
  const [error, setError] = useState("");
  const finish = async () => {
    setFinishing(true);
    setError("");
    try {
      await agents.finish(agent.pubkey);
    } catch (reason) {
      setError(message(reason));
    }
    setFinishing(false);
  };
  return (
    <div className={styles.sideBody}>
      <PeekIdentity
        agent={agent}
        detail={summaryOf(agent, type)}
        onClose={onClose}
      />
      {agent.place === "elsewhere" ? (
        <p className="m-0 text-body-sm text-secondary">
          Its key is on another of your devices, which runs it. Open Agents
          there to change or delete it.
        </p>
      ) : (
        <>
          <p className="m-0 text-body-sm text-secondary">
            Its provider made it, but its setup did not finish.
          </p>
          <Button
            variant="primary"
            loading={finishing}
            onClick={() => void finish()}
          >
            Finish setup
          </Button>
          {error && (
            <p role="alert" className="m-0 text-body-sm text-danger">
              {error}
            </p>
          )}
          <AgentDelete agents={agents} agent={agent} onRemoved={onClose} />
          {agent.place === "here" && (
            <Section title="Wakes on">
              <AttentionSummary agent={agent} channels={channels} />
            </Section>
          )}
        </>
      )}
    </div>
  );
}

function PeekIdentity({
  agent,
  detail,
  onClose,
}: {
  agent: Agent;
  detail: string;
  onClose(): void;
}) {
  return (
    <div className={styles.peekIdentity}>
      <span className={styles.portraitLarge}>
        <AgentPortrait agent={agent} community={agent.relay || undefined} />
      </span>
      <div className="grid min-w-0 flex-1 gap-0.5">
        <h3 className="m-0 truncate text-heading">{agent.name}</h3>
        <p className="m-0 text-body-sm text-secondary">{detail}</p>
      </div>
      <IconButton
        aria-label="Close"
        size="sm"
        icon={<XIcon size={16} aria-hidden="true" />}
        onClick={onClose}
      />
    </div>
  );
}

const SOURCES: Record<PortSource, string> = {
  harness: "Buzz 1.0 harness agent",
  installed: "Buzz 0.X",
  development: "Buzz 0.X dev",
};
const host = (relay: string) => relay.replace(/^wss:\/\//, "");

/** Identities earlier agent systems saved on this machine, each imported
 * with its key, name and picture as an agent of the chosen type. */
function ImportAgents({
  agents,
  types,
  onImported,
  onPendingChange,
}: {
  agents: Agents;
  types: readonly RegisteredAgentType[];
  onImported(): void;
  onPendingChange(pending: boolean): void;
}) {
  const [found, setFound] = useState<PortableAgents>();
  const [type, setType] = useState(types[0]?.key ?? "");
  const [pending, setPending] = useState<string>();
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    agents.portable().then(
      (next) => live && setFound(next),
      (reason) => live && setError(message(reason)),
    );
    return () => {
      live = false;
    };
  }, [agents]);
  const chosen = types.find((item) => item.key === type) ?? types[0];
  const labels = publicKeyLabels(found?.agents.map((a) => a.pubkey) ?? []);
  const named = new Map<string, number>();
  for (const agent of found?.agents ?? [])
    named.set(agent.name, (named.get(agent.name) ?? 0) + 1);
  const port = async (agent: PortableAgent) => {
    if (!chosen || pending) return;
    setPending(agent.pubkey);
    onPendingChange(true);
    setError("");
    try {
      await agents.port({
        source: agent.source,
        pubkey: agent.pubkey,
        type: chosen.key,
      });
      setFound(
        (last) =>
          last && {
            ...last,
            agents: last.agents.filter((item) => item.pubkey !== agent.pubkey),
          },
      );
      onImported();
    } catch (reason) {
      setError(message(reason));
    } finally {
      setPending(undefined);
      onPendingChange(false);
    }
  };
  if (!types.length)
    return (
      <p className="m-0 text-body-sm text-secondary">
        Enable an agent type plugin to import agents.
      </p>
    );
  return (
    <div className="flex flex-col gap-4">
      <p className="m-0 text-body-sm text-secondary">
        {chosen?.adopt
          ? "Keeps each agent's key, name, picture and instructions in this community. Its other settings stay behind."
          : "Keeps each agent's key, name and picture in this community. Its instructions and settings stay behind."}{" "}
        Stop it where it runs now first, or both will answer.
      </p>
      {types.length > 1 && (
        <div className="flex">
          <Select
            label="Import as"
            value={chosen?.key ?? ""}
            disabled={!!pending}
            groups={[
              {
                label: "Agent types",
                options: types.map((item) => ({
                  value: item.key,
                  label: item.title,
                })),
              },
            ]}
            onValueChange={setType}
          />
        </div>
      )}
      {error && (
        <p role="alert" className="m-0 text-body-sm text-danger">
          {error}
        </p>
      )}
      {found?.warnings.map((warning) => (
        <p key={warning} className="m-0 text-body-sm text-secondary">
          {warning}
        </p>
      ))}
      {!found ? (
        !error && (
          <p role="status" className="m-0 text-body-sm text-secondary">
            Looking for agents…
          </p>
        )
      ) : found.agents.length ? (
        <section aria-label="Agents to import" className={cardStyles.grid}>
          {found.agents.map((agent) => (
            <AgentCard
              key={agent.pubkey}
              agent={agent}
              community={agent.relay || undefined}
              detail={
                <Tooltip
                  content={[
                    canonicalPublicKey(agent.pubkey),
                    agent.relay && host(agent.relay),
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                  delay={300}
                >
                  <span
                    // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users need access to its key and community in the tooltip.
                    tabIndex={0}
                  >
                    {[
                      SOURCES[agent.source],
                      // Its key tells it apart only from one of the same name.
                      named.get(agent.name) !== 1 && labels.get(agent.pubkey),
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </Tooltip>
              }
            >
              <Button
                size="compact"
                variant="outline"
                aria-label={`Import ${agent.name}`}
                loading={pending === agent.pubkey}
                disabled={!chosen || (!!pending && pending !== agent.pubkey)}
                onClick={() => void port(agent)}
              >
                Import
              </Button>
            </AgentCard>
          ))}
        </section>
      ) : (
        <p className="m-0 text-body-sm text-secondary">
          No other agents found to import.
        </p>
      )}
    </div>
  );
}

/** The owner's teams: each a name, instructions and members, given to every
 * member's prompt with a roster. Agents record nothing about their teams. */
function Teams({
  agents,
  saved,
  teams,
}: {
  agents: Agents;
  saved: readonly Agent[];
  teams: readonly Team[];
}) {
  // A team's id while it is edited, or "new" for one being made.
  const [editing, setEditing] = useState<string>();
  const team = teams.find((item) => item.id === editing);
  if (editing === "new" || team)
    return (
      <TeamEditor
        key={editing}
        agents={agents}
        saved={saved}
        {...(team ? { team } : {})}
        onDone={() => setEditing(undefined)}
      />
    );
  const names = new Map(saved.map((agent) => [agent.pubkey, agent.name]));
  return (
    <section className="grid gap-5" aria-label="Teams">
      <p className="m-0 text-body-sm text-secondary">
        Each member is told who its teammates are, and follows the team's
        instructions after its own.
      </p>
      {teams.length ? (
        <ul className={styles.portList} aria-label="Teams">
          {teams.map((item) => (
            <li key={item.id} className={styles.portRow}>
              <span className="grid min-w-0 flex-1">
                <span className="truncate text-body">{item.name}</span>
                <span className="truncate text-caption text-secondary">
                  {item.members
                    .map((pubkey) => names.get(pubkey))
                    .filter(Boolean)
                    .join(", ") || "No members"}
                </span>
              </span>
              <Button
                size="compact"
                aria-label={`Edit ${item.name}`}
                onClick={() => setEditing(item.id)}
              >
                Edit
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="m-0 text-body-sm text-secondary">No teams yet.</p>
      )}
      <Button variant="primary" onClick={() => setEditing("new")}>
        <PlusIcon size={14} aria-hidden="true" /> New team
      </Button>
    </section>
  );
}

function TeamEditor({
  agents,
  saved,
  team,
  onDone,
}: {
  agents: Agents;
  saved: readonly Agent[];
  team?: Team;
  onDone(): void;
}) {
  const [name, setName] = useState(team?.name ?? "");
  const [instructions, setInstructions] = useState(team?.instructions ?? "");
  const [members, setMembers] = useState<readonly string[]>(
    team?.members ?? [],
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const act = async (work: () => Promise<unknown>) => {
    if (pending) return;
    setPending(true);
    setError("");
    try {
      await work();
      onDone();
    } catch (reason) {
      setError(message(reason));
      setPending(false);
    }
  };
  const save = () =>
    act(() =>
      agents.saveTeam({
        ...(team ? { id: team.id } : {}),
        name: name.trim(),
        instructions,
        members,
      }),
    );
  return (
    <form
      className={styles.sideBody}
      aria-label={team ? `Edit ${team.name}` : "New team"}
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !pending) onDone();
      }}
    >
      <SideHeader
        title={
          <h3 className="m-0 text-heading">
            {team ? "Edit team" : "New team"}
          </h3>
        }
        onClose={onDone}
      />
      <Field label="Name">
        <Input
          autoFocus
          value={name}
          disabled={pending}
          onChange={(event) => setName(event.target.value)}
        />
      </Field>
      <Field
        label="Instructions"
        description="Every member follows these after its own instructions."
      >
        <Textarea
          rows={5}
          value={instructions}
          disabled={pending}
          onChange={(event) => setInstructions(event.target.value)}
        />
      </Field>
      <Section title="Members">
        {saved.length ? (
          <div className="grid gap-2">
            {saved.map((agent) => (
              <Checkbox
                key={agent.pubkey}
                label={agent.name}
                checked={members.includes(agent.pubkey)}
                disabled={pending}
                onCheckedChange={(checked) =>
                  setMembers((last) =>
                    checked
                      ? [...last, agent.pubkey]
                      : last.filter((pubkey) => pubkey !== agent.pubkey),
                  )
                }
              />
            ))}
          </div>
        ) : (
          <p className="m-0 text-body-sm text-secondary">No agents yet.</p>
        )}
      </Section>
      {error && (
        <p role="alert" className="m-0 text-body-sm text-danger">
          {error}
        </p>
      )}
      <div className="flex items-center gap-2">
        <Button
          type="submit"
          variant="primary"
          loading={pending}
          disabled={!name.trim()}
        >
          {team ? "Save" : "Create team"}
        </Button>
        {team && (
          <Button
            variant="destructive"
            disabled={pending}
            onClick={() => void act(() => agents.removeTeam(team.id))}
          >
            Delete team
          </Button>
        )}
      </div>
    </form>
  );
}
