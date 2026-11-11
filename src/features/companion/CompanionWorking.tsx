import { useMemo } from "react";
import type { CompanionWorkingAgent, StopOutcome } from "../popout/thread";
import { useWorkStops } from "../agents/use-work-stops";
import type { WorkStop } from "../agents/work-stop";
import { AgentResponsePreview } from "../messages/AgentResponsePreview";
import {
  ActivityStepPreview,
  activityStepLabel,
} from "../messages/ActivityStepPreview";
import { AgentChooser } from "../messages/AgentChooser";
import { AgentActivityRow } from "../agents/AgentActivityRow";
import { NavigationCard } from "../../shared/design-system/ui/NavigationItem";
import { Button } from "../../shared/design-system/ui/Button";
import { OctagonIcon } from "../../shared/design-system/icons";
import styles from "./CompanionWorking.module.css";

/** The agents at work in a companion window's conversation, as main's
 * response preview shows them: one incoming-message placeholder for the
 * first agent (every working agent in its avatar group) whose current step
 * is the cue into main's "Working now" chooser, with a row per agent and the
 * Stop controls main would offer. Stopping is admitted in main (`stop`),
 * which refuses work that has already ended, and tracked here by main's own
 * `useWorkStops`: toasts, the bounded wait for hosted work to end, and
 * retry. Activity opens in the main window. */
export function CompanionWorking({
  working,
  layout,
  previousAuthor,
  stop,
  openActivity,
}: {
  working: readonly CompanionWorkingAgent[];
  layout: "timeline" | "thread";
  /** The author of the last shown row: the preview stacks under its own. */
  previousAuthor?: string | undefined;
  /** Main's Stop for a control, answering as its interrupt does. */
  stop(key: string): Promise<StopOutcome>;
  openActivity?: ((target: string) => boolean) | undefined;
}) {
  // Main's own Stop state owner: pending until a lifecycle stop answers or
  // hosted work reports nothing running; otherwise a bounded wait for its
  // end, then "hasn't stopped yet". Controls are keyed as main keys them.
  const controls = useMemo<WorkStop[]>(
    () =>
      working.flatMap((agent) =>
        agent.stops.map((control) => ({
          key: control.key,
          lifecycle: control.lifecycle,
          // `useWorkStops` reads `false` as "nothing was running"; a
          // lifecycle stop and an unknown answer both resolve as done.
          interrupt: (): Promise<boolean> =>
            stop(control.key).then((outcome) => outcome.running !== false),
        })),
      ),
    [working, stop],
  );
  const { pending, stop: request } = useWorkStops(controls);
  const first = working[0];
  if (!first) return null;
  const visibleStep = activityStepLabel(first.step);
  const stopButton = (
    agent: CompanionWorkingAgent,
    control: CompanionWorkingAgent["stops"][number],
  ) => {
    const live = controls.find((c) => c.key === control.key);
    return (
      <span className={styles.stopAction}>
        <Button
          size="sm"
          variant="plain"
          aria-label={control.label}
          loading={pending.has(control.key)}
          onClick={() => {
            if (live) void request(live, agent.name);
          }}
        >
          <OctagonIcon className={styles.stopIcon} aria-hidden="true" />
          {pending.has(control.key) ? "Stopping…" : "Stop"}
        </Button>
      </span>
    );
  };
  return (
    <div className={styles.working} data-conversation-activity="">
      <AgentResponsePreview
        name={first.name}
        picture={first.picture ?? undefined}
        participants={working.map((agent) => ({
          id: agent.id,
          name: agent.name,
          picture: agent.picture ?? undefined,
        }))}
        layout={layout}
        stackPrevious={previousAuthor === first.id}
      >
        <AgentChooser
          label={
            visibleStep ||
            (working.length === 1
              ? `Activity: ${first.name} working`
              : `Activity: ${working.length} agents working`)
          }
          content={
            <ActivityStepPreview state={first.state} text={first.step} />
          }
          openTarget={openActivity}
          directTarget={openActivity ? first.activity : undefined}
        >
          {(navigate) =>
            working.flatMap((agent) => {
              const row = (
                <AgentActivityRow
                  name={agent.name}
                  picture={agent.picture ?? undefined}
                  status={agent.status}
                  scope={agent.scope}
                  openLabel={`View ${agent.name} activity`}
                  onOpen={
                    agent.activity && openActivity
                      ? () => navigate(agent.activity ?? "")
                      : undefined
                  }
                />
              );
              if (!agent.stops.length) return <div key={agent.id}>{row}</div>;
              return agent.stops.map((control) => (
                <NavigationCard key={control.key}>
                  {row}
                  {stopButton(agent, control)}
                </NavigationCard>
              ));
            })
          }
        </AgentChooser>
      </AgentResponsePreview>
    </div>
  );
}
