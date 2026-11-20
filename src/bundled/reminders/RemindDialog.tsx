import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { Navigation } from "../../features/navigation/controller";
import {
  targetKey,
  withoutJoin,
  type OpenTarget,
} from "../../features/navigation/targets";
import type { RelayData } from "../../features/relay/service";
import { scopeOf } from "./react";
import type { ChannelMessage } from "../../features/relay/contracts";
import type { RelaySession } from "../../features/relay/session";
import { messagePreview } from "../../features/notifications/content";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { Field } from "../../shared/design-system/ui/Field";
import { Select } from "../../shared/design-system/ui/Select";
import { Input } from "../../shared/design-system/ui/Input";
import { Textarea } from "../../shared/design-system/ui/Textarea";
import {
  TIME_PRESETS,
  formatDue,
  parseCustomDateTime,
  shiftedFrom,
  todayDateString,
} from "./model";
import styles from "./Reminders.module.css";

const MAX_NOTE_LENGTH = 4096;

// The plugin overlay outlives the page, keeping a hidden draft and its save
// alive during Back/Forward. Only explicit dismissal or completion retires it.
export function ReminderEditor({
  relay,
  navigator,
}: {
  relay: RelayData;
  navigator: Navigation;
}) {
  const connection = useSyncExternalStore(relay.subscribe, relay.snapshot);
  const { entry } = useSyncExternalStore(
    navigator.subscribe,
    navigator.snapshot,
  );
  const session =
    connection.status === "ready" && connection.session.reminders
      ? connection.session
      : undefined;
  const currentSession = useRef(session);
  currentSession.current = session;
  const scope = scopeOf(connection);
  const target = entry.target;
  const retiredVisit = useRef<string | undefined>(undefined);
  const active =
    entry.id !== retiredVisit.current &&
    !target.join &&
    target.kind === "page" &&
    target.pluginId === "buzz.reminders" &&
    target.pageId === "reminders" &&
    target.route?.version === 1 &&
    target.route.params === "new" &&
    target.scope?.viewer === scope?.viewer &&
    target.scope?.communityOrigin === scope?.communityOrigin;
  const [draft, setDraft] = useState<{
    session: RelaySession;
    target: Extract<OpenTarget, { kind: "page" }>;
  }>();
  const retire = useCallback(
    (closing: NonNullable<typeof draft>) => {
      const { route: _, ...page } = closing.target;
      const key = targetKey(closing.target);
      const current = navigator.snapshot().entry;
      // Browser dismissal publishes its destination only after native traversal.
      if (targetKey(withoutJoin(current.target)) === key)
        retiredVisit.current = current.id;
      navigator.dismiss((visit) => targetKey(visit) === key, page);
    },
    [navigator],
  );
  useEffect(() => {
    if (draft && draft.session !== session) {
      retire(draft);
      setDraft(undefined);
    } else if (active && session && !draft && target.kind === "page") {
      setDraft({ session, target });
    }
  }, [active, session, draft, target, retire]);
  return draft && draft.session === session ? (
    <RemindDialog
      session={draft.session}
      isOpen={active && targetKey(target) === targetKey(draft.target)}
      visit
      close={() => {
        if (currentSession.current === draft.session) retire(draft);
        setDraft((current) => (current === draft ? undefined : current));
      }}
    />
  ) : null;
}

export function RemindDialog({
  message,
  session,
  close,
  isOpen = true,
  visit = false,
}: {
  message?: ChannelMessage;
  session: RelaySession;
  close(): void;
  isOpen?: boolean;
  visit?: boolean;
}) {
  const fields = useRef<HTMLDivElement>(null);
  const noteInput = useRef<HTMLTextAreaElement>(null);
  const saving = useRef(false);
  const [when, setWhen] = useState(TIME_PRESETS[0]?.label ?? "custom");
  const [note, setNote] = useState("");
  const [date, setDate] = useState(todayDateString);
  const [time, setTime] = useState("09:00");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const custom = parseCustomDateTime(date, time);
  const preset = TIME_PRESETS.find((item) => item.label === when);
  const validText = !!message || !!note.trim();
  const submit = async (notBefore: number) => {
    const reminders = session.reminders;
    if (!reminders || saving.current || !validText) return;
    saving.current = true;
    setPending(true);
    setError(undefined);
    try {
      await reminders.create(
        message
          ? {
              eventId: message.id,
              channelId: message.channelId,
              preview: messagePreview(message.content),
              authorPubkey: message.authorId,
            }
          : undefined,
        notBefore,
        note,
      );
      close();
    } catch {
      setError("The reminder could not be saved. Try again.");
      saving.current = false;
      setPending(false);
    }
  };
  const noteField = (
    <Field label={message ? "Note (optional)" : "Reminder text"}>
      <Textarea
        ref={noteInput}
        placeholder="What do you want to follow up on?"
        rows={2}
        maxLength={MAX_NOTE_LENGTH}
        required={!message}
        value={note}
        disabled={pending}
        onChange={(event) => setNote(event.target.value)}
      />
    </Field>
  );
  return (
    <Dialog
      size="compact"
      open={isOpen}
      visit={visit}
      dismissOnOutsideClick={false}
      onOpenChange={(open) => !open && close()}
      preventClose={pending}
      initialFocus={(type) =>
        type === "touch" || window.matchMedia?.("(pointer: coarse)").matches
          ? (fields.current?.closest<HTMLElement>('[role="dialog"]') ?? null)
          : message
            ? (fields.current?.querySelector<HTMLElement>(
                '[role="combobox"]',
              ) ?? null)
            : noteInput.current
      }
      title={message ? "Remind me" : "New reminder"}
      description={
        message ? "Choose when to be reminded about this message." : undefined
      }
      actions={
        <>
          <Button disabled={pending} onClick={close}>
            Cancel
          </Button>
          <Button
            variant="prominent"
            loading={pending}
            disabled={pending || !validText || (!preset && custom === null)}
            onClick={() => {
              const at = preset ? preset.at() : parseCustomDateTime(date, time);
              if (at !== null) void submit(at);
            }}
          >
            Set reminder
          </Button>
        </>
      }
    >
      <div ref={fields} className={styles.form}>
        {!message && noteField}
        <Select
          label="When"
          variant="field"
          value={when}
          disabled={pending}
          onValueChange={setWhen}
          groups={[
            {
              label: "",
              options: [
                ...TIME_PRESETS.map((item) => ({
                  value: item.label,
                  label: item.label,
                })),
                { value: "custom", label: "Custom date & time" },
              ],
            },
          ]}
        />
        {when === "custom" && (
          <>
            <div className={styles.custom}>
              <Field label="Reminder date">
                <Input
                  type="date"
                  min={todayDateString()}
                  value={date}
                  disabled={pending}
                  onChange={(event) => setDate(event.target.value)}
                />
              </Field>
              <Field label="Reminder time">
                <Input
                  type="time"
                  value={time}
                  disabled={pending}
                  onChange={(event) => setTime(event.target.value)}
                />
              </Field>
            </div>
            {custom === null && (
              <p role="status" className="text-body-sm text-subtle">
                Choose a date and time in the future.
              </p>
            )}
            {custom !== null && shiftedFrom(time, custom) && (
              <p role="status" className="text-body-sm text-subtle">
                That time is skipped by daylight saving. The reminder will be
                set for {formatDue(custom)}.
              </p>
            )}
          </>
        )}
        {message && noteField}
        {error && (
          <p role="alert" className="text-body text-subtle">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
