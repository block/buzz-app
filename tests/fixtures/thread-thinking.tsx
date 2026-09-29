import { MessageRow } from "../../src/features/messages/MessageRow";
import ActivityDebugPage from "../../src/bundled/agent-activity/ActivityDebugPage";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ThreadPanel } from "../../src/features/messages/ThreadPanel";
import { threadThinkingFixture } from "../../src/features/messages/thread-thinking-testing";
import { Avatar } from "../../src/shared/design-system/ui/Avatar";
import { TypingPresentation } from "../../src/features/conversation/typing-presentation";
import { Button } from "../../src/shared/design-system/ui/Button";
import "../../src/shared/styles/globals.css";

const fixture = await threadThinkingFixture();
await fixture.session.profiles.ensure([fixture.agent]);
function Preview() {
  const [working, setWorking] = useState<string[]>([fixture.first.id]);
  useEffect(() => {
    const update = () => {
      for (const id of working) {
        fixture.start(id);
        fixture.signal(id);
      }
    };
    update();
    const timer = setInterval(update, 3000);
    return () => clearInterval(timer);
  }, [working]);
  const choose = (ids: string[]) => {
    for (const id of working)
      if (!ids.includes(id)) {
        fixture.respond(id);
        fixture.signal(id, 9);
      }
    setWorking(ids);
  };
  return (
    <TypingPresentation active>
      <main className="mx-auto max-w-5xl p-6 text-standard">
        <h1 className="text-heading-lg">Thread activity</h1>
        <p className="text-body-md text-subtle mt-2">
          Buzzy gets a working message in the active thread. The reply takes its
          place.
        </p>
        <div className="flex flex-wrap gap-2 my-6">
          <Button onClick={() => choose([fixture.first.id])}>
            Work on onboarding
          </Button>
          <Button onClick={() => choose([fixture.second.id])}>
            Work on notifications
          </Button>
          <Button onClick={() => choose([fixture.first.id, fixture.second.id])}>
            Work on both
          </Button>
          <Button onClick={() => choose([])}>Finish replies</Button>
        </div>
        <section
          className="ui-card p-4 mb-6"
          aria-label="Channel thread summaries"
        >
          {[fixture.first, fixture.second].map((message) => (
            <MessageRow
              key={message.id}
              row={{
                ...message,
                replyCount: 2,
                participants: [fixture.agent, message.authorId],
              }}
              session={fixture.session}
              profile={fixture.session.profiles
                .snapshot()
                .get(message.authorId)}
              participantProfiles={fixture.session.profiles.snapshot()}
              agentPubkeys={new Set([fixture.agent])}
              media={fixture.session.media}
              onOpenLink={() => false}
              onOpenThread={(id) =>
                document
                  .getElementById(`thread-${id}`)
                  ?.scrollIntoView({ block: "center" })
              }
              day={false}
              retry={undefined}
            />
          ))}
        </section>
        <div className="grid grid-cols-2 gap-6">
          {[fixture.first, fixture.second].map((root) => (
            <section
              key={root.id}
              id={`thread-${root.id}`}
              style={{ minHeight: 560, minWidth: 0 }}
              aria-label={
                root === fixture.first
                  ? "Onboarding thread"
                  : "Notifications thread"
              }
            >
              <ThreadPanel
                extensions={fixture.extensions}
                session={fixture.session}
                scope="preview"
                channelId="channel"
                channelName="Design"
                messageId={root.id}
                close={() => {}}
                onOpenLink={() => false}
              />
            </section>
          ))}
        </div>
        <div className="flex items-center gap-3 mt-6">
          <Avatar
            shape="squircle"
            alt="Buzzy profile"
            fallback="B"
            statusBadge="online"
          />
          <span>Buzzy's profile avatar stays available.</span>
        </div>
        <p className="text-body-sm text-subtle mt-4">
          Sample conversations using the app's actual thread UI. No messages are
          sent to your account.
        </p>
      </main>
    </TypingPresentation>
  );
}
const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    new URLSearchParams(location.search).has("debug") ? (
      <ActivityDebugPage />
    ) : (
      <Preview />
    ),
  );
if (import.meta.hot) import.meta.hot.dispose(() => fixture.dispose());
