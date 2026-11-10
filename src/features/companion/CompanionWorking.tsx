import { useEffect, useRef, useState } from "react";
import type { CompanionWorkingAgent } from "../popout/thread";
import { AgentResponsePreview } from "../messages/AgentResponsePreview";
import { ActivityStepPreview } from "../messages/ActivityStepPreview";
import { AgentActivityRow } from "../agents/AgentActivityRow";
import { Button } from "../../shared/design-system/ui/Button";
import { OctagonIcon } from "../../shared/design-system/icons";
import styles from "./CompanionWorking.module.css";

/** The agents at work in a companion window's conversation, as main's
 * response preview shows them: one incoming-message placeholder for the
 * first agent (every working agent in its avatar group), the current step,
 * and a row per agent with the Stop controls main would offer. Stopping is
 * admitted in main (`stop`), which refuses work that has already ended; the
 * control shows "Stopping…" until the next projection drops it or the
 * request fails. Activity opens in the main window. */
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
  stop(key: string): Promise<unknown>;
  openActivity?: ((target: string) => boolean) | undefined;
}) {
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [failed, setFailed] = useState<string>();
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  // A control that left the projection is no longer pending here.
  const live = working.flatMap((agent) => agent.stops.map((s) => s.key));
  const liveKey = live.join("\n");
  useEffect(() => {
    const keys = new Set(liveKey.split("\n"));
    setPending((prior) => {
      const next = new Set([...prior].filter((key) => keys.has(key)));
      return next.size === prior.size ? prior : next;
    });
  }, [liveKey]);
  const first = working[0];
  if (!first) return null;
  const request = (key: string, name: string) => {
    setFailed(undefined);
    setPending((prior) => new Set(prior).add(key));
    void stop(key).catch((cause: unknown) => {
      if (!mounted.current) return;
      setPending((prior) => {
        const next = new Set(prior);
        next.delete(key);
        return next;
      });
      setFailed(
        cause instanceof Error && cause.message
          ? cause.message
          : `Couldn’t stop ${name}.`,
      );
    });
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
        <ActivityStepPreview state={first.state} text={first.step} />
        <div className={styles.agents}>
          {working.map((agent) => (
            <div key={agent.id} className={styles.agent}>
              <AgentActivityRow
                name={agent.name}
                picture={agent.picture ?? undefined}
                status={agent.status}
                scope={agent.scope}
                openLabel={`View ${agent.name} activity`}
                onOpenActivity={
                  agent.activity && openActivity
                    ? () => void openActivity(agent.activity ?? "")
                    : undefined
                }
              />
              {agent.stops.map((control) => (
                <span key={control.key} className={styles.stop}>
                  <Button
                    size="sm"
                    variant="plain"
                    aria-label={control.label}
                    loading={pending.has(control.key)}
                    onClick={() => request(control.key, agent.name)}
                  >
                    <OctagonIcon
                      className={styles.stopIcon}
                      aria-hidden="true"
                    />
                    {pending.has(control.key) ? "Stopping…" : "Stop"}
                  </Button>
                </span>
              ))}
            </div>
          ))}
        </div>
      </AgentResponsePreview>
      {failed && (
        <p role="alert" className="text-caption">
          {failed}
        </p>
      )}
    </div>
  );
}
