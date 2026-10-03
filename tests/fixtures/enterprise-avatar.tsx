import { Context } from "@deepseek-ai/cordis";
import { createRoot } from "react-dom/client";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { EnterpriseLoginDialog } from "../../src/app/EnterpriseLoginDialog";
import {
  createCommunities,
  EnterpriseDiscoveryError,
} from "../../src/features/communities/service";
import type { EnterpriseAuthClient } from "../../src/features/communities/enterpriseAuthApi";
import { AvatarEditor } from "../../src/features/profiles/AvatarEditor";
import type { ReadTransport } from "../../src/features/relay/transport";
import "../../src/shared/styles/globals.css";

const community = "https://enterprise.example";
const viewer = "a".repeat(64);

function Fixture() {
  const [picture, setPicture] = useState("https://images.example/original.png");
  const discoveryFailure =
    new URLSearchParams(window.location.search).get("failure") === "discovery";
  const [activity] = useState(() => ({
    gateRequired: false,
    discoveryPending: discoveryFailure,
    starts: 0,
    cancels: 0,
  }));
  const [, redraw] = useState(0);
  const [services] = useState(() => {
    const context = new Context();
    let releaseStart!: () => void;
    const startFinished = new Promise<{ expiresAt: string }>((resolve) => {
      releaseStart = () => resolve({ expiresAt: "2099-01-01T00:00:00Z" });
    });
    const auth: EnterpriseAuthClient = {
      gate: async () => {
        if (!activity.gateRequired) return false;
        if (activity.discoveryPending) {
          activity.discoveryPending = false;
          throw new EnterpriseDiscoveryError("advertisement unavailable");
        }
        return true;
      },
      get: async () => null,
      start: async () => {
        activity.starts += 1;
        redraw((value) => value + 1);
        return startFinished;
      },
      cancel: async () => {
        activity.cancels += 1;
        redraw((value) => value + 1);
        releaseStart();
      },
      clear: async () => {},
    };
    const transport: ReadTransport = {
      viewer,
      relayAuthor: "b".repeat(64),
      scope: community,
      query: async () => [],
      media: () => undefined,
    };
    window.localStorage.removeItem(`buzz-client.v1:${viewer}`);
    const communities = createCommunities(
      context,
      false,
      undefined,
      "",
      undefined,
      Promise.resolve(viewer),
      async (_signal) => transport,
      auth,
    );
    return { context, communities };
  });
  const client = useSyncExternalStore(
    services.communities.subscribe,
    services.communities.snapshot,
  );
  const joined = useRef(false);
  useEffect(() => {
    if (client.status !== "ready" || joined.current) return;
    joined.current = true;
    services.communities.joined(
      { id: community, name: "Enterprise" },
      { name: "Fixture human", picture },
    );
  }, [client.status, picture, services]);
  useEffect(
    () => () => {
      void services.context.fiber.dispose();
    },
    [services],
  );
  const connect = async (id: string, signal: AbortSignal) => {
    activity.gateRequired = true;
    return services.communities.connect(id, signal);
  };
  const enterprise =
    client.enterprise?.communityId === client.selected
      ? client.enterprise
      : undefined;
  return (
    <main className="p-8">
      <h1>Enterprise avatar fixture</h1>
      <p>
        Real communities service and prompt; transport and auth stay in memory.
      </p>
      <AvatarEditor
        value={picture}
        name="Fixture human"
        community={community}
        connect={connect}
        onChange={setPicture}
      />
      <output aria-label="Saved picture">{picture}</output>
      <output aria-label="Login starts">{activity.starts}</output>
      <output aria-label="Login cancellations">{activity.cancels}</output>
      {enterprise && (
        <EnterpriseLoginDialog
          communities={services.communities}
          state={enterprise}
        />
      )}
    </main>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<Fixture />);
