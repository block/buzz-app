import { useRef, useSyncExternalStore } from "react";
import { AlertDialog } from "../../shared/design-system/ui/AlertDialog";
import { Button } from "../../shared/design-system/ui/Button";
import type { Agents } from "./service";

/** Host presentation, never a plugin-supplied confirmation callback. */
export function InstructionReview({ agents }: { agents: Agents }) {
  const requests = useSyncExternalStore(
    agents.subscribe,
    () => agents.instructionReviews?.() ?? empty,
  );
  const cancel = useRef<HTMLButtonElement>(null);
  const request = requests[0];
  if (!request) return null;
  return (
    <AlertDialog
      key={request.id}
      title="Send this instruction to your agent?"
      description={`${request.plugin} requests one isolated turn. No channel membership or conversation history is shared. Allowing delivery does not mean the operation completed.`}
      initialFocus={cancel}
      onClose={() => agents.decideInstruction?.(request.id, false)}
      actions={
        <>
          <Button
            ref={cancel}
            onClick={() => agents.decideInstruction?.(request.id, false)}
          >
            Cancel
          </Button>
          <Button
            variant="prominent"
            onClick={() => agents.decideInstruction?.(request.id, true)}
          >
            Send instruction
          </Button>
        </>
      }
    >
      <dl className="text-body">
        <dt>Agent</dt>
        <dd className="break-all">{request.agent}</dd>
        <dt>Community</dt>
        <dd className="break-all">{request.community}</dd>
        <dt>Source channel</dt>
        <dd className="break-all">{request.source}</dd>
        <dt>Operation</dt>
        <dd className="break-all">
          {request.operation} ({request.tool})
        </dd>
      </dl>
      <p className="text-body whitespace-pre-wrap break-words">
        {request.text}
      </p>
      <pre className="text-body whitespace-pre-wrap break-words">
        {JSON.stringify(request.args, null, 2)}
      </pre>
    </AlertDialog>
  );
}

const empty: readonly import("./instruction-requests").InstructionReview[] = [];
