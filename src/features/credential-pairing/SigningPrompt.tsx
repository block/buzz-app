import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { AlertDialog } from "../../shared/design-system/ui/AlertDialog";
import { Button } from "../../shared/design-system/ui/Button";
import { relayOrigin } from "../communities/destination";
import { useRelayConnection } from "../relay/react";
import type { RelayData } from "../relay/service";
import { describeSignature } from "./describe-signature";
import {
  answerSigning,
  onPairingEvents,
  setSigningPrompt,
  type SignAnswer,
  type SignRequest,
} from "./service";

const duration = (seconds: number) =>
  seconds % 60 === 0 ? `${seconds / 60} min` : `${seconds} s`;

/** The request in plain words. Channels and people come from what the open
 * community already holds; nothing is read from the relay. A request for
 * another community, or a name not held, shows a short id instead. */
function useDescription(relay: RelayData, request: SignRequest) {
  const connection = useRelayConnection(relay);
  const { session, origin } = connection;
  const known = useMemo(() => {
    try {
      return !!origin && origin === relayOrigin(request.relay);
    } catch {
      return false;
    }
  }, [origin, request.relay]);
  const subscribe = useCallback(
    (listener: () => void) => {
      if (!known) return () => {};
      const stops = [
        session.channels.subscribeList(listener),
        session.profiles.subscribe(listener),
      ];
      return () => {
        for (const stop of stops) stop();
      };
    },
    [session, known],
  );
  // A primitive snapshot: the channel list changes on every message, but the
  // words only when a name resolves.
  const snapshot = () =>
    JSON.stringify(
      describeSignature(
        request.kind,
        request.tags,
        known
          ? {
              channel: (id) => session.channels.get?.(id)?.name,
              person: (key) => session.profiles.snapshot().get(key)?.name,
            }
          : {},
      ),
    );
  const text = useSyncExternalStore(subscribe, snapshot, snapshot);
  return useMemo(
    () => JSON.parse(text) as ReturnType<typeof describeSignature>,
    [text],
  );
}

/** Asks the person to let a paired command-line tool sign one sensitive
 * event as them. Native code refuses without asking while this is not mounted,
 * and always for agents Buzz launches. */
export function SigningPrompt({ relay }: { relay: RelayData }) {
  const [request, setRequest] = useState<SignRequest | null>(null);
  const [left, setLeft] = useState(0);
  const open = useRef<string | null>(null);
  open.current = request?.id ?? null;
  // Native asks only while a prompt listens. This one is mounted only in the
  // app shell, so behind sign-in, setup or restoring screens native refuses.
  useEffect(() => {
    let stopped = false;
    let mounted = false;
    const stop = onPairingEvents({
      signRequest(next) {
        // Heard after its cleanup ran: nobody can show it.
        if (stopped) {
          void answerSigning(next.id, "deny");
          return;
        }
        // One request is shown at a time; the one it replaces is refused.
        if (open.current && open.current !== next.id)
          void answerSigning(open.current, "deny");
        setRequest(next);
        setLeft(next.expiresIn);
      },
      signClosed(id) {
        setRequest((current) => (current?.id === id ? null : current));
      },
      ready() {
        // Stopped first, as by a development remount: it never counted.
        if (stopped) return;
        mounted = true;
        void setSigningPrompt(true);
      },
    });
    return () => {
      stopped = true;
      stop();
      if (mounted) void setSigningPrompt(false);
    };
  }, []);
  // Leaving the page refuses what it was asked.
  useEffect(
    () => () => {
      if (open.current) void answerSigning(open.current, "deny");
    },
    [],
  );
  useEffect(() => {
    if (!request) return;
    const timer = window.setInterval(
      () => setLeft((seconds) => Math.max(0, seconds - 1)),
      1000,
    );
    return () => window.clearInterval(timer);
  }, [request]);
  // Native refuses it by now too; the prompt just closes.
  useEffect(() => {
    if (left === 0) setRequest(null);
  }, [left]);
  if (!request) return null;
  return (
    <SigningDialog
      key={request.id}
      relay={relay}
      request={request}
      left={left}
      onAnswer={(answer) => {
        void answerSigning(request.id, answer);
        setRequest(null);
      }}
    />
  );
}

function SigningDialog({
  relay,
  request,
  left,
  onAnswer,
}: {
  relay: RelayData;
  request: SignRequest;
  left: number;
  onAnswer(answer: SignAnswer): void;
}) {
  const deny = useRef<HTMLButtonElement>(null);
  const { action, ability } = useDescription(relay, request);
  const span = duration(request.windowSeconds);
  return (
    <AlertDialog
      title={
        <>
          <strong>{request.client}</strong> wants to {action}
        </>
      }
      description={
        <>
          Buzz signs this as you on <strong>{request.relay}</strong>.
          {request.windowSeconds > 0 &&
            ` Allow for ${span} lets ${request.client} ${ability} without asking again.`}
        </>
      }
      initialFocus={deny}
      onClose={() => onAnswer("deny")}
      actions={
        <>
          <Button ref={deny} onClick={() => onAnswer("deny")}>
            Deny
          </Button>
          {request.windowSeconds > 0 && (
            <Button onClick={() => onAnswer("window")}>Allow for {span}</Button>
          )}
          <Button variant="prominent" onClick={() => onAnswer("once")}>
            Allow once
          </Button>
        </>
      }
    >
      <p
        className="min-w-0 text-body-sm text-muted"
        role="timer"
        aria-live="off"
      >
        Expires in {left} s
      </p>
    </AlertDialog>
  );
}
