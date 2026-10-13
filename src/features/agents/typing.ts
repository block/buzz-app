// While an agent this app runs works on a mention, it shows as typing there to
// everyone in the channel, on every device: the owner's others and teammates'.
// On this device the agent's activity takes the place of its typing.
import type { RelayEvent } from "../relay/events";
import { threadReference } from "../relay/thread-reference";
import type { AgentEventTemplate } from "./native";

/** Clients show a pulse for 8 s, so one every 3 s keeps it steady. */
const PULSE_MS = 3_000;
/** A run that never settles stops looking busy after this long. */
const LONGEST_MS = 30 * 60_000;
/** Failed pulses in a row that mean the community will not take them. */
const FAILURES = 3;

/** Pulses typing, signed as the agent, where it answers `event` until the
 * returned function is called: in the channel itself when `topLevel` settles
 * true, for a chat in the owner's Me, which reads as one conversation. It waits
 * for that answer, as its turn does, so both place it alike; a turn that cannot
 * tell where to answer fails, and shows no typing. The pulse ends with it:
 * clients drop typing when the agent replies, or a few seconds after its last
 * pulse. */
export function pulseTyping(
  publish: (event: AgentEventTemplate) => Promise<unknown>,
  topLevel: Promise<boolean>,
  event: RelayEvent,
  channelId: string,
): () => void {
  let stop: (() => void) | undefined;
  let stopped = false;
  topLevel.then(
    (flat) => {
      if (stopped) return;
      const root = threadReference(event)?.rootId ?? event.id;
      stop = pulse(publish, {
        kind: 20002,
        content: "",
        tags: [
          ["h", channelId],
          ...(flat
            ? []
            : [
                ...(root === event.id ? [] : [["e", root, "", "root"]]),
                ["e", event.id, "", "reply"],
              ]),
        ],
      });
    },
    () => {},
  );
  return () => {
    stopped = true;
    stop?.();
  };
}

function pulse(
  publish: (event: AgentEventTemplate) => Promise<unknown>,
  template: AgentEventTemplate,
) {
  const started = Date.now();
  let sending = false;
  let failed = 0;
  const stop = () => clearInterval(timer);
  const send = () => {
    if (Date.now() - started >= LONGEST_MS) return stop();
    // A slow community gets the next pulse once this one is answered.
    if (sending) return;
    sending = true;
    publish(template).then(
      () => {
        sending = false;
        failed = 0;
      },
      (error: unknown) => {
        sending = false;
        // Typing must never break the run it decorates. A blip skips a
        // pulse; a community that keeps refusing them gets no more.
        if (++failed < FAILURES) return;
        stop();
        console.warn("Agent typing was not sent", error);
      },
    );
  };
  const timer = setInterval(send, PULSE_MS);
  send();
  return stop;
}
