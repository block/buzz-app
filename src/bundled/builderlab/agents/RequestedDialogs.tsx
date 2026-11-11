import { useEffect, useRef, useState } from "react";
import { AgentInstructions } from "../../../features/agents/AgentInstructions";
import { AlertDialog } from "../../../shared/design-system/ui/AlertDialog";
import { Button } from "../../../shared/design-system/ui/Button";
import { Dialog } from "../../../shared/design-system/ui/Dialog";
import { useToastNotification } from "../../../shared/design-system/ui/Toast";
import { validInstructions, type RemoteAgent } from "./client";

export type RequestedReview = Readonly<{
  approve(
    agent: RemoteAgent,
    instructions: string,
    signal: AbortSignal,
  ): Promise<void>;
  reject(agent: RemoteAgent, signal: AbortSignal): Promise<void>;
  onSettled(): void;
}>;
export type RequestedDialog = "approve" | "reject";

/** The confirmations for approving or rejecting an agent that another agent
 * requested for its owner. */
export function RequestedDialogs({
  agent,
  requester,
  review,
  active,
  dialog,
  onDialog,
}: {
  agent: RemoteAgent;
  requester: string;
  review: RequestedReview;
  active(): boolean;
  dialog: RequestedDialog | undefined;
  onDialog(dialog: RequestedDialog | undefined): void;
}) {
  const notify = useToastNotification();
  const [instructions, setInstructions] = useState(agent.instructions ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const request = useRef<AbortController>(undefined);
  useEffect(() => () => request.current?.abort(), []);
  const close = () => {
    onDialog(undefined);
    setError("");
    setInstructions(agent.instructions ?? "");
  };
  const run = async (kind: RequestedDialog) => {
    const controller = new AbortController();
    request.current = controller;
    setPending(true);
    setError("");
    try {
      await (kind === "approve"
        ? review.approve(agent, instructions, controller.signal)
        : review.reject(agent, controller.signal));
      if (controller.signal.aborted || !active()) return;
      close();
      notify(
        `${agent.name} ${kind === "approve" ? "approved" : "rejected"}`,
        "success",
      );
      review.onSettled();
    } catch (reason) {
      if (controller.signal.aborted) return;
      setError(
        reason instanceof Error ? reason.message : `Could not ${kind} agent.`,
      );
    } finally {
      setPending(false);
    }
  };
  const failure = error && (
    <p role="alert" className="m-0 text-body-sm text-danger">
      {error}
    </p>
  );
  return (
    <>
      <Dialog
        size="compact"
        open={dialog === "approve"}
        onOpenChange={(open) => !open && close()}
        title={`Approve ${agent.name}?`}
        description={`Requested by ${requester}. It starts once you approve it, with the instructions below.`}
        preventClose={pending}
        actions={
          <>
            <Button disabled={pending} onClick={close}>
              Cancel
            </Button>
            <Button
              variant="prominent"
              loading={pending}
              disabled={!validInstructions(instructions)}
              onClick={() => void run("approve")}
            >
              Approve
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <AgentInstructions
            value={instructions}
            disabled={pending}
            onChange={setInstructions}
          />
          {failure}
        </div>
      </Dialog>
      {dialog === "reject" && (
        <AlertDialog
          title={`Reject ${agent.name}?`}
          description={`${requester} asked for this agent. Rejecting deletes it and its key. It can’t be undone.`}
          pending={pending}
          onClose={close}
          {...(failure ? { children: failure } : {})}
          actions={
            <>
              <Button disabled={pending} onClick={close}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                loading={pending}
                onClick={() => void run("reject")}
              >
                Reject
              </Button>
            </>
          }
        />
      )}
    </>
  );
}
