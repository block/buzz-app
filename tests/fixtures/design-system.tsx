import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AppearanceSettings } from "../../src/app/AppearanceSettings";
import { createAppearance } from "../../src/shared/theme/service";
import { MessageRow } from "../../src/features/messages/MessageRow";
import { ProfileFields } from "../../src/features/communities/ProfileFields";
import "../../src/shared/styles/globals.css";

// Offline diagnostic only: no services, identities, signing or relay requests.
const appearance = createAppearance();
const container = document.getElementById("root");
if (!container) throw new Error("Missing design reference root");
const root = createRoot(container);
root.render(
  <StrictMode>
    <main className="shell-background min-h-screen p-6 text-ink">
      <div className="@container mx-auto grid max-w-4xl gap-6">
        <header>
          <p className="eyebrow">BUZZ DESIGN REFERENCE</p>
          <h1>One foundation, two modes</h1>
          <p>
            Offline component states. Use Tab to inspect focus and arrow keys to
            select appearance.
          </p>
        </header>
        <AppearanceSettings appearance={appearance} />
        <section className="ui-card p-6" aria-label="Controls">
          <h2 className="mt-0">Controls and hierarchy</h2>
          <p className="text-muted">
            Secondary text remains readable on each surface.
          </p>
          <div className="actions my-4">
            <button type="button">Default button</button>
            <button
              type="button"
              className="border-primary bg-primary text-on-primary hover:bg-primary/90"
            >
              Primary button
            </button>
            <button type="button" disabled>
              Disabled button
            </button>
            <button type="button" className="danger">
              Destructive action
            </button>
          </div>
          <ProfileFields
            profile={{ name: "Fixture Reader", picture: "" }}
            onChange={() => {}}
          />
          <div role="status" className="notice">
            Warning: a save could not be confirmed. Offer a clear next action.
          </div>
          <p className="error">
            Error: explain what happened without relying on color alone.
          </p>
        </section>
        <section className="ui-card p-6" aria-label="Conversation sample">
          <h2 className="mt-0">Conversation</h2>
          <MessageRow
            row={{
              id: "sample",
              authorId: "fixture",
              channelId: "design",
              createdAt: 1700000000,
              content:
                "Tokens belong to core. Plugins bring their own experience.\nhttps://example.com/design",
              mentions: [],
              emoji: [],
              reactionEmoji: [],
              attachments: [],
              reactions: ["✨"],
              replyCount: 0,
              participants: [],
              delivery: "confirmed",
            }}
            profile={{ name: "Fixture Reader", picture: "" }}
            media={() => undefined}
            onOpenLink={() => false}
            day={false}
            retry={undefined}
          />
        </section>
      </div>
    </main>
  </StrictMode>,
);
if (import.meta.hot)
  import.meta.hot.dispose(() => {
    root.unmount();
    appearance.dispose();
  });
