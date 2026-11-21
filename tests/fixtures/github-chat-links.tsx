import { createRoot } from "react-dom/client";
import "@fontsource-variable/inter/wght.css";
import "../../src/shared/styles/globals.css";
import { ChatPullLink } from "../../src/bundled/github/ChatPullLink";
import { LinkSettings } from "../../src/bundled/github/LinkSettings";
import { SoloPullIcon } from "../../src/bundled/github/SoloPull";
import { ConversationChannel } from "../../src/features/conversation/Conversation";
import { MessageLink } from "../../src/features/conversation/MessageLink";
import { ChatCircleIcon } from "../../src/shared/design-system/icons";
import { NavigationItem } from "../../src/shared/design-system/ui/NavigationItem";
import { SidebarNavigation } from "../../src/shared/design-system/ui/SidebarNavigation";
import { ToastProvider } from "../../src/shared/design-system/ui/Toast";
import { useKeyboardFocusVisibility } from "../../src/shared/design-system/useKeyboardFocusVisibility";
import { chatLinksModel } from "./github-chat-links-model";

const value = chatLinksModel();
const pulls = [
  "https://github.com/example-org/widgets/pull/42",
  "https://github.com/example-org/widgets/pull/43",
];
const entries = [
  {
    id: "pull",
    key: "buzz.github/pull",
    pluginId: "buzz.github",
    revision: "fixture",
    title: "GitHub",
    matches: () => true,
    component: ({ url }: { url: string }) => (
      <ChatPullLink {...value} url={url} />
    ),
  },
];
const extensions = {
  tools: { snapshot: () => [], subscribe: () => () => {} },
  inline: { snapshot: () => [], subscribe: () => () => {} },
};

function Fixture() {
  useKeyboardFocusVisibility();
  return (
    <ToastProvider>
      <div
        className="grid grid-cols-1 gap-section-gap p-6"
        style={{ maxWidth: "64rem", margin: "0 auto" }}
      >
        <h1 className="text-title">Solo PR hover linking</h1>
        <p className="text-body">
          Fictional data: hover or focus a PR, then link it to the chat. The
          sidebar uses the same saved link. Nothing on this page is sent to
          GitHub or a community.
        </p>
        <LinkSettings active={() => true} />
        <SidebarNavigation>
          <NavigationItem
            type="button"
            selected
            label={value.channel.name}
            icon={
              <SoloPullIcon
                pulls={value.pulls}
                channelId={value.channel.id}
                fallback={<ChatCircleIcon size={16} />}
              />
            }
          />
        </SidebarNavigation>
        <ConversationChannel
          session={value.session}
          scope={value.scope}
          channel={value.channel}
          extensions={extensions}
          active={false}
          interactions={{
            onOpenLink: () => false,
            canOpenLink: () => false,
            onOpenMediaReview: () => {},
          }}
        >
          <section
            aria-label="Chat messages"
            className="grid grid-cols-1 gap-6 py-6"
          >
            {pulls.map((url, index) => (
              <p key={url} className="text-body">
                {index === 0
                  ? "The release notes are ready: "
                  : "A second change for this chat: "}
                <MessageLink
                  session={value.session}
                  scope={value.scope}
                  url={url}
                  label={
                    index === 0
                      ? "example-org/widgets#42"
                      : "example-org/widgets#43"
                  }
                  registry={{
                    snapshot: () => entries,
                    subscribe: () => () => {},
                  }}
                  onOpenLink={() => false}
                />
              </p>
            ))}
          </section>
        </ConversationChannel>
      </div>
    </ToastProvider>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
const app = createRoot(root);
app.render(<Fixture />);
import.meta.hot?.dispose(() => {
  app.unmount();
  value.dispose();
});
