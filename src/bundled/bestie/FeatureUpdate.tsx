import { type ReactNode, useEffect, useReducer, useState } from "react";
import type { Agent } from "../../features/agents/service";
import { Button } from "../../shared/design-system/ui/Button";
import { Checkbox } from "../../shared/design-system/ui/Checkbox";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { PreferenceRow } from "../../shared/design-system/ui/PreferenceRow";
import { CanvasDiff } from "../channels/CanvasDiff";
import {
  type Feature,
  interestSection,
  interestState,
  shippedSteps,
  updatedInterest,
} from "./features";
import type { FeatureAgents } from "./save";
import {
  acceptedVersion,
  adopted,
  adoptPlan,
  applyInterest,
  bytes,
  DriftError,
  INTEREST_LIMIT,
  type InterestOp,
  keep,
  liveInterest,
  type Receipt,
  type Receipts,
  recover,
  type ShownInterest,
  undoable,
} from "./updates";

type Review = "changes" | "compare" | "restore" | "adopt" | "review";
/** An open dialog, and the Interest it opened on: what it shows, and what
 * it saves over only if that is still there. */
type Open = { shown: ShownInterest } & (
  | { kind: Review }
  | { kind: "drift"; receipt: Receipt }
);

const kb = (text: string) => `${(bytes(text) / 1024).toFixed(1)} KB`;
const date = (at: number) =>
  new Date(at).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });

function Diff({
  from,
  to,
  label,
}: {
  from: string;
  to: string;
  label: string;
}) {
  return (
    <section className="grid gap-2">
      <h3 className="text-label">{label}</h3>
      <CanvasDiff
        current={from}
        revision={to}
        fallback={(note) => (
          <>
            <p>{note}</p>
            <pre className="whitespace-pre-wrap">{to}</pre>
          </>
        )}
      />
    </section>
  );
}

/** Under a marked check-in's switch: whether a newer version of its
 * Interest is ready, and what the owner did about it on this device.
 * Nothing changes until they choose to; each change keeps a backup here
 * that Undo puts back. */
export function FeatureUpdate({
  agents,
  agent,
  feature,
  receipts,
  saving,
  run,
  error,
  clearError,
}: {
  agents: FeatureAgents;
  agent: Agent;
  feature: Feature;
  receipts: Receipts;
  saving: boolean;
  run(task: () => Promise<void>): Promise<void>;
  /** Why the last save failed, shown in the dialog it was made from. */
  error?: string | undefined;
  /** Forgets that, as a dialog opens: an earlier failure isn't its own. */
  clearError(): void;
}) {
  const [open, setOpen] = useState<Open>();
  // The additions left unchecked, by their text: the plan is worked out
  // again on each draw.
  const [dropped, setDropped] = useState<readonly string[]>([]);
  // Receipts are on this device, not in the agent: a change to them alone
  // shows by drawing again.
  const [, touched] = useReducer((count: number) => count + 1, 0);
  const object = liveInterest(agent, feature);
  const live = object?.value.instructions;
  // A save left unsettled, by a crash or a lost answer, settles from what
  // the Interest holds now.
  useEffect(() => {
    if (live === undefined) return;
    recover(receipts, feature, agent);
    touched();
  }, [live, receipts, feature, agent]);
  if (!object || live === undefined) return null;
  const view = (kind: Review) => {
    clearError();
    setOpen({ kind, shown: object });
  };
  const latest = feature.version;
  const state = interestState(live, feature);
  const notes = feature.timer?.changes?.[latest]?.notes ?? [];
  const reach = feature.timer?.changes?.[latest]?.class === "reach";
  const latestSteps = shippedSteps(feature, latest) ?? "";
  const last = undoable(receipts, feature);
  const hidden = receipts.hidden(feature.id, latest);
  const close = () => {
    setOpen(undefined);
    setDropped([]);
  };
  const apply = (op: InterestOp, shown: ShownInterest = object) =>
    run(async () => {
      try {
        await applyInterest(agents, agent, feature, op, receipts, shown);
        close();
      } catch (cause) {
        if (cause instanceof DriftError && op.action === "undo")
          return setOpen({
            kind: "drift",
            receipt: op.receipt,
            shown: cause.live,
          });
        throw cause;
      } finally {
        touched();
      }
    });
  /** One line: what the steps are now, and its one action. */
  const status = (title: string, action: ReactNode) => (
    <PreferenceRow title={title} trailing={action} />
  );
  const hide = (later: boolean) => {
    receipts.hide(feature.id, latest, later);
    touched();
  };
  // An offer kept as is or put off reads as one line until Review shows it
  // again.
  const put = status(
    `Version ${latest} of ${feature.title} is available`,
    <Button
      variant="outline"
      onClick={() => {
        receipts.show(feature.id);
        touched();
      }}
    >
      Review
    </Button>,
  );
  const offer = (
    title: string,
    subtitle: string | undefined,
    review: Review,
    reviewLabel: string,
    later: boolean,
  ) =>
    hidden ? (
      put
    ) : (
      // An offer's text is the owner's reason to choose, so its actions go
      // below it: beside it, two or three buttons would leave the title and
      // summary a few letters wide in the agent panel.
      <fieldset aria-label={title} className="m-0 min-w-0 p-0">
        <PreferenceRow title={title} subtitle={subtitle} />
        <div className="flex flex-wrap gap-2 pb-3">
          <Button variant="outline" onClick={() => hide(later)}>
            {later ? "Later" : "Keep as is"}
          </Button>
          <Button
            variant={review === "changes" ? "outline" : "prominent"}
            disabled={saving}
            onClick={() => view(review)}
          >
            {reviewLabel}
          </Button>
          {review === "changes" && (
            <Button
              variant="prominent"
              disabled={saving}
              onClick={() => void apply({ action: "update" })}
            >
              Update
            </Button>
          )}
        </div>
      </fieldset>
    );
  let row: ReactNode = null;
  // A newer Buzz's version has nothing this build can do to it.
  if (state.state === "ahead")
    row = (
      <PreferenceRow
        title={`${feature.title} is version ${state.version}`}
        subtitle="Set by a newer Buzz. Update Buzz to change it here."
      />
    );
  else if (last?.status === "unresolved")
    row = (
      <PreferenceRow
        title={`${feature.title} changed while an update was being saved`}
        subtitle="Review it, put back what was there before, or keep it as it is now."
        trailing={
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              onClick={() =>
                void run(async () => keep(receipts, feature)).finally(touched)
              }
            >
              Keep current
            </Button>
            <Button variant="prominent" onClick={() => view("review")}>
              Review
            </Button>
          </div>
        }
      />
    );
  // Steps set up by hand, or whose start or end line changed, read as one
  // line under the switch with Review. Its dialog says what Review keeps,
  // and has Keep as is.
  else if (state.state === "untracked" || state.state === "edited-markers")
    row = hidden
      ? put
      : status(
          `${state.state === "untracked" ? "Customized" : "Start or end line changed"} · version ${latest} available`,
          <Button
            variant="outline"
            disabled={saving}
            onClick={() => view("adopt")}
          >
            Review
          </Button>,
        );
  else if (state.state === "stock-old")
    row = offer(
      `Version ${latest} of ${feature.title} is ready`,
      `${reach ? "Bestie will now: " : ""}${notes.join(" ")}`,
      "changes",
      "See changes",
      true,
    );
  else if (state.state === "customized-old")
    row = offer(
      `${feature.title} has changed since version ${state.version}. Version ${latest} is available.`,
      undefined,
      "compare",
      "Compare",
      false,
    );
  else if (state.state === "customized-latest")
    row = status(
      `${feature.title} has changed since version ${latest}`,
      <Button
        variant="outline"
        disabled={saving}
        onClick={() => view("restore")}
      >
        Restore version {latest}
      </Button>,
    );
  const accepted = acceptedVersion(receipts, feature, live);
  // What was saved here last, with the way back. After an Undo it can hold
  // text no offer rebuilds, such as lines added after an update, so it
  // stays.
  const name = (label: string) =>
    label === "untracked" ? "your earlier text" : `version ${label.slice(1)}`;
  const undid = last?.action === "undo";
  const saved =
    state.state === "ahead" ? null : last?.status === "applied" ? (
      <PreferenceRow
        title={
          undid
            ? `Undid ${name(last.from)} · ${date(last.at)}`
            : `Saved ${name(last.to)} · ${date(last.at)}`
        }
        subtitle={
          undid
            ? "The text before the Undo is kept on this device."
            : "The text before is kept on this device."
        }
        trailing={
          <Button
            variant="outline"
            disabled={saving}
            onClick={() => void apply({ action: "undo", receipt: last })}
          >
            {undid ? "Restore previous text" : "Undo"}
          </Button>
        }
      />
    ) : state.state === "current" && !accepted ? (
      <PreferenceRow
        title={`${feature.title} is version ${latest}`}
        subtitle="Not accepted on this device: it wasn't saved here from this tab."
      />
    ) : null;
  // A dialog shows, and saves over, the Interest it opened on.
  const text = open?.shown.value.instructions ?? live;
  const shownState = interestState(text, feature);
  const from = "version" in shownState ? shownState.version : undefined;
  const steps = interestSection(text, feature)?.inside.trim() ?? text;
  const stale = !!open && JSON.stringify(open.shown) !== JSON.stringify(object);
  const ahead = shownState.state === "ahead";
  const plan = open?.kind === "adopt" ? adoptPlan(text, feature) : undefined;
  const additions = plan?.parts.filter(({ kind }) => kind === "addition") ?? [];
  const differences =
    plan?.parts.filter(({ kind }) => kind === "difference") ?? [];
  const kept = additions.filter(({ text }) => !dropped.includes(text));
  const result =
    open?.kind === "adopt"
      ? adopted(feature, kept)
      : updatedInterest(text, feature);
  const tooLong =
    open?.kind !== "drift" &&
    open?.kind !== "review" &&
    bytes(result) > INTEREST_LIMIT;
  const base = from === undefined ? "" : (shippedSteps(feature, from) ?? "");
  const take = (label: string, op: InterestOp) => (
    <>
      <Button onClick={close}>Cancel</Button>
      <Button
        variant="prominent"
        loading={saving}
        disabled={tooLong || stale || ahead}
        onClick={() => open && void apply(op, open.shown)}
      >
        {label}
      </Button>
    </>
  );
  // What every dialog ends with: whether the Interest changed since it
  // opened, and why a save failed.
  const footer = (
    <>
      {stale && (
        <p>
          {feature.title} changed after this opened, so this can't be saved.{" "}
          <Button variant="outline" onClick={close}>
            Show the latest
          </Button>
        </p>
      )}
      {error && (
        <p role="alert" className="buzz-field-error">
          {error}
        </p>
      )}
    </>
  );
  const dialog = !open ? null : open.kind === "drift" ? (
    <Dialog
      size="expanded"
      open
      onOpenChange={close}
      title={`${feature.title} has changed since you updated it`}
      description="Undo puts back the text before your update and drops these changes."
      preventClose={saving}
      actions={take("Undo anyway", {
        action: "undo",
        receipt: open.receipt,
        anyway: true,
      })}
    >
      <Diff
        label="Now → before your update"
        from={text}
        to={open.receipt.before?.instructions ?? ""}
      />
      {footer}
    </Dialog>
  ) : open.kind === "review" && last ? (
    <Dialog
      size="expanded"
      open
      onOpenChange={close}
      title={`${feature.title} changed while an update was being saved`}
      description="Restore backup puts back the text before the update. Its pause stays as it is."
      preventClose={saving}
      actions={take("Restore backup", {
        action: "undo",
        receipt: last,
        anyway: true,
      })}
    >
      <Diff
        label="Now → before the update"
        from={text}
        to={last.before?.instructions ?? ""}
      />
      <Diff label="Now → the update" from={text} to={last.after.instructions} />
      {footer}
    </Dialog>
  ) : (
    <Dialog
      size="expanded"
      open
      onOpenChange={close}
      title={
        open.kind === "restore"
          ? `Restore version ${latest} of ${feature.title}?`
          : `${feature.title}: ${from === undefined ? "customized" : `version ${from}`} → ${latest}`
      }
      description={`${notes.join(" ")} Its schedule doesn't change. The current text is kept on this device, and Undo puts it back.`}
      preventClose={saving}
      actions={
        open.kind === "adopt" ? (
          <>
            {/* Its row has one action, Review, so keeping the steps as they
                are is chosen here: the offer stays hidden until a newer
                version. */}
            <Button
              disabled={saving}
              onClick={() => {
                hide(false);
                close();
              }}
            >
              Keep as is
            </Button>
            {take(`Use version ${latest}`, { action: "adopt", text: result })}
          </>
        ) : open.kind === "restore" ? (
          take(`Restore version ${latest}`, { action: "restore" })
        ) : (
          take(
            open.kind === "compare"
              ? `Take version ${latest}`
              : `Update to version ${latest}`,
            { action: "update" },
          )
        )
      }
    >
      {plan && (
        <section className="grid gap-2">
          <p>
            {shownState.state === "edited-markers"
              ? `Its start or end line was changed. Version ${latest} puts its steps back between their lines.`
              : `Closest to version ${plan.closest}.`}
          </p>
          {additions.length > 0 && (
            <h3 className="text-label">Lines to keep after version {latest}</h3>
          )}
          {additions.map((part) => (
            <Checkbox
              key={part.text}
              checked={!dropped.includes(part.text)}
              onCheckedChange={(on) =>
                setDropped(
                  on
                    ? dropped.filter((text) => text !== part.text)
                    : [...dropped, part.text],
                )
              }
              label={<span className="whitespace-pre-wrap">{part.text}</span>}
            />
          ))}
          {differences.length > 0 && (
            <h3 className="text-label">
              Differs from version {plan.closest}. Version {latest}'s text will
              be used here
            </h3>
          )}
          {differences.map((part) => (
            <div key={part.text} className="grid gap-1">
              <pre className="whitespace-pre-wrap">
                Version {plan.closest}: {part.text}
              </pre>
              {part.yours && (
                <pre className="whitespace-pre-wrap">
                  Your text here, which will be replaced: {part.yours}
                </pre>
              )}
            </div>
          ))}
        </section>
      )}
      {plan && (
        <Diff
          label={`Now → version ${latest} with the lines you keep`}
          from={text}
          to={result}
        />
      )}
      {open.kind === "changes" && (
        <Diff
          label={`What version ${latest} changes`}
          from={base}
          to={latestSteps}
        />
      )}
      {open.kind === "compare" && (
        <>
          <Diff
            label={`What Buzz changed: version ${from} → ${latest}`}
            from={base}
            to={latestSteps}
          />
          <Diff
            label={`Changed since version ${from}`}
            from={base}
            to={steps}
          />
          <p>
            The result is version {latest} with the lines outside its markers.
            The changes between them are kept on this device.
          </p>
        </>
      )}
      {open.kind === "restore" && (
        <Diff label={`Now → version ${latest}`} from={steps} to={latestSteps} />
      )}
      <p role={tooLong ? "alert" : undefined}>
        {tooLong
          ? `This would make ${feature.title} too long to save (${kb(result)} of 16 KB). Remove some kept lines first.`
          : `Result: ${kb(result)} of 16 KB.`}
      </p>
      {footer}
    </Dialog>
  );
  return (
    <>
      {row}
      {saved}
      {dialog}
    </>
  );
}
