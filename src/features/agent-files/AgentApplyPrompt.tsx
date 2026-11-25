import { useEffect, useRef, useState } from "react";
import { AlertDialog } from "../../shared/design-system/ui/AlertDialog";
import { Button } from "../../shared/design-system/ui/Button";
import {
  AgentCallError,
  prepareApply,
  readAgentDocument,
  type AgentFileHost,
  type PendingApply,
} from "./apply";
import {
  answerAgentCall,
  onAgentCalls,
  setAgentCallListener,
  type AgentCall,
} from "./service";

type Shown = Readonly<{ id: string; pending: PendingApply }>;

const failure = (error: unknown) =>
  error instanceof AgentCallError
    ? { code: error.code, message: error.message }
    : {
        code: "unavailable",
        message: error instanceof Error ? error.message : String(error),
      };

/** Answers `buzz agents export` at once, and asks the owner to approve an
 * `import` or `edit` before it changes the agent. */
export function AgentApplyPrompt({ host }: { host: AgentFileHost }) {
  const [shown, setShown] = useState<Shown | null>(null);
  const [saving, setSaving] = useState(false);
  const decline = useRef<HTMLButtonElement>(null);
  const hostRef = useRef(host);
  hostRef.current = host;
  const open = useRef<string | null>(null);
  open.current = shown?.id ?? null;
  useEffect(() => {
    let stopped = false;
    let mounted = false;
    const handle = async (call: AgentCall) => {
      try {
        if (call.method === "agent_read") {
          const result = await readAgentDocument(hostRef.current, call.params);
          await answerAgentCall(call.id, { result });
          return;
        }
        if (open.current)
          throw new AgentCallError(
            "unavailable",
            "Another change is waiting for approval in Buzz",
          );
        const pending = await prepareApply(hostRef.current, call.params);
        if (typeof pending === "string") {
          await answerAgentCall(call.id, { result: pending });
          return;
        }
        if (stopped) throw new AgentCallError("unavailable", "Buzz closed");
        open.current = call.id;
        setShown({ id: call.id, pending });
      } catch (error) {
        await answerAgentCall(call.id, failure(error));
      }
    };
    const stop = onAgentCalls({
      request(call) {
        if (stopped) {
          void answerAgentCall(call.id, {
            code: "unavailable",
            message: "Buzz closed",
          });
          return;
        }
        void handle(call);
      },
      closed(id) {
        setShown((current) => (current?.id === id ? null : current));
      },
      ready() {
        if (stopped) return;
        mounted = true;
        void setAgentCallListener(true);
      },
    });
    return () => {
      stopped = true;
      stop();
      if (mounted) void setAgentCallListener(false);
      if (open.current)
        void answerAgentCall(open.current, {
          code: "unavailable",
          message:
            "Buzz closed before you approved the change, so nothing was applied. Open Buzz and run the command again.",
        });
    };
  }, []);
  if (!shown) return null;
  const { id, pending } = shown;
  const close = () => {
    setShown(null);
    setSaving(false);
  };
  const deny = () => {
    void answerAgentCall(id, {
      code: "declined",
      message:
        "You chose Decline when Buzz asked you to approve this change, so nothing was applied. Run the command again to apply it.",
    });
    close();
  };
  const approve = async () => {
    setSaving(true);
    try {
      await answerAgentCall(id, { result: await pending.run() });
    } catch (error) {
      await answerAgentCall(id, failure(error));
    }
    close();
  };
  return (
    <AlertDialog
      title={
        pending.creating ? (
          <>
            Create agent <strong>{pending.name}</strong> from a file?
          </>
        ) : (
          <>
            Change agent <strong>{pending.name}</strong> from a file?
          </>
        )
      }
      description="A command-line tool you paired with Buzz asks to apply an agent file. Review the diff it printed before you approve."
      initialFocus={decline}
      pending={saving}
      onClose={deny}
      actions={
        <>
          <Button ref={decline} disabled={saving} onClick={deny}>
            Decline
          </Button>
          <Button
            variant="prominent"
            disabled={saving}
            onClick={() => void approve()}
          >
            {pending.creating ? "Create" : "Apply"}
          </Button>
        </>
      }
    >
      <div className="min-w-0 space-y-2 text-body-sm">
        <p className="text-muted">Changes</p>
        <ul className="list-disc space-y-1 pl-5">
          {(pending.creating ? ["A new agent"] : pending.plan.changes).map(
            (change) => (
              <li key={change} className="break-all">
                {change}
              </li>
            ),
          )}
        </ul>
      </div>
    </AlertDialog>
  );
}
