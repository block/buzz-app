// Share: the agent's catalog listing in its community, and a file export.
import { useEffect, useRef, useState } from "react";
import {
  catalogContent,
  catalogHead,
  isShared,
  publishShare,
  shareable,
  snapshotJson,
} from "../../features/agents/agent-share";
import type { Agent, RegisteredAgentType } from "../../features/agents/service";
import type { EventData } from "../../features/relay/events";
import type { RelaySession } from "../../features/relay/session";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { SettingsGroup } from "../../shared/design-system/ui/SettingsGroup";
import { SwitchPreferenceRow } from "../../shared/design-system/ui/SwitchPreferenceRow";

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export function AgentShareDialog({
  agent,
  type,
  session,
  onClose,
}: {
  agent: Agent;
  type: RegisteredAgentType | undefined;
  session: RelaySession;
  onClose(): void;
}) {
  // `null` while the catalog is read; `undefined` once read with no head.
  const [head, setHead] = useState<EventData | undefined | null>(null);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  // The read failed; clearing it reads again.
  const [unread, setUnread] = useState(false);
  const attempt = useRef<AbortController>(null);
  useEffect(() => {
    if (unread) return;
    const controller = new AbortController();
    attempt.current = controller;
    catalogHead(session, agent.owner, agent.pubkey, controller.signal).then(
      setHead,
      () => !controller.signal.aborted && setUnread(true),
    );
    return () => controller.abort();
  }, [session, agent.owner, agent.pubkey, unread]);
  const share = async (shared: boolean) => {
    const signal = attempt.current?.signal;
    if (head === null || pending || !signal) return;
    setPending(true);
    setNotice("");
    setError("");
    let next = head;
    try {
      // Unsharing keeps what was shared, so it never depends on the agent
      // still being shareable.
      const content =
        !shared && head ? head.content : catalogContent(shareable(agent, type));
      next = await publishShare(
        session,
        agent.pubkey,
        content,
        shared,
        head,
        signal,
      );
    } catch (reason) {
      // A publish the relay never answered may still have landed; ask it.
      next = await catalogHead(
        session,
        agent.owner,
        agent.pubkey,
        signal,
      ).catch(() => head);
      if (!signal.aborted && isShared(next) !== shared)
        setError(`Failed to update catalog sharing. ${message(reason)}`);
    }
    if (signal.aborted) return;
    setHead(next);
    if (isShared(next) === shared)
      setNotice(
        shared
          ? `Published ${agent.name} to the community catalog.`
          : `${agent.name} is no longer discoverable in the community catalog.`,
      );
    setPending(false);
  };
  const exportAgent = () => {
    setNotice("");
    setError("");
    let json: string;
    try {
      json = snapshotJson(shareable(agent, type));
    } catch (reason) {
      setError(`Failed to export agent snapshot. ${message(reason)}`);
      return;
    }
    const url = URL.createObjectURL(
      new Blob([json], { type: "application/json" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `${agent.name}.agent.json`;
    link.click();
    // WebKit may still be reading the blob when click() returns.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setNotice(`Exported ${agent.name}.`);
  };
  return (
    <Dialog
      open
      size="compact"
      title={`Share ${agent.name}`}
      description="Anyone you share this agent with will receive a copy they can add and use. Changes you make later won’t sync."
      preventClose={pending}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      actions={
        <>
          <Button disabled={pending} onClick={onClose}>
            Close
          </Button>
          <Button disabled={pending} onClick={exportAgent}>
            Export agent
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        <SettingsGroup>
          <SwitchPreferenceRow
            label="Share to catalog"
            description="Anyone in this community can find and use a copy. Your agent instruction is shared as plaintext. Memories and secrets aren’t included."
            checked={isShared(head ?? undefined)}
            disabled={head === null || pending}
            onCheckedChange={(shared) => void share(shared)}
          />
        </SettingsGroup>
        {notice && (
          <p role="status" className="m-0 text-body-sm text-secondary">
            {notice}
          </p>
        )}
        {error && (
          <p role="alert" className="m-0 text-body-sm text-danger">
            {error}
          </p>
        )}
        {unread && (
          <div role="alert" className="flex flex-col items-start gap-2">
            <p className="m-0 text-body-sm text-danger">
              Could not read the community catalog. Check the community
              connection, then retry.
            </p>
            <Button onClick={() => setUnread(false)}>Try again</Button>
          </div>
        )}
      </div>
    </Dialog>
  );
}
