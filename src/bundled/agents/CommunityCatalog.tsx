import { useEffect, useState, useSyncExternalStore } from "react";
import type { CatalogKind } from "../../features/agents/catalog";
import { sameCommunityAgents } from "../../features/agents/choices";
import type {
  AgentControl,
  AgentView,
  CloneSettings,
} from "../../features/agents/control";
import {
  AGENT_CATALOG_KIND,
  agentCatalogContent,
  type AgentPublication,
  catalogSlug,
  type CatalogAgent,
  TEAM_CATALOG_KIND,
  teamCatalogContent,
  type TeamPublication,
} from "../../features/agents/catalog-protocol";
import { useIdentityNames } from "../../features/identity-names/react";
import type { RelaySession } from "../../features/relay/session";
import { avatarMedia } from "../../shared/avatar-source";
import { CaretDownIcon } from "../../shared/design-system/icons";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import { SwitchPreferenceRow } from "../../shared/design-system/ui/SwitchPreferenceRow";
import styles from "./CommunityCatalog.module.css";

type CommunityCatalog = RelaySession["communityCatalog"];
type Publication = AgentPublication | TeamPublication;

export const agentShareDescription =
  "Anyone in this community can find and use a copy. Your agent instruction is shared as plaintext. Memories and secrets aren’t included.";
export const teamShareDescription =
  "Anyone in this community can find and add a copy of this team. Both the team instructions and every member’s instructions are shared as plaintext. Memories and secrets aren’t included.";

/** Holds the catalog read open for as long as a consumer is mounted. */
export function useCommunityCatalog(catalog: CommunityCatalog) {
  useEffect(() => catalog.retain(), [catalog]);
  return useSyncExternalStore(
    catalog.subscribe,
    catalog.snapshot,
    catalog.snapshot,
  );
}

export function catalogShareNotice(
  name: string,
  change: { shared: boolean; delivery: "queued" | "accepted" },
) {
  if (change.delivery === "queued")
    return change.shared
      ? `Sharing ${name} is queued. It will appear after the relay accepts the update.`
      : `Removing ${name} is queued. It may remain discoverable until the relay accepts the update.`;
  return change.shared
    ? `Published ${name} to the community catalog.`
    : `${name} is no longer discoverable in the community catalog.`;
}

const message = (problem: unknown) =>
  problem instanceof Error ? problem.message : String(problem);

/** One coordinate's share switch. The switch shows the newest intent; the
 * notice distinguishes a queued, accepted or refused relay delivery. */
export function CatalogShareSwitch({
  catalog,
  kind,
  d,
  name,
  description,
  content,
}: {
  catalog: CommunityCatalog;
  kind: CatalogKind;
  d: string;
  name: string;
  description: string;
  /** Projects the current local definition; may refuse with a reason. */
  content(): string | Promise<string>;
}) {
  const snapshot = useCommunityCatalog(catalog);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const { shared, change } = catalog.state(kind, d);
  const rejected = change?.delivery === "rejected";
  const checked = change && !rejected ? change.shared : shared;
  const update = async (next: boolean) => {
    setError(undefined);
    setPending(true);
    try {
      catalog.publish(kind, d, next, next ? await content() : undefined);
    } catch (problem) {
      setError(message(problem));
    } finally {
      setPending(false);
    }
  };
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <SwitchPreferenceRow
        label="Share to catalog"
        description={description}
        checked={checked}
        disabled={pending || snapshot.status !== "ready" || !catalog.writable()}
        onCheckedChange={(next) => void update(next)}
      />
      {snapshot.status === "error" && (
        <div role="alert" className="flex flex-wrap items-center gap-2">
          <p className="m-0 text-body-sm">{snapshot.error}</p>
          <Button size="compact" onClick={() => void catalog.refresh()}>
            Retry
          </Button>
        </div>
      )}
      {change && change.delivery !== "rejected" && (
        <div role="status" className="flex flex-wrap items-center gap-2">
          <p className="m-0 text-body-sm">
            {catalogShareNotice(name, {
              shared: change.shared,
              delivery: change.delivery,
            })}
          </p>
          {change.stalled && (
            <Button
              size="compact"
              onClick={() => catalog.retry(change.operation)}
            >
              Retry
            </Button>
          )}
          {(change.delivery === "accepted" || change.stalled) && (
            <Button
              size="compact"
              variant="ghost"
              onClick={() => void catalog.dismiss(change.operation)}
            >
              Dismiss
            </Button>
          )}
        </div>
      )}
      {(error || rejected) && (
        <div role="alert" className="flex flex-wrap items-center gap-2">
          <p className="m-0 break-words text-body-sm">
            Failed to update catalog sharing.
            {(error ?? change?.error) && ` ${error ?? change?.error}`}
          </p>
          {rejected && !error && (
            <>
              <Button
                size="compact"
                onClick={() => catalog.retry(change.operation)}
              >
                Retry
              </Button>
              <Button
                size="compact"
                variant="ghost"
                onClick={() => void catalog.dismiss(change.operation)}
              >
                Dismiss
              </Button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** Sharing applies to the connected community's setup of this identity. */
export function AgentShareSwitch({
  session,
  agent,
  name,
}: {
  session: RelaySession;
  agent: AgentView;
  name: string;
}) {
  if (!sameCommunityAgents([agent], session.scope).length) return null;
  return (
    <CatalogShareSwitch
      catalog={session.communityCatalog}
      kind={AGENT_CATALOG_KIND}
      d={catalogSlug(agent.pubkey)}
      name={name}
      description={agentShareDescription}
      content={() => agentCatalogContent(agent)}
    />
  );
}

/** A saved team's catalog switch. Its members are projected from this
 * community's local agent definitions when sharing, never from relay data. */
export function TeamShareDialog({
  session,
  control,
  team,
  onClose,
}: {
  session: RelaySession;
  control: AgentControl;
  team: { id: string; name: string; agents: readonly string[] };
  onClose(): void;
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={`Share ${team.name}`}
    >
      <CatalogShareSwitch
        catalog={session.communityCatalog}
        kind={TEAM_CATALOG_KIND}
        d={team.id}
        name={team.name}
        description={teamShareDescription}
        content={() =>
          teamCatalogContent(
            team,
            sameCommunityAgents(
              control.snapshot().data?.agents ?? [],
              session.scope,
            ),
          )
        }
      />
    </Dialog>
  );
}

const coordinate = (publication: Publication) =>
  `${publication.kind}:${publication.owner}:${publication.d}`;
const addedKey = (scope: string) => `buzz.catalog-added.v1:${scope}`;

/** Copies already added from this community, by catalog coordinate. Local
 * only: an adopted copy is independent of the shared entry. */
export function addedCopies(scope: string): ReadonlySet<string> {
  try {
    const value: unknown = JSON.parse(
      localStorage.getItem(addedKey(scope)) ?? "[]",
    );
    return new Set(
      Array.isArray(value)
        ? value.filter((item): item is string => typeof item === "string")
        : [],
    );
  } catch {
    return new Set();
  }
}
export function rememberAdded(scope: string, publication: Publication) {
  const added = new Set(addedCopies(scope));
  added.add(coordinate(publication));
  try {
    localStorage.setItem(addedKey(scope), JSON.stringify([...added]));
  } catch {
    /* The copy exists either way; only the Added hint is lost. */
  }
}

/** The header action that opens the catalog. An added agent goes through the
 * ordinary create flow, so its copy has a fresh identity and local keys. */
export function CatalogLauncher({
  session,
  addAgent,
}: {
  session: RelaySession;
  addAgent:
    | ((settings: CloneSettings, onCreated: () => void) => void)
    | undefined;
}) {
  const [open, setOpen] = useState(false);
  if (!session.communityCatalog.available()) return null;
  return (
    <>
      <Button
        variant="subtle"
        size="sm"
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        Choose from catalog
      </Button>
      {open && (
        <CommunityCatalogDialog
          session={session}
          onClose={() => setOpen(false)}
          onAddAgent={
            addAgent &&
            ((publication) => {
              setOpen(false);
              addAgent(
                {
                  name: publication.agent.displayName,
                  systemPrompt: publication.agent.systemPrompt,
                },
                () => rememberAdded(session.scope, publication),
              );
            })
          }
        />
      )}
    </>
  );
}

/** Browse and preview shared agents and teams. Preview renders plain data
 * only; adding is the caller's explicit, separately confirmed act. */
export function CommunityCatalogDialog({
  session,
  onClose,
  onAddAgent,
  onAddTeam,
}: {
  session: RelaySession;
  onClose(): void;
  onAddAgent?: ((publication: AgentPublication) => void) | undefined;
  onAddTeam?: ((publication: TeamPublication) => Promise<void>) | undefined;
}) {
  const catalog = session.communityCatalog;
  const snapshot = useCommunityCatalog(catalog);
  const resolve = useIdentityNames(session.names);
  const scope = session.scope;
  const [added, setAdded] = useState(() => addedCopies(scope));
  const [selected, setSelected] = useState<string>();
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string>();
  const entries: Publication[] = [...snapshot.agents, ...snapshot.teams];
  const current =
    entries.find((entry) => coordinate(entry) === selected) ?? entries[0];
  const own = (entry: Publication) => entry.owner === session.viewer;
  const isAdded = (entry: Publication) =>
    own(entry) || added.has(coordinate(entry));
  const owner = (entry: Publication) =>
    own(entry) ? "You" : resolve(entry.owner, "Community member");
  const picture = (url?: string) => avatarMedia(url, session.media);
  const addTeam = async (team: TeamPublication) => {
    if (!onAddTeam) return;
    setError(undefined);
    setAdding(true);
    try {
      await onAddTeam(team);
      rememberAdded(scope, team);
      setAdded(addedCopies(scope));
    } catch (problem) {
      setError(message(problem));
    } finally {
      setAdding(false);
    }
  };
  const loading =
    !entries.length &&
    (snapshot.status === "loading" || snapshot.status === "idle");
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      preventClose={adding}
      title="Community Catalog"
      size="wide"
      height="stable"
      actions={
        current?.kind === AGENT_CATALOG_KIND
          ? onAddAgent && (
              <Button
                variant="prominent"
                aria-label={
                  isAdded(current)
                    ? `${current.agent.displayName} is already in My Agents`
                    : `Add ${current.agent.displayName} from Community Catalog`
                }
                disabled={isAdded(current)}
                onClick={() => onAddAgent(current)}
              >
                {isAdded(current) ? "Added to My Agents" : "Add agent"}
              </Button>
            )
          : current &&
            onAddTeam && (
              <Button
                variant="prominent"
                aria-label={
                  isAdded(current)
                    ? `${current.name} is already in your teams`
                    : `Add ${current.name} from Community Catalog`
                }
                disabled={isAdded(current) || adding}
                onClick={() => void addTeam(current)}
              >
                {isAdded(current)
                  ? "Added to my teams"
                  : adding
                    ? "Adding…"
                    : "Add team"}
              </Button>
            )
      }
    >
      {loading ? (
        <p role="status">Loading the community catalog…</p>
      ) : snapshot.status === "error" ? (
        <div role="alert" className="flex flex-col items-start gap-2">
          <p className="m-0">{snapshot.error}</p>
          <Button onClick={() => void catalog.refresh()}>Retry</Button>
        </div>
      ) : !current ? (
        <div className="flex flex-col gap-1 text-center">
          <p className="m-0 text-label">Nothing shared yet</p>
          <p className="m-0 text-body-sm text-secondary">
            Shared agents and teams will appear here.
          </p>
        </div>
      ) : (
        <div className={styles.catalog}>
          <nav aria-label="Community Catalog" className={styles.sidebar}>
            {!!snapshot.agents.length && (
              <p className="m-0 text-label-sm text-secondary">Agents</p>
            )}
            {snapshot.agents.map((entry) => (
              <NavigationItem
                key={coordinate(entry)}
                selected={entry === current}
                aria-current={entry === current ? "true" : undefined}
                onClick={() => setSelected(coordinate(entry))}
                icon={
                  <Avatar
                    size="small"
                    src={picture(entry.agent.avatarUrl)}
                    alt=""
                    fallback={entry.agent.displayName}
                  />
                }
                label={entry.agent.displayName}
              />
            ))}
            {!!snapshot.teams.length && (
              <p className="m-0 text-label-sm text-secondary">Teams</p>
            )}
            {snapshot.teams.map((entry) => (
              <NavigationItem
                key={coordinate(entry)}
                selected={entry === current}
                aria-current={entry === current ? "true" : undefined}
                onClick={() => setSelected(coordinate(entry))}
                label={entry.name}
                trailing={entry.members.length}
              />
            ))}
          </nav>
          <section
            aria-label={
              current.kind === AGENT_CATALOG_KIND
                ? current.agent.displayName
                : current.name
            }
            className={`${styles.details} flex flex-col gap-6`}
          >
            {current.kind === AGENT_CATALOG_KIND ? (
              <>
                <div className="flex items-center gap-3">
                  <Avatar
                    size="large"
                    src={picture(current.agent.avatarUrl)}
                    alt=""
                    fallback={current.agent.displayName}
                  />
                  <div className="min-w-0">
                    <h3 className="m-0 truncate text-heading">
                      {current.agent.displayName}
                    </h3>
                    <AddedBy label={owner(current)} />
                  </div>
                </div>
                {current.agent.description && (
                  <p className="m-0 text-body-sm text-secondary">
                    {current.agent.description}
                  </p>
                )}
                <Metadata agent={current.agent} />
                <div className="flex flex-col gap-2">
                  <h4 className="m-0 text-label">Agent instructions</h4>
                  <Instructions text={current.agent.systemPrompt} />
                </div>
              </>
            ) : (
              <>
                <div className="min-w-0">
                  <h3 className="m-0 truncate text-heading">{current.name}</h3>
                  <AddedBy label={owner(current)} />
                  {current.description && (
                    <p className="mt-3 mb-0 text-body-sm text-secondary">
                      {current.description}
                    </p>
                  )}
                </div>
                {!!current.instructions?.trim() && (
                  <div className="flex flex-col gap-2">
                    <h4 className="m-0 text-label">Team instructions</h4>
                    <Instructions text={current.instructions} />
                  </div>
                )}
                <div className="flex flex-col gap-2">
                  <h4 className="m-0 text-label">
                    {current.members.length}{" "}
                    {current.members.length === 1 ? "member" : "members"}
                  </h4>
                  <ul className="m-0 flex list-none flex-col gap-2 p-0">
                    {current.members.map((member) => (
                      <Member
                        key={member.memberKey}
                        member={member}
                        picture={picture(member.avatarUrl)}
                      />
                    ))}
                  </ul>
                </div>
              </>
            )}
            {error && (
              <p role="alert" className="m-0 break-words text-body-sm">
                {error}
              </p>
            )}
          </section>
        </div>
      )}
    </Dialog>
  );
}

function AddedBy({ label }: { label: string }) {
  return (
    <p className="m-0 text-body-sm text-secondary">
      Added by <span className="text-primary">{label}</span>
    </p>
  );
}

function Metadata({ agent }: { agent: CatalogAgent }) {
  const items = [
    ["Type", "Custom agent"],
    ["Preferred model", agent.model ?? "Use app default"],
    ["Preferred runtime", agent.runtime ?? "Use app default"],
    ["Preferred provider", agent.provider ?? "Use app default"],
  ];
  return (
    <dl className="m-0 grid grid-cols-2 gap-3 sm:grid-cols-4">
      {items.map(([label, value]) => (
        <div key={label} className="min-w-0">
          <dt className="text-body-sm text-secondary">{label}</dt>
          <dd className="m-0 break-words text-body-sm">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Exact instructions as plain text: Markdown would hide link targets and
 * image sources, so the reviewed text could differ from what runs. */
function Instructions({ text }: { text: string }) {
  return (
    <pre className={`${styles.instructions} text-body-sm`}>
      {text || "No instructions included."}
    </pre>
  );
}

function Member({
  member,
  picture,
}: {
  member: TeamPublication["members"][number];
  picture: string | undefined;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <li className="flex flex-col gap-3">
      <Button
        variant="ghost"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <Avatar
          size="small"
          src={picture}
          alt=""
          fallback={member.displayName}
        />
        <span className="flex min-w-0 flex-1 flex-col text-left">
          <span className="truncate">{member.displayName}</span>
          <span className="truncate text-body-sm text-secondary">
            {member.model ?? "Use app default"}
          </span>
        </span>
        <CaretDownIcon size={16} aria-hidden="true" />
      </Button>
      {expanded && (
        <div className="flex flex-col gap-3 pl-2">
          <Metadata agent={member} />
          <div className="flex flex-col gap-2">
            <h5 className="m-0 text-label-sm">Agent instructions</h5>
            {member.systemPrompt.trim() ? (
              <Instructions text={member.systemPrompt} />
            ) : (
              <p className="m-0 text-body-sm text-secondary">No instructions</p>
            )}
          </div>
        </div>
      )}
    </li>
  );
}
