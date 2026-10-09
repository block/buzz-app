import type { AgentControl } from "../../features/agents/control";
import {
  deliverTeamTexts,
  readTeamTexts,
  resolveTeamText,
  teamTextConflict,
} from "../../features/agents/team-instructions";
import { Textarea } from "../../shared/design-system/ui/Textarea";
import type { RelaySession } from "../../features/relay/session";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type {
  ChannelKit,
  Resume,
} from "../../features/channel-templates/capability";
import type {
  AgentChoice,
  Team,
  Template,
} from "../../features/channel-templates/model";
import { Button } from "../../shared/design-system/ui/Button";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import { PlusIcon } from "../../shared/design-system/icons";
import type { TeamPublication } from "../../features/agents/catalog-protocol";
import {
  unsupportedTransport,
  unsupportedTransportMessage,
} from "../../features/agents/catalog-protocol";
import {
  TeamCatalogPreview,
  catalogAlreadyAdded,
  rememberAdded,
} from "../agents/CommunityCatalog";
import { Dialog, type DialogProps } from "../../shared/design-system/ui/Dialog";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import { AgentSelection, TemplateFields } from "./TemplateFields";
import styles from "../channels/ChannelTemplates.module.css";

export function ChannelTemplatesDialog({
  session,
  control,
  open,
  onOpenChange,
  kit,
  agents,
  initial,
  expected,
  notice,
  active,
  finalFocus,
  onImport,
  catalogSession,
  onAddCatalogTeam,
}: {
  session?: RelaySession | undefined;
  control?: AgentControl | undefined;
  finalFocus?: DialogProps["finalFocus"];
  onImport?: (() => void) | undefined;
  catalogSession?: RelaySession | undefined;
  onAddCatalogTeam?: ((team: TeamPublication) => Promise<string>) | undefined;
  active(): boolean;
  open: boolean;
  onOpenChange(open: boolean): void;
  kit: ChannelKit;
  agents: readonly AgentChoice[];
  initial: Team | Template;
  expected?: string | undefined;
  notice?: string | undefined;
}) {
  const communityCatalog = catalogSession?.communityCatalog;
  useEffect(() => {
    if (communityCatalog?.available()) return communityCatalog.retain();
  }, [communityCatalog]);
  const publications = useSyncExternalStore(
    communityCatalog?.subscribe ?? emptySubscribe,
    communityCatalog?.snapshot ?? emptyCatalogSnapshot,
    communityCatalog?.snapshot ?? emptyCatalogSnapshot,
  );
  const [selectedCoordinate, setSelectedCoordinate] = useState<string>();
  const selectedPublication = publications.teams.find(
    (entry) => `${entry.owner}:${entry.d}` === selectedCoordinate,
  );
  const alreadyAdded =
    !!selectedPublication &&
    !!catalogSession &&
    catalogAlreadyAdded(catalogSession, selectedPublication, (id) =>
      kit
        .snapshot()
        .entries.some(
          (entry) =>
            !entry.record.deleted &&
            entry.record.value.type === "team" &&
            entry.record.value.id === id,
        ),
    );
  const [catalogError, setCatalogError] = useState("");
  const [catalogBusy, setCatalogBusy] = useState(false);
  const live = useRef(true);
  useLayoutEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const nameInput = useRef<HTMLInputElement>(null);
  const state = useSyncExternalStore(kit.subscribe, kit.snapshot);
  const [draft, setDraft] = useState<Team | Template>(() =>
    structuredClone(initial),
  );
  // Instructions as saved, and the head they came from. Only an edited
  // existing team loads them; a new team starts empty with no head.
  const [saved, setSaved] = useState<{
    text: string;
    head?: string | undefined;
  }>();
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(initial.type === "team" && !!expected);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // One save attempt: its text revision and the phases it finished or
  // enqueued, so a retry confirms the same events instead of writing again.
  // Any draft edit starts a new attempt.
  const attempt = useRef(newAttempt(expected));
  // The roster as last saved, so a text-only retry never rewrites the team.
  const savedTeam = useRef(expected ? initial : undefined);
  const edit = () => {
    attempt.current = newAttempt(attempt.current.teamHead);
  };
  useEffect(() => {
    if (open) {
      kit.ensure();
    }
  }, [open, kit]);
  useEffect(() => {
    if (initial.type !== "team") return;
    if (!expected) {
      setSaved({ text: "" });
      return;
    }
    let cancelled = false;
    void resolveTeamText(kit, control, initial)
      .then((value) => {
        if (cancelled) return;
        setSaved(value);
        setText(value.text);
        setLoading(false);
      })
      .catch((reason) => {
        if (!cancelled)
          setError(
            `This team's instructions can't be read, so it can't be saved now: ${reason instanceof Error ? reason.message : String(reason)}`,
          );
      });
    return () => {
      cancelled = true;
    };
  }, [initial, expected, kit, control]);
  const save = async () => {
    if (!live.current || !active() || loading || catalogBusy) return;
    setBusy(true);
    setError("");
    const run = attempt.current;
    try {
      if (draft.type !== "team") {
        run.teamHead = await kit.save(draft, run.teamHead);
      } else {
        if (!saved) throw new Error("Team instructions are still loading");
        const base = savedTeam.current;
        const rosterChanged =
          base?.type !== "team" ||
          draft.name !== base.name ||
          draft.agents.join() !== base.agents.join();
        const textChanged = text !== saved.text;
        if (draft.portable && !draft.agents.length)
          throw new Error(
            "A team imported from a file needs at least one member.",
          );
        // Rechecked before every phase not yet enqueued, retries included:
        // other teams and this team's text can change between attempts.
        // Saving goes members first, then text, so the in-between state is
        // checked too. Enqueued phases replay their exact events instead.
        const recheck = async () => {
          if (!control) return;
          const others = await readTeamTexts(kit, control);
          if (textChanged && !run.textDone) {
            const current = await kit.readTextHead(draft.id);
            if (current?.head !== saved.head)
              throw new Error(
                "This team's instructions changed. Refresh and review them before saving.",
              );
          }
          const conflict =
            (rosterChanged &&
              !run.teamDone &&
              teamTextConflict(others, draft, saved.text)) ||
            teamTextConflict(others, draft, text);
          if (conflict) throw new Error(conflict);
        };
        if (textChanged && !run.manifest) {
          await recheck();
          run.manifest = await kit.prepareText(draft.id, text, run.revision);
        }
        if (rosterChanged && !run.teamDone) {
          if (!run.team.id) await recheck();
          run.teamHead = await kit.save(
            draft,
            run.teamHead,
            false,
            undefined,
            run.team,
          );
          run.teamDone = true;
          savedTeam.current = draft;
        }
        if (run.manifest && !run.textDone) {
          if (!run.text.id) await recheck();
          const head = await kit.publishText(
            draft.id,
            run.manifest,
            saved.head,
            run.teamHead,
            run.text,
          );
          run.textDone = true;
          setSaved({ text, head });
        }
        await deliverTeamTexts(kit, control, session);
      }
      if (live.current && active()) onOpenChange(false);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      if (live.current && active())
        setError(
          run.teamDone && run.manifest && !run.textDone
            ? `Members and name saved; instructions not saved: ${message}`
            : draft.type === "team" &&
                (run.textDone || (run.teamDone && !run.manifest))
              ? `Saved; members' instructions not updated: ${message}`
              : message,
        );
    } finally {
      if (live.current && active()) setBusy(false);
    }
  };
  return (
    <Dialog
      dismissOnOutsideClick
      open={open}
      finalFocus={finalFocus}
      onOpenChange={(next) => {
        if (!next && !catalogBusy && live.current && active())
          onOpenChange(false);
      }}
      preventClose={busy || catalogBusy}
      initialFocus={nameInput}
      title={`${expected ? "Edit" : draft.type === "team" ? "Add" : "New"} ${draft.type}`}
      description={
        draft.type === "team"
          ? "Choose agents to reuse together in future channels and @mentions. This team is private to you in this community."
          : "Save a starting setup for future channels. Applying a template copies it once; existing channels stay unchanged."
      }
      closeLabel="Close templates"
      actions={
        <>
          <Button
            disabled={busy || catalogBusy}
            onClick={() => {
              if (live.current && active()) onOpenChange(false);
            }}
          >
            Cancel
          </Button>
          <Button
            variant="prominent"
            loading={busy}
            disabled={
              !draft.name.trim() ||
              state.status !== "ready" ||
              loading ||
              catalogBusy
            }
            onClick={() => void save()}
          >
            Save {draft.type}
          </Button>
        </>
      }
    >
      <div
        className={
          onImport || catalogSession ? styles.teamAddLayout : undefined
        }
      >
        {(onImport || catalogSession) && (
          <nav aria-label="Add team" className={styles.teamAddSidebar}>
            <NavigationItem
              label="Create team"
              aria-label="Create new team"
              icon={<PlusIcon size={16} />}
              selected={!selectedCoordinate}
              disabled={catalogBusy || !!draft.name || draft.agents.length > 0}
              onClick={() => setSelectedCoordinate(undefined)}
            />
            {onImport && (
              <Button
                variant="outline"
                size="sm"
                disabled={
                  catalogBusy || !!draft.name || draft.agents.length > 0
                }
                onClick={onImport}
              >
                Import
              </Button>
            )}
            {publications.teams.length > 0 && (
              <span className="text-label text-subtle">TEAMS</span>
            )}
            {publications.teams.map((team) => (
              <NavigationItem
                key={team.eventId}
                label={team.name}
                selected={selectedCoordinate === `${team.owner}:${team.d}`}
                disabled={
                  catalogBusy || !!draft.name || draft.agents.length > 0
                }
                onClick={() => setSelectedCoordinate(`${team.owner}:${team.d}`)}
              />
            ))}
            {publications.status === "error" && (
              <p role="alert">{publications.error}</p>
            )}
          </nav>
        )}
        {selectedCoordinate ? (
          <section
            aria-label={selectedPublication?.name ?? "Withdrawn team"}
            className="team-catalog-preview"
          >
            {selectedPublication && catalogSession ? (
              <TeamCatalogPreview
                publication={selectedPublication}
                session={catalogSession}
              />
            ) : (
              <p role="status">
                This team is no longer shared. Select another team.
              </p>
            )}
            {selectedPublication &&
              unsupportedTransport(selectedPublication) && (
                <p role="note">
                  {unsupportedTransportMessage(
                    selectedPublication.name,
                    unsupportedTransport(selectedPublication) ?? "",
                  )}
                </p>
              )}
            {catalogError && <p role="alert">{catalogError}</p>}
            <Button
              variant="prominent"
              disabled={
                !selectedPublication ||
                alreadyAdded ||
                catalogBusy ||
                !!(
                  selectedPublication &&
                  unsupportedTransport(selectedPublication)
                ) ||
                !onAddCatalogTeam
              }
              onClick={() => {
                if (
                  !onAddCatalogTeam ||
                  !catalogSession ||
                  !selectedPublication ||
                  alreadyAdded ||
                  catalogBusy ||
                  !live.current ||
                  !active()
                )
                  return;
                const selected = selectedPublication;
                setCatalogBusy(true);
                setCatalogError("");
                void onAddCatalogTeam(selected)
                  .then((copy) => {
                    if (!live.current || !active()) return;
                    rememberAdded(
                      catalogSession.scope,
                      catalogSession.viewer ?? "",
                      selected,
                      copy,
                    );
                    onOpenChange(false);
                  })
                  .catch((cause) => {
                    if (live.current && active())
                      setCatalogError(
                        cause instanceof Error ? cause.message : String(cause),
                      );
                  })
                  .finally(() => {
                    if (live.current && active()) setCatalogBusy(false);
                  });
              }}
            >
              {alreadyAdded
                ? "Added to my teams"
                : catalogBusy
                  ? "Adding…"
                  : "Add team"}
            </Button>
          </section>
        ) : (
          <div className={styles.stack} inert={busy || loading}>
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
            <Field label="Name">
              <Input
                ref={nameInput}
                placeholder={
                  draft.type === "team" ? "Engineering Squad" : undefined
                }
                maxLength={120}
                value={draft.name}
                onChange={(e) => {
                  edit();
                  setDraft({ ...draft, name: e.target.value });
                }}
              />
            </Field>
            {draft.type === "team" ? (
              <>
                <Field label="Team Instructions">
                  <Textarea
                    placeholder="Optional instructions every member gets after its own."
                    value={text}
                    disabled={!saved}
                    onChange={(event) => {
                      edit();
                      setText(event.target.value);
                    }}
                  />
                </Field>
                {loading && !error && (
                  <p role="status">Loading team instructions…</p>
                )}
                <AgentSelection
                  session={session}
                  agents={agents}
                  selected={draft.agents}
                  onChange={(agents) => {
                    edit();
                    setDraft({ ...draft, agents });
                  }}
                />
              </>
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
                  session={session}
                  value={draft}
                  onChange={(value) => setDraft({ ...draft, ...value })}
                  entries={state.entries}
                  agents={agents}
                />
              </>
            )}
          </div>
        )}
      </div>
    </Dialog>
  );
}

type Attempt = {
  revision: string;
  teamHead: string | undefined;
  manifest?: Awaited<ReturnType<ChannelKit["prepareText"]>>;
  teamDone?: boolean;
  textDone?: boolean;
  team: Resume;
  text: Resume;
};
function newAttempt(teamHead: string | undefined): Attempt {
  const resume = (): Resume => ({
    enqueued(id) {
      this.id = id;
    },
  });
  return {
    revision: crypto.randomUUID(),
    teamHead,
    team: resume(),
    text: resume(),
  };
}

const emptySubscribe = () => () => {};
const emptyCatalog = { status: "unavailable" as const, agents: [], teams: [] };
const emptyCatalogSnapshot = () => emptyCatalog;
