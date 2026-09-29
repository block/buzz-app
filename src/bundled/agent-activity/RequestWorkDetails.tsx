import { useEffect, useRef, useState } from "react";
import type { RelaySession } from "../../features/relay/session";
import { Tabs } from "../../shared/design-system/ui/Tabs";
import { ActivityStream } from "./ActivityStream";
import type { RequestWork } from "./request-work";
import styles from "./RequestWorkDetails.module.css";

/** One selected agent at a time; its tool records never cross request scope. */
export function RequestWorkDetails({
  work,
  session,
  names,
  initialAgent,
  selectedAgent,
  onAgentChange,
}: {
  work: RequestWork;
  session: RelaySession;
  names: ReadonlyMap<string, string>;
  initialAgent?: string;
  selectedAgent?: string | undefined;
  onAgentChange?: ((agent: string) => void) | undefined;
}) {
  const [selected, setSelected] = useState(initialAgent ?? "");
  const agent =
    work.agents.find((agent) => agent.agent === (selectedAgent ?? selected)) ??
    work.agents[0];
  const root = useRef<HTMLDivElement>(null);
  const gesture = useRef<
    { id: number; x: number; y: number; agent: string } | undefined
  >(undefined);
  const select = (key: string) => {
    setSelected(key);
    onAgentChange?.(key);
  };
  useEffect(() => {
    if (!agent?.agent) return;
    const tab = root.current?.querySelector<HTMLElement>(
      '[role="tab"][aria-selected="true"]',
    );
    const list = tab?.closest<HTMLElement>('[role="tablist"]');
    if (!tab || !list) return;
    const reveal = () => {
      const bounds = tab.getBoundingClientRect(),
        viewport = list.getBoundingClientRect();
      if (bounds.left < viewport.left)
        list.scrollLeft -= viewport.left - bounds.left;
      else if (bounds.right > viewport.right)
        list.scrollLeft += bounds.right - viewport.right;
    };
    reveal();
    const resize = new ResizeObserver(reveal);
    resize.observe(list);
    return () => resize.disconnect();
  }, [agent?.agent]);
  const stream = (key: string) => {
    const item = work.agents.find((item) => item.agent === key);
    return item ? (
      <ActivityStream
        records={item.records}
        turns={item.turns}
        session={session}
        showTurnHeading={false}
        showDiagnostics
      />
    ) : null;
  };
  return (
    <div
      ref={root}
      className={`text-body-sm ${styles.root}`}
      onPointerDown={(event) => {
        gesture.current = undefined;
        // Tab-strip scrolling, text selection and horizontally scrollable evidence
        // retain native gestures. Swipe only the surrounding activity surface.
        if (
          !agent ||
          event.pointerType !== "touch" ||
          !event.isPrimary ||
          (event.target as Element).closest(
            'button, a, input, textarea, select, pre, code, [contenteditable="true"], [role="tablist"]',
          )
        )
          return;
        gesture.current = {
          id: event.pointerId,
          x: event.clientX,
          y: event.clientY,
          agent: agent.agent,
        };
      }}
      onPointerCancel={() => {
        gesture.current = undefined;
      }}
      onPointerUp={(event) => {
        const start = gesture.current;
        gesture.current = undefined;
        if (
          !start ||
          start.id !== event.pointerId ||
          start.agent !== agent?.agent
        )
          return;
        const dx = event.clientX - start.x,
          dy = event.clientY - start.y;
        if (Math.abs(dx) < 48 || Math.abs(dx) <= Math.abs(dy) * 1.5) return;
        const rtl = getComputedStyle(event.currentTarget).direction === "rtl";
        const index = work.agents.findIndex(
          (item) => item.agent === start.agent,
        );
        const next = work.agents[index + (dx < 0 !== rtl ? 1 : -1)];
        if (next) select(next.agent);
      }}
    >
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
        work.agents.length > 1 ? (
          <Tabs
            variant="panel"
            label="Agents"
            value={agent.agent}
            items={work.agents.map((item) => ({
              value: item.agent,
              label: names.get(item.agent) ?? "Agent",
            }))}
            onValueChange={select}
            renderPanel={stream}
          />
        ) : (
          stream(agent.agent)
        )
      ) : (
        <p className="text-body-sm text-subtle">
          No retained work is linked to this request yet.
        </p>
      )}
    </div>
  );
}
