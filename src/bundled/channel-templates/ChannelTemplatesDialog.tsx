import type { RelaySession } from "../../features/relay/session";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { ChannelKit } from "../../features/channel-templates/capability";
import type {
  AgentChoice,
  Team,
  Template,
} from "../../features/channel-templates/model";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog, type DialogProps } from "../../shared/design-system/ui/Dialog";
import { Field } from "../../shared/design-system/ui/Field";
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
  expected,
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
  initial: Team | Template;
  expected?: string | undefined;
  notice?: string | undefined;
}) {
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (open) {
      kit.ensure();
    }
  }, [open, kit]);
  const save = async () => {
    if (!live.current || !active()) return;
    setBusy(true);
    setError("");
    try {
      await kit.save(draft, expected);
      if (live.current && active()) onOpenChange(false);
    } catch (reason) {
      if (live.current && active())
        setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (live.current && active()) setBusy(false);
    }
  };
  return (
    <Dialog
      dismissOnOutsideClick
      open={open}
      finalFocus={finalFocus}
      onOpenChange={onOpenChange}
      preventClose={busy}
      initialFocus={nameInput}
      title={`${expected ? "Edit" : "New"} ${draft.type}`}
      description={
        draft.type === "team"
          ? "Choose agents to reuse together in future channels and @mentions. This team is private to you in this community."
          : "Save a starting setup for future channels. Applying a template copies it once; existing channels stay unchanged."
      }
      closeLabel="Close templates"
      actions={
        <>
          <Button disabled={busy} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="prominent"
            loading={busy}
            disabled={!draft.name.trim() || state.status !== "ready"}
            onClick={() => void save()}
          >
            Save {draft.type}
          </Button>
        </>
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
              session={session}
              value={draft}
              onChange={(value) => setDraft({ ...draft, ...value })}
              entries={state.entries}
              agents={agents}
            />
          </>
        )}
      </div>
    </Dialog>
  );
}
