import { useState } from "react";
import type { RelaySession } from "../../features/relay/session";
import { Select } from "../../shared/design-system/ui/Select";
import { ActivityStream } from "./ActivityStream";
import type { RequestWork } from "./request-work";

/** One selected agent at a time; its tool records never cross request scope. */
export function RequestWorkDetails({
  work,
  session,
  names,
  initialAgent,
}: {
  work: RequestWork;
  session: RelaySession;
  names: ReadonlyMap<string, string>;
  initialAgent?: string;
}) {
  const [selected, setSelected] = useState(initialAgent ?? "");
  const agent =
    work.agents.find((agent) => agent.agent === selected) ?? work.agents[0];
  return (
    <>
      <p className="text-caption text-subtle">
        Observed work linked to this request. Not a complete transcript or a
        claim of coauthorship.
      </p>
      {work.uncertain && (
        <p role="status" className="text-caption text-subtle">
          Some retained work cannot be assigned unambiguously. Timing is
          unavailable.
        </p>
      )}
      {agent ? (
        <>
          {work.agents.length > 1 && (
            <Select
              label="Agent"
              value={agent.agent}
              groups={[
                {
                  label: "Linked agents",
                  options: work.agents.map((item) => ({
                    value: item.agent,
                    label: names.get(item.agent) ?? "Agent",
                  })),
                },
              ]}
              onValueChange={setSelected}
            />
          )}
          <ActivityStream
            key={agent.agent}
            records={agent.records}
            turns={agent.turns}
            session={session}
            showTurnHeading={false}
            showDiagnostics
          />
        </>
      ) : (
        <p className="text-body-sm text-subtle">
          No retained work is linked to this request yet.
        </p>
      )}
    </>
  );
}
