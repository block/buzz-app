import { useState } from "react";
import type { ChannelMessage } from "../../features/relay/contracts";
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

export function DecisionDialog({
  scope,
  message,
  record,
  expectedRevision,
  current,
  close,
}: {
  scope: string;
  message?: ChannelMessage;
  record?: Decision;
  expectedRevision?: string | null | undefined;
  current(): boolean;
  close(): void;
}) {
  const [expected] = useState(() =>
    expectedRevision === undefined ? revision(scope) : expectedRevision,
  );
  const [question, setQuestion] = useState(record?.question ?? "");
  const [nextActor, setNextActor] = useState(record?.nextActor ?? "");
  const [decision, setDecision] = useState(record?.decision ?? "");
  const [stage, setStage] = useState<Stage>(record?.stage ?? "decision");
  const [error, setError] = useState("");
  const [confirmDiscard, setConfirmDiscard] = useState(false);
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
  const requestClose = () => {
    if (confirmDiscard) setConfirmDiscard(false);
    else if (dirty) setConfirmDiscard(true);
    else close();
  };
  const submit = () => {
    if (!valid || duplicate || (!record && !message)) return;
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
    const result = save(scope, expected, next);
    if (result === "saved") close();
    else if (result === "changed")
      setError(
        "The saved list changed in another window. Close and reopen this item to review the latest version.",
      );
    else if (result === "full")
      setError(
        "Decision Inbox is full. Remove a saved item before trying again.",
      );
    else
      setError(
        result === "damaged"
          ? "The saved list cannot be read. Open Decision Inbox to recover it."
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
          : "Saved on this device for this account and community."
      }
      onOpenChange={(open) => !open && requestClose()}
      actions={
        confirmDiscard ? (
          <>
            <Button onClick={() => setConfirmDiscard(false)}>
              Keep editing
            </Button>
            <Button variant="destructive" onClick={close}>
              Discard changes
            </Button>
          </>
        ) : (
          <>
            <Button onClick={requestClose}>Cancel</Button>
            {!duplicate && saved.status === "ready" && (
              <Button variant="prominent" disabled={!valid} onClick={submit}>
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
              {messagePreview(message.content).slice(0, 160) ||
                "Message without text"}
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
                  onChange={(event) => setQuestion(event.target.value)}
                />
              </Field>
              <Field
                label="Next actor"
                description="Who should act after the decision?"
              >
                <Input
                  value={nextActor}
                  maxLength={200}
                  onChange={(event) => setNextActor(event.target.value)}
                />
              </Field>
              {!message && (
                <>
                  <Field label="Decision" optional>
                    <Textarea
                      value={decision}
                      maxLength={2000}
                      onChange={(event) => setDecision(event.target.value)}
                    />
                  </Field>
                  <Select
                    label="Status"
                    variant="field"
                    value={stage}
                    onValueChange={(value) => setStage(value as Stage)}
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
