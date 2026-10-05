import type { RelaySession } from "../../features/relay/session";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { ChannelKit } from "../../features/channel-templates/capability";
import {
  emptyLineup,
  type AgentChoice,
  type KitEntry,
  type KitValue,
  type Team,
  type Template,
} from "../../features/channel-templates/model";
import { EmptyState } from "../../shared/design-system/ui/EmptyState";
import { SquaresFourIcon, UsersIcon } from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog, type DialogProps } from "../../shared/design-system/ui/Dialog";
import { Field } from "../../shared/design-system/ui/Field";
import { Tabs } from "../../shared/design-system/ui/Tabs";
import { Input } from "../../shared/design-system/ui/Input";
import { AgentSelection, TemplateFields } from "./TemplateFields";
import styles from "../channels/ChannelTemplates.module.css";

export function ChannelTemplatesDialog({
  session,
  open,
  onOpenChange,
  kit,
  agents,
  initial,
  notice,
  active,
  finalFocus,
}: {
  session?: RelaySession | undefined;
  finalFocus?: DialogProps["finalFocus"];
  active(): boolean;
  open: boolean;
  onOpenChange(open: boolean): void;
  kit: ChannelKit;
  agents: readonly AgentChoice[];
  initial?: Template | undefined;
  notice?: string | undefined;
}) {
  const live = useRef(true);
  useLayoutEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const state = useSyncExternalStore(kit.subscribe, kit.snapshot);
  const [library, setLibrary] = useState<"template" | "team">("template");
  const [draft, setDraft] = useState<Team | Template>();
  const [base, setBase] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [deleting, setDeleting] = useState<{
    value: Team | Template;
    eventId: string;
  }>();
  const nameInput = useRef<HTMLInputElement>(null);
  const newButton = useRef<HTMLButtonElement>(null);
  const previousDraft = useRef(draft);
  useLayoutEffect(() => {
    if (draft?.id !== previousDraft.current?.id) {
      if (draft) nameInput.current?.focus();
      else newButton.current?.focus();
    }
    previousDraft.current = draft;
  }, [draft]);
  const cancelDelete = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (open) {
      kit.ensure();
      if (initial) {
        setDraft(initial);
        setBase(undefined);
      }
    }
  }, [open, kit, initial]);
  const edit = (entry: KitEntry) => {
    if (entry.record.value.type === "groups") return;
    setDraft(structuredClone(entry.record.value));
    setBase(entry.eventId);
    setError("");
  };
  const save = async (
    value: KitValue,
    expected: string | undefined,
    deleted = false,
  ) => {
    if (!live.current || !active()) return;
    setBusy(true);
    setError("");
    try {
      await kit.save(value, expected, deleted);
      if (value.type !== "groups") setLibrary(value.type);
      setDraft(undefined);
      setBase(undefined);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      dismissOnOutsideClick
      open={open}
      finalFocus={finalFocus}
      onOpenChange={onOpenChange}
      preventClose={busy}
      title={
        draft ? `${base ? "Edit" : "New"} ${draft.type}` : "Templates & teams"
      }
      description={
        draft?.type === "team"
          ? "Choose agents to reuse together in future channels. This team is private to you in this community."
          : draft
            ? "Save a starting setup for future channels. Applying a template copies it once; existing channels stay unchanged."
            : "Private to you in this community. Templates save a channel’s starting setup; teams save a reusable group of agents."
      }
      closeLabel="Close templates"
      leadingActions={
        !draft && kit.available ? (
          <Button
            variant="ghost"
            loading={state.status === "loading"}
            disabled={busy}
            onClick={() => void kit.refresh()}
          >
            Refresh
          </Button>
        ) : undefined
      }
      actions={
        draft ? (
          <>
            <Button
              disabled={busy}
              onClick={() => {
                setLibrary(draft.type);
                setDraft(undefined);
                setError("");
              }}
            >
              Back to library
            </Button>
            <Button
              variant="prominent"
              loading={busy}
              disabled={!draft.name.trim() || state.status !== "ready"}
              onClick={() => void save(draft, base)}
            >
              Save {draft.type}
            </Button>
          </>
        ) : (
          <Button
            ref={newButton}
            variant="prominent"
            disabled={busy || !kit.available || state.status !== "ready"}
            onClick={() => {
              setDraft(
                library === "template"
                  ? {
                      type: "template",
                      id: crypto.randomUUID(),
                      name: "",
                      description: "",
                      ...emptyLineup(),
                    }
                  : {
                      type: "team",
                      id: crypto.randomUUID(),
                      name: "",
                      agents: [],
                    },
              );
              setBase(undefined);
              setError("");
            }}
          >
            New {library}
          </Button>
        )
      }
    >
      <div className={styles.stack} inert={busy}>
        {notice && <p role="status">{notice}</p>}
        {error && (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        )}
        {state.status !== "ready" && (
          <p role="status">
            {state.error ??
              (state.status === "unavailable"
                ? "This host does not support saved templates."
                : "Loading your saved templates…")}
          </p>
        )}
        {draft ? (
          <>
            <Field label="Name">
              <Input
                ref={nameInput}
                maxLength={120}
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </Field>
            {draft.type === "team" ? (
              <AgentSelection
                session={session}
                agents={agents}
                selected={draft.agents}
                onChange={(agents) => setDraft({ ...draft, agents })}
              />
            ) : (
              <>
                <Field
                  label="Description"
                  description="Optional. A short reminder of what this template is for."
                >
                  <Input
                    maxLength={1000}
                    value={draft.description}
                    onChange={(e) =>
                      setDraft({ ...draft, description: e.target.value })
                    }
                  />
                </Field>
                <TemplateFields
                  key={draft.id}
                  session={session}
                  value={draft}
                  onChange={(value) => setDraft({ ...draft, ...value })}
                  entries={state.entries}
                  agents={agents}
                />
              </>
            )}
          </>
        ) : (
          <Tabs
            label="Template library"
            variant="panel"
            value={library}
            onValueChange={setLibrary}
            items={[
              { value: "template", label: "Templates" },
              { value: "team", label: "Teams" },
            ]}
            renderPanel={(type) => {
              const entries = state.entries.filter(
                (entry) =>
                  !entry.record.deleted && entry.record.value.type === type,
              );
              return entries.length ? (
                <ul className={styles.list}>
                  {entries.map((entry) => {
                    const value = entry.record.value;
                    if (value.type === "groups") return null;
                    return (
                      <li key={value.id} className={styles.row}>
                        <Button variant="ghost" onClick={() => edit(entry)}>
                          <span className={styles.entryName}>{value.name}</span>
                        </Button>
                        <Button
                          variant="ghost"
                          onClick={() =>
                            setDeleting({ value, eventId: entry.eventId })
                          }
                        >
                          Delete
                        </Button>
                      </li>
                    );
                  })}
                </ul>
              ) : state.status === "ready" ? (
                <EmptyState
                  icon={type === "team" ? <UsersIcon /> : <SquaresFourIcon />}
                  title={`No ${type === "team" ? "teams" : "templates"} yet`}
                  description={
                    type === "team"
                      ? "Save a group of agents to reuse in your channel templates."
                      : "Save teams, individual agents, or a starting Canvas for new channels."
                  }
                />
              ) : null;
            }}
          />
        )}
      </div>
      <Dialog
        open={open && !!deleting}
        onOpenChange={(open) => {
          if (!open) setDeleting(undefined);
        }}
        dismissOnOutsideClick
        initialFocus={cancelDelete}
        title={`Delete “${deleting?.value.name ?? ""}”?`}
        description="Existing channels stay unchanged. Templates or group defaults that use this item will need a replacement."
        actions={
          <>
            <Button ref={cancelDelete} onClick={() => setDeleting(undefined)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (!deleting) return;
                setDeleting(undefined);
                void save(deleting.value, deleting.eventId, true);
              }}
            >
              Delete
            </Button>
          </>
        }
      >
        {null}
      </Dialog>
    </Dialog>
  );
}
