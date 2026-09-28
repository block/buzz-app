// Synthetic boundary only; no Tauri, OS credentials, or relay requests.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Context } from "@deepseek-ai/cordis";
import { createAccountConnection } from "../../src/features/communities/account-connection";
import { createCommunities } from "../../src/features/communities/service";
import { CommunityRail } from "../../src/features/communities/CommunityRail";
import "../../src/shared/styles/globals.css";
const calls: string[] = [];
let finish: (() => void) | undefined;
const connection = createAccountConnection(
  {
    async begin() {
      calls.push("begin");
      return "fixture";
    },
    run() {
      calls.push("run");
      return new Promise((resolve) => {
        finish = () =>
          resolve({
            viewer: "a".repeat(64),
            origin: "https://relay.example",
            relayAuthor: "b".repeat(64),
            archiveAuthority: null,
            lease: "11111111-1111-4111-8111-111111111111",
          });
      });
    },
    async close() {
      calls.push("close");
    },
    async cancel() {
      calls.push("cancel");
    },
  },
  () => ({
    viewer: "a".repeat(64),
    relayAuthor: "b".repeat(64),
    scope: "https://relay.example",
    media: () => undefined,
    query: async () => [],
  }),
);
const context = new Context();
const communities = createCommunities(
  context,
  false,
  undefined,
  "",
  undefined,
  connection,
);
Object.assign(window, { accountFixture: { calls, finish: () => finish?.() } });
const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <StrictMode>
      <CommunityRail communities={communities} />
    </StrictMode>,
  );
