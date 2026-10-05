import { npubEncode } from "nostr-tools/nip19";
import { useEffect, useRef, useState } from "react";
import type { ChannelKit } from "../../features/channel-templates/capability";
import {
  emptyLineup,
  type AgentChoice,
  type KitEntry,
  type Team,
  type Template,
} from "../../features/channel-templates/model";
import type { RelaySession } from "../../features/relay/session";
import {
  ArrowsClockwiseIcon,
  DotsThreeIcon,
  FileTextIcon,
  PlusIcon,
  UsersIcon,
} from "../../shared/design-system/icons";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { Header, InlineHeader } from "../../shared/design-system/ui/Header";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import {
  MenuItem,
  MenuPopup,
  MenuRoot,
  MenuTrigger,
} from "../../shared/design-system/ui/Menu";
import { EmptyState } from "../../shared/design-system/ui/EmptyState";
import { Tooltip } from "../../shared/design-system/ui/Tooltip";
import { formatPublicKey } from "../../shared/identity/public-key";
import { ChannelTemplatesDialog } from "./ChannelTemplatesDialog";
import type { useTemplateCatalog } from "./useTemplateCatalog";
import styles from "./TemplateLibrary.module.css";

type Selection = { value: Team | Template; eventId?: string };

export function TemplateLibrary({
  session,
  kit,
  catalog,
  active,
}: {
  session?: RelaySession;
  kit: ChannelKit;
  catalog: ReturnType<typeof useTemplateCatalog>;
  active(): boolean;
}) {
  const [editing, setEditing] = useState<Selection>();
  const [deleting, setDeleting] = useState<Selection>();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const trigger = useRef<HTMLElement | null>(null);
  const cancelDelete = useRef<HTMLButtonElement>(null);
  const newTemplate = useRef<HTMLButtonElement>(null);
  const newTeam = useRef<HTMLButtonElement>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const { kit: state } = catalog;
  const entries = state.entries.filter((entry) => !entry.record.deleted);
  const disabled =
    !kit.available || state.status !== "ready" || !catalog.agentsReady;
  const open = (
    selection: Selection,
    element: HTMLElement | null,
    remove = false,
  ) => {
    if (!active()) return;
    trigger.current = element;
    setError("");
    if (remove) {
      setDeleting(selection);
      setDeleteOpen(true);
    } else setEditing(selection);
  };
  const remove = async () => {
    if (!deleting || busy || !mounted.current || !active()) return;
    setBusy(true);
    setError("");
    try {
      await kit.save(deleting.value, deleting.eventId, true);
      if (mounted.current && active()) setDeleteOpen(false);
    } catch (reason) {
      if (mounted.current && active())
        setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (mounted.current && active()) setBusy(false);
    }
  };
  return (
    <>
      <Header
        title="Templates & teams"
        subtitle="Private to you in this community"
        actions={
          <Button
            variant="ghost"
            size="sm"
            loading={state.status === "loading"}
            onClick={() => {
              if (active()) catalog.refresh();
            }}
          >
            <ArrowsClockwiseIcon size={16} /> Refresh
          </Button>
        }
      />
      <div className={styles.library}>
        {(state.status !== "ready" ||
          !catalog.agentsReady ||
          catalog.error) && (
          <p role="status" className="text-body-sm text-subtle">
            {state.error ??
              catalog.error ??
              (state.status === "unavailable"
                ? "This host does not support saved templates."
                : state.status !== "ready"
                  ? "Loading your templates and teams…"
                  : "Loading available agents…")}
          </p>
        )}
        {(["template", "team"] as const).map((type) => {
          const items = entries.filter(
            (entry) => entry.record.value.type === type,
          );
          return (
            <section
              key={type}
              aria-labelledby={`library-${type}`}
              className={styles.section}
            >
              <InlineHeader
                id={`library-${type}`}
                title={
                  <>
                    {type === "template" ? "Channel templates" : "Saved teams"}{" "}
                    <span className={styles.count}>{items.length}</span>
                  </>
                }
                subtitle={
                  type === "template"
                    ? "Agent and canvas presets for new channels."
                    : "Reusable agent selections for channel setup and @mentions."
                }
                actions={
                  <Button
                    ref={type === "template" ? newTemplate : newTeam}
                    variant="subtle"
                    size="sm"
                    disabled={disabled}
                    onClick={(event) =>
                      open(
                        {
                          value:
                            type === "template"
                              ? {
                                  type,
                                  id: crypto.randomUUID(),
                                  name: "",
                                  description: "",
                                  ...emptyLineup(),
                                }
                              : {
                                  type,
                                  id: crypto.randomUUID(),
                                  name: "",
                                  agents: [],
                                },
                        },
                        event.currentTarget,
                      )
                    }
                  >
                    <PlusIcon size={16} /> New {type}
                  </Button>
                }
              />
              {items.length > 0 && (
                <div className={styles.items}>
                  {items.map((entry) => {
                    const value = entry.record.value;
                    if (value.type === "groups") return null;
                    return (
                      <LibraryItem
                        key={value.id}
                        value={value}
                        entries={entries}
                        agents={catalog.agents}
                        disabled={disabled}
                        onEdit={(element) =>
                          open({ value, eventId: entry.eventId }, element)
                        }
                        onDuplicate={(template, element) =>
                          open(
                            {
                              value: {
                                ...structuredClone(template),
                                id: crypto.randomUUID(),
                                name: `${template.name.slice(0, 113).trimEnd()} (copy)`,
                              },
                            },
                            element,
                          )
                        }
                        onDelete={(element) =>
                          open({ value, eventId: entry.eventId }, element, true)
                        }
                      />
                    );
                  })}
                </div>
              )}
              {!items.length && state.status === "ready" && (
                <EmptyState
                  level={4}
                  icon={type === "template" ? <FileTextIcon /> : <UsersIcon />}
                  title={
                    type === "template"
                      ? "Your next channel starts here"
                      : "Bring your agents together"
                  }
                  description={
                    type === "template"
                      ? "Create a template, or save an existing channel as one from its menu."
                      : "Create a team to reuse your favorite combination of agents."
                  }
                />
              )}
            </section>
          );
        })}
        {editing && (
          <ChannelTemplatesDialog
            session={session}
            open
            onOpenChange={(open) => {
              if (!open) setEditing(undefined);
            }}
            kit={kit}
            agents={catalog.agents}
            initial={editing.value}
            expected={editing.eventId}
            active={active}
            finalFocus={trigger}
          />
        )}
        <Dialog
          open={deleteOpen}
          onOpenChange={(open) => {
            if (!open) setDeleteOpen(false);
          }}
          dismissOnOutsideClick
          preventClose={busy}
          initialFocus={cancelDelete}
          finalFocus={() =>
            trigger.current?.isConnected
              ? trigger.current
              : deleting?.value.type === "team"
                ? newTeam.current
                : newTemplate.current
          }
          title={`Delete “${deleting?.value.name ?? ""}”?`}
          description={
            deleting?.value.type === "team"
              ? "Only this saved team is deleted. Its agents and their channel memberships stay unchanged. Templates using this team will need a replacement."
              : "Existing channels stay unchanged. Group defaults using this template will need a replacement."
          }
          actions={
            <>
              <Button
                ref={cancelDelete}
                disabled={busy}
                onClick={() => setDeleteOpen(false)}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                loading={busy}
                onClick={() => void remove()}
              >
                Delete
              </Button>
            </>
          }
        >
          {error && (
            <p role="alert" className="text-body-sm text-danger">
              {error}
            </p>
          )}
        </Dialog>
      </div>
    </>
  );
}

function LibraryItem({
  value,
  entries,
  agents,
  disabled,
  onEdit,
  onDuplicate,
  onDelete,
}: {
  value: Team | Template;
  entries: readonly KitEntry[];
  agents: readonly AgentChoice[];
  disabled: boolean;
  onEdit(trigger: HTMLElement | null): void;
  onDuplicate(template: Template, trigger: HTMLElement | null): void;
  onDelete(trigger: HTMLElement | null): void;
}) {
  const menuTrigger = useRef<HTMLButtonElement>(null);
  const teams =
    value.type === "template"
      ? value.teamIds.map(
          (id) =>
            entries.find(
              (entry) =>
                entry.record.value.type === "team" &&
                entry.record.value.id === id,
            )?.record.value,
        )
      : [];
  const keys = [
    ...new Set([
      ...value.agents,
      ...teams.flatMap((team) => (team?.type === "team" ? team.agents : [])),
    ]),
  ];
  const members = keys.map(
    (pubkey) =>
      agents.find((agent) => agent.pubkey === pubkey) ?? {
        pubkey,
        name: formatPublicKey(pubkey) || "Unavailable agent",
      },
  );
  const menu = (
    <MenuRoot>
      <MenuTrigger
        ref={menuTrigger}
        render={
          <IconButton
            aria-label={`Actions for ${value.name}`}
            disabled={disabled}
            size="sm"
            icon={<DotsThreeIcon size={18} />}
          />
        }
      />
      <MenuPopup align="end" size="compact">
        <MenuItem
          onClick={() => {
            onEdit(menuTrigger.current);
          }}
        >
          Edit {value.type}
        </MenuItem>
        {value.type === "template" && (
          <MenuItem
            onClick={() => {
              onDuplicate(value, menuTrigger.current);
            }}
          >
            Duplicate template
          </MenuItem>
        )}
        <MenuItem
          tone="danger"
          onClick={() => {
            onDelete(menuTrigger.current);
          }}
        >
          Delete {value.type}…
        </MenuItem>
      </MenuPopup>
    </MenuRoot>
  );
  return (
    <article className={styles.item} aria-label={value.name}>
      <div className={styles.itemHeading}>
        <h4 className={`text-label-sm ${styles.name}`}>{value.name}</h4>
        {value.type === "template" && (
          <>
            {value.description.trim() && (
              <p className={`text-body-sm text-subtle ${styles.description}`}>
                {value.description}
              </p>
            )}
            {!!value.teamIds.length && (
              <p className="text-caption text-subtle">
                {value.teamIds.length}{" "}
                {value.teamIds.length === 1 ? "team" : "teams"}
              </p>
            )}
            {teams.some((team) => !team) && (
              <p className="text-caption text-danger">
                A saved team is unavailable. Edit to replace it.
              </p>
            )}
          </>
        )}
      </div>
      <div className={styles.itemFooter}>
        <div className={styles.avatars}>
          {members.map((agent) => (
            <Tooltip
              key={agent.pubkey}
              closeOnClick={false}
              content={
                <>
                  <span className="block text-label-sm">{agent.name}</span>
                  <span className="block text-mono-sm">
                    {npubEncode(agent.pubkey)}
                  </span>
                </>
              }
            >
              <button
                type="button"
                className={styles.avatar}
                aria-label={agent.name}
              >
                <Avatar
                  src={agent.avatar}
                  alt=""
                  fallback={agent.name}
                  shape="squircle"
                  size="small"
                />
              </button>
            </Tooltip>
          ))}
          {!members.length && (
            <span className="text-caption text-subtle">No agents</span>
          )}
        </div>
        <div className={styles.itemActions}>{menu}</div>
      </div>
    </article>
  );
}
