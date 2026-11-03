import { useEffect, useRef, useState } from "react";
import type { ChannelMessage } from "../../features/relay/contracts";
import type { RelayData } from "../../features/relay/service";
import { messagePreview } from "../../features/notifications/content";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import { Select } from "../../shared/design-system/ui/Select";
import { Textarea } from "../../shared/design-system/ui/Textarea";
import {
  capture,
  readList,
  revision,
  save,
  sourceKey,
  type Decision,
  type Stage,
} from "./model";
import styles from "./DecisionInbox.module.css";

const stages = [
  { value: "decision", label: "Awaiting your decision" },
  { value: "handoff", label: "Decision made · awaiting handoff" },
  { value: "done", label: "Handed off · done" },
];

type Draft = {
  expected: string | null | undefined;
  question: string;
  nextActor: string;
  decision: string;
  stage: Stage;
};
const drafts = new WeakMap<RelayData, Map<string, Draft>>();
function draftStore(relay: RelayData) {
  let store = drafts.get(relay);
  if (!store) {
    store = new Map();
    drafts.set(relay, store);
  }
  return store;
}

export function DecisionDialog({
  relay,
  scope,
  message,
  record,
  expectedRevision,
  current,
  close,
}: {
  relay: RelayData;
  scope: string;
  message?: ChannelMessage;
  record?: Decision;
  expectedRevision?: string | null | undefined;
  current(): boolean;
  close(): void;
}) {
  const draftKey = JSON.stringify([
    scope,
    message ? "capture" : "edit",
    (message ?? record)?.channelId,
    message?.id ?? record?.messageId,
  ]);
  const [draft, setDraft] = useState<Draft>(
    () =>
      draftStore(relay).get(draftKey) ?? {
        expected:
          expectedRevision === undefined ? revision(scope) : expectedRevision,
        question: record?.question ?? "",
        nextActor: record?.nextActor ?? "",
        decision: record?.decision ?? "",
        stage: record?.stage ?? "decision",
      },
  );
  const draftRef = useRef(draft);
  const { expected, question, nextActor, decision, stage } = draft;
  const change = (patch: Partial<Draft>) => {
    const next = { ...draftRef.current, ...patch };
    draftRef.current = next;
    draftStore(relay).set(draftKey, next);
    setDraft(next);
  };
  const [error, setError] = useState("");
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [busy, setBusy] = useState(false);
  const saved = readList(expected);
  const duplicate =
    message && saved.status === "ready"
      ? saved.records.some(
          (item) =>
            sourceKey(item) ===
            sourceKey({ channelId: message.channelId, messageId: message.id }),
        )
      : false;
  const valid =
    question.trim().length > 0 &&
    nextActor.trim().length > 0 &&
    (stage === "decision" || decision.trim().length > 0);
  const dirty =
    question !== (record?.question ?? "") ||
    nextActor !== (record?.nextActor ?? "") ||
    decision !== (record?.decision ?? "") ||
    stage !== (record?.stage ?? "decision");
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  const requestClose = () => {
    if (busy) return;
    if (confirmDiscard) setConfirmDiscard(false);
    else if (dirty) setConfirmDiscard(true);
    else close();
  };
  const submit = async () => {
    if (busy || !valid || duplicate || (!record && !message)) return;
    if (!current()) {
      setError("The account or community changed. Reopen this item there.");
      return;
    }
    if (saved.status !== "ready") {
      setError(
        "The saved list cannot be read. Open Decision Inbox to recover it.",
      );
      return;
    }
    const next: Decision | undefined = record
      ? {
          ...record,
          question: question.trim(),
          nextActor: nextActor.trim(),
          decision: decision.trim(),
          stage,
        }
      : message
        ? {
            ...capture(message, question, nextActor),
            decision: decision.trim(),
            stage,
          }
        : undefined;
    if (!next) return;
    setBusy(true);
    const result = await save(scope, expected, next, current);
    setBusy(false);
    if (result === "saved") {
      draftStore(relay).delete(draftKey);
      close();
    } else if (result === "changed")
      setError(
        `The saved list changed in another window. Your edits are still here. Copy them if needed, then discard this draft and reopen ${message ? "the message" : "the item"}.`,
      );
    else if (result === "full")
      setError(
        "Decision Inbox is full. Remove a saved item before trying again.",
      );
    else if (result === "scope-changed")
      setError("The account or community changed. Reopen this item there.");
    else
      setError(
        result === "damaged"
          ? "The saved list cannot be read. Open Decision Inbox to recover it."
          : result === "unavailable"
            ? "This device cannot safely save decisions from multiple windows."
            : "Could not save on this device. Check available storage and try again.",
      );
  };
  return (
    <Dialog
      open
      size="compact"
      step={
        confirmDiscard
          ? { key: "discard", scale: 0.95 }
          : { key: "decision", scale: 1.05 }
      }
      title={
        confirmDiscard
          ? "Discard changes?"
          : message
            ? "Save to Decision Inbox"
            : "Update decision"
      }
      description={
        confirmDiscard
          ? "Your decision has unsaved changes."
          : message
            ? "Saved on this device for this account and community. If you change pages, reopen this message to continue editing."
            : "Saved on this device for this account and community. If you change pages, reopen this item to continue editing."
      }
      onOpenChange={(open) => !open && requestClose()}
      actions={
        confirmDiscard ? (
          <>
            <Button onClick={() => setConfirmDiscard(false)}>
              Keep editing
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                draftStore(relay).delete(draftKey);
                close();
              }}
            >
              Discard changes
            </Button>
          </>
        ) : (
          <>
            <Button disabled={busy} onClick={requestClose}>
              Cancel
            </Button>
            {!duplicate && saved.status === "ready" && (
              <Button
                variant="prominent"
                disabled={!valid || busy}
                onClick={submit}
              >
                Save
              </Button>
            )}
          </>
        )
      }
    >
      {confirmDiscard ? (
        <p className="text-body">Keep editing or discard your changes.</p>
      ) : (
        <div className={styles.form}>
          {message && (
            <p className="text-body-sm text-subtle">
              Source:{" "}
              {Array.from(messagePreview(message.content))
                .slice(0, 160)
                .join("") || "Message without text"}
            </p>
          )}
          {duplicate ? (
            <p role="status">This message is already in Decision Inbox.</p>
          ) : saved.status !== "ready" ? (
            <p role="alert">
              The saved list cannot be read. Open Decision Inbox to recover it.
            </p>
          ) : (
            <>
              <Field label="Question or decision needed">
                <Textarea
                  value={question}
                  maxLength={1000}
                  onChange={(event) => change({ question: event.target.value })}
                />
              </Field>
              <Field
                label="Next actor"
                description="Who should act after the decision?"
              >
                <Input
                  value={nextActor}
                  maxLength={200}
                  onChange={(event) =>
                    change({ nextActor: event.target.value })
                  }
                />
              </Field>
              {!message && (
                <>
                  <Field label="Decision" optional>
                    <Textarea
                      value={decision}
                      maxLength={2000}
                      onChange={(event) =>
                        change({ decision: event.target.value })
                      }
                    />
                  </Field>
                  <Select
                    label="Status"
                    variant="field"
                    value={stage}
                    onValueChange={(value) => change({ stage: value as Stage })}
                    groups={[{ label: "", options: stages }]}
                  />
                  {stage !== "decision" && !decision.trim() && (
                    <p role="status" className="text-body-sm text-subtle">
                      Add the decision before moving this item forward.
                    </p>
                  )}
                </>
              )}
            </>
          )}
          {error && (
            <p role="alert" className={styles.notice}>
              {error}
            </p>
          )}
        </div>
      )}
    </Dialog>
  );
}
