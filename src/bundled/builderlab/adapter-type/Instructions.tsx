import { useEffect, useState } from "react";
import type { AgentViewProps } from "../../../features/agents/service";
import { PreferenceRow } from "../../../shared/design-system/ui/PreferenceRow";
import { SettingsGroup } from "../../../shared/design-system/ui/SettingsGroup";
import inlineStyles from "../../../shared/InlineReference.module.css";
import type { AgentClient, RemoteAgent } from "../agents/client";
import type { BuilderlabSession } from "../session";
import { ModelSettings } from "./ModelSettings";

const message = (reason: unknown) =>
  reason instanceof Error
    ? reason.message
    : "Could not load Builderlab settings.";

/** Hosted settings belong to Builderlab, rather than Agents' local config. */
export function createSettingsTab(
  client: AgentClient,
  session: BuilderlabSession,
) {
  function Editor({ pubkey, retry }: { pubkey: string; retry(): void }) {
    const [loaded, setLoaded] = useState<{
      agent: RemoteAgent;
      subject: string;
    }>();
    const [busy, setBusy] = useState(true);
    const [error, setError] = useState("");
    useEffect(() => {
      const current = new AbortController();
      const load = async () => {
        await session.ensureSignedIn(current.signal);
        const credential = session.credential();
        const remote = (await client.list(current.signal)).find(
          (row) => row.pubkey === pubkey,
        );
        current.signal.throwIfAborted();
        if (session.credential() !== credential)
          throw new DOMException("Builderlab session changed.", "AbortError");
        if (!remote)
          throw new Error("Agent not found in this Builderlab account.");
        if (remote.status !== "Active")
          throw new Error("Only Active agents can have their settings edited.");
        setLoaded({ agent: remote, subject: credential.account.subject });
      };
      void load()
        .catch((reason: unknown) => {
          if (!current.signal.aborted) setError(message(reason));
        })
        .finally(() => {
          if (!current.signal.aborted) setBusy(false);
        });
      return () => current.abort();
    }, [pubkey]);
    return (
      <ModelSettings
        client={client}
        session={session}
        settings={loaded ?? { pending: busy, error, retry }}
      />
    );
  }
  return function Settings({
    agent,
    settingsSection,
    settingsContent,
  }: AgentViewProps) {
    const [revision, setRevision] = useState(0);
    return (
      <div className="grid gap-4">
        {settingsSection !== "runtime" && (
          <Editor
            key={`${agent.pubkey}/${revision}`}
            pubkey={agent.pubkey}
            retry={() => setRevision((value) => value + 1)}
          />
        )}
        {settingsSection !== "identity" && (
          <>
            <SettingsGroup>
              <PreferenceRow
                title="Runtime"
                subtitle={
                  <>
                    Hosted and managed by{" "}
                    <a
                      className={inlineStyles.link}
                      href={import.meta.env.VITE_BUZZ_BUILDERLAB_URL}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Builderlab
                    </a>
                    .
                  </>
                }
              />
              <PreferenceRow
                title="Workspace"
                subtitle="Remote runtime shared with all agents by default."
              />
              <PreferenceRow
                title="Sessions"
                subtitle="One session per thread"
              />
            </SettingsGroup>
            {settingsContent}
          </>
        )}
      </div>
    );
  };
}
