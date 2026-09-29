import { ActivityDetails } from "./ActivityPanel";
import {
  activitySelection,
  type ActivitySelection,
} from "../../features/agents/activity-target";
import { useEffect, useState } from "react";
import { threadThinkingFixture } from "../../features/messages/thread-thinking-testing";
import { ThreadPanel } from "../../features/messages/ThreadPanel";
import { TypingPresentation } from "../../features/conversation/typing-presentation";
import { Button } from "../../shared/design-system/ui/Button";

type Fixture = Awaited<ReturnType<typeof threadThinkingFixture>>;

/** Dev-only page. Owns an in-memory session with no live signing or transport. */
export default function ActivityDebugPage() {
  const [fixture, setFixture] = useState<Fixture>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let disposed = false;
    let owner: Fixture | undefined;
    void threadThinkingFixture()
      .then(async (next) => {
        owner = next;
        if (disposed) {
          await next.dispose();
          return;
        }
        await next.session.profiles.ensure([next.agent]);
        if (!disposed) setFixture(next);
      })
      .catch(() => {
        if (!disposed)
          setError("The preview couldn’t load. Reopen this page to retry.");
      });
    return () => {
      disposed = true;
      void owner?.dispose();
    };
  }, []);
  if (error) return <p role="alert">{error}</p>;
  if (!fixture) return <p role="status">Loading preview…</p>;
  return <DebugControls fixture={fixture} />;
}

function DebugControls({ fixture }: { fixture: Fixture }) {
  const [panel, setPanel] = useState<ActivitySelection>();
  const [state, setState] = useState<"reset" | "working" | "complete">("reset");
  useEffect(() => {
    if (state !== "working") return;
    const refresh = () => fixture.signal(fixture.first.id);
    refresh();
    const timer = setInterval(refresh, 3000);
    return () => clearInterval(timer);
  }, [fixture, state]);
  const select = (next: typeof state) => {
    if (next === "complete") {
      fixture.start(fixture.first.id);
      fixture.respond(fixture.first.id);
    } else {
      fixture.reset();
      if (next === "working") fixture.start(fixture.first.id, true);
    }
    setState(next);
  };
  return (
    <main className="h-full overflow-auto p-6 text-standard">
      <div className="mx-auto max-w-3xl space-y-5">
        <h1 className="text-heading-lg">Agent activity preview</h1>
        <p className="text-body-md text-subtle">
          Click the working text to open activity. Working, Complete and Reset
          only change this sample conversation.
        </p>
        <div className="ui-card p-4 space-y-3">
          <fieldset
            className="flex flex-wrap gap-2"
            aria-label="Agent debug controls"
          >
            <Button
              variant={state === "working" ? "prominent" : "subtle"}
              aria-pressed={state === "working"}
              onClick={() => select("working")}
            >
              Working
            </Button>
            <Button
              variant={state === "complete" ? "prominent" : "subtle"}
              aria-pressed={state === "complete"}
              disabled={state === "complete"}
              onClick={() => select("complete")}
            >
              Complete
            </Button>
            <Button
              variant={state === "reset" ? "prominent" : "subtle"}
              aria-pressed={state === "reset"}
              onClick={() => select("reset")}
            >
              Reset
            </Button>
          </fieldset>
          <p className="text-body-sm text-subtle" role="status">
            {state === "working"
              ? "Working — click the activity text to open details."
              : state === "complete"
                ? "Complete — the response has replaced the working row."
                : "Reset — sample activity and the generated response are cleared."}
          </p>
        </div>
        <TypingPresentation active>
          <ThreadPanel
            extensions={fixture.extensions}
            session={fixture.session}
            scope="activity-debug"
            channelId="channel"
            channelName="Preview"
            messageId={fixture.first.id}
            embedded
            close={() => {}}
            canOpenLink={(target) => !!activitySelection(target)}
            onOpenLink={(target) => {
              const selection = activitySelection(target);
              if (!selection) return false;
              setPanel(selection);
              return true;
            }}
          />
        </TypingPresentation>
        {panel && (
          <aside className="ui-card" aria-label="Dedicated activity panel">
            <div className="flex justify-end p-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setPanel(undefined)}
              >
                Close activity panel
              </Button>
            </div>
            <ActivityDetails session={fixture.session} selection={panel} />
          </aside>
        )}
      </div>
    </main>
  );
}
