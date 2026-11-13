import { useEffect, useState } from "react";
import type { Agent, Agents } from "../../features/agents/service";
import { settingsTarget } from "../../features/navigation/buzz-links";
import type { Navigation } from "../../features/navigation/controller";
import { Button } from "../../shared/design-system/ui/Button";
import { PreferenceRow } from "../../shared/design-system/ui/PreferenceRow";
import { costText } from "../usage/format";
import { COST_DAYS, readsUsage, type WeekCost, weekCost } from "./cost";

const BAR = 4;
const GAP = 2;
const HEIGHT = 20;
const day = (start: number) =>
  new Date(start).toLocaleDateString(undefined, {
    weekday: "short",
  });

/** A bar per day, tallest the costliest day; the figures are in its label. */
function Sparkline({ week }: { week: WeekCost }) {
  const top = Math.max(...week.days.map((entry) => entry.cost.value ?? 0), 0);
  return (
    <svg
      role="img"
      aria-label={`Daily cost, oldest first: ${week.days
        .map((entry) => `${day(entry.start)} ${costText(entry.cost)}`)
        .join(", ")}`}
      width={COST_DAYS * (BAR + GAP) - GAP}
      height={HEIGHT}
    >
      {week.days.map((entry, index) => {
        const spent = entry.cost.value ?? 0;
        const height = spent > 0 ? Math.max(2, (spent / top) * HEIGHT) : 1;
        return (
          <rect
            key={entry.start}
            x={index * (BAR + GAP)}
            y={HEIGHT - height}
            width={BAR}
            height={height}
            rx={1}
            style={{ fill: "var(--chart-series-1)" }}
            opacity={spent > 0 ? 1 : 0.4}
          />
        );
      })}
    </svg>
  );
}

/** The agent's estimated cost over the last week, read when the tab opens: a
 * sparkline, the total and a way to Usage. It says so when the agent's type
 * reports no usage or the agent isn't on this device, and when a read fails,
 * with Retry; it never stands in the way of the tab. */
export function CostRow({
  agents,
  agent,
  open,
}: {
  agents: Pick<Agents, "types">;
  agent: Agent;
  open: Navigation["open"];
}) {
  const readable = readsUsage(agents, agent);
  const [week, setWeek] = useState<WeekCost | "error">();
  const [attempt, setAttempt] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Reads again for another agent or a retry.
  useEffect(() => {
    setWeek(undefined);
    if (!readable) return;
    const controller = new AbortController();
    weekCost(agents, agent, controller.signal).then(
      (read) => {
        if (!controller.signal.aborted) setWeek(read);
      },
      () => {
        if (!controller.signal.aborted) setWeek("error");
      },
    );
    return () => controller.abort();
  }, [agent.pubkey, agent.type, readable, attempt]);
  const title = `Cost, last ${COST_DAYS} days`;
  if (!readable)
    return (
      <PreferenceRow
        title={title}
        subtitle={
          agent.place === "here"
            ? "Not available: this agent's type doesn't report its usage."
            : "Not available: usage is read from sessions on this device, and this agent runs elsewhere."
        }
      />
    );
  if (week === "error")
    return (
      <PreferenceRow
        title={title}
        subtitle="Couldn't read this agent's sessions."
        trailing={(label) => (
          <Button
            variant="outline"
            aria-describedby={label["aria-labelledby"]}
            onClick={() => setAttempt((count) => count + 1)}
          >
            Retry
          </Button>
        )}
      />
    );
  if (!week)
    return <PreferenceRow title={title} subtitle="Reading its sessions…" />;
  return (
    <PreferenceRow
      title={title}
      subtitle="An estimate from its sessions on this device, not a bill."
      trailing={(label) => (
        <div className="flex flex-wrap items-center justify-end gap-3">
          <Sparkline week={week} />
          <span className="tabular-nums">{costText(week.total)}</span>
          <Button
            variant="outline"
            aria-describedby={label["aria-labelledby"]}
            onClick={() =>
              void open(settingsTarget({ section: "buzz.usage/usage" }))
            }
          >
            Open Usage
          </Button>
        </div>
      )}
    />
  );
}
