import { streamVoiceTranscript } from "../agents/voice-transcript";
import type { ChannelSummary } from "../relay/contracts";
import type { RelaySession } from "../relay/session";
import type { Listening, Speech } from "../speech/service";

const sampleRate = 48_000;

export function startHostedHuddleTranscript(
  speech: Speech,
  track: () => MediaStreamTrack | undefined,
  session: RelaySession,
  community: string,
  destination: NonNullable<ChannelSummary["huddleTranscript"]>,
  signal: AbortSignal,
  active: () => boolean,
  live: () => boolean,
  report: (error: unknown) => void,
) {
  const backend = speech.backend();
  const outbox = session.outbox;
  if (!outbox || !backend || speech.status() !== "ready" || !active()) return;
  const inputTrack = track();
  if (!inputTrack) return;
  let connection: Listening | undefined;
  let healthy = true;
  let ready = false;
  let voiced = 0;
  let silence = 0;
  let duration = 0;
  const flush = () => {
    if (ready && voiced >= sampleRate * 0.12) connection?.commit?.();
    voiced = silence = duration = 0;
  };
  const fail = (error: unknown) => {
    healthy = ready = false;
    if (!signal.aborted) report(error);
  };
  const start = () => {
    if (signal.aborted || !active() || !healthy) return;
    const utterances = new Map<
      string,
      ReturnType<typeof streamVoiceTranscript>
    >();
    let expiresAt: number | undefined;
    voiced = silence = duration = 0;
    connection = speech.listen({
      community,
      maxSeconds: 3600,
      onText() {},
      onEnd() {},
      onCallLimit(maxSeconds) {
        expiresAt = Date.now() + maxSeconds * 1000;
      },
      continuous: {
        track: inputTrack,
        onItem(id, update) {
          if (signal.aborted || !active() || !healthy) return;
          let line = utterances.get(id);
          if (!line) {
            if ("delta" in update && utterances.size >= 16) return;
            line = streamVoiceTranscript(
              destination,
              signal,
              live,
              async (event) => {
                signal.throwIfAborted();
                if (!active())
                  throw new Error("Huddle transcript destination unavailable");
                const eventId = outbox.send(
                  { ...event, tags: event.tags?.map((tag) => [...tag]) ?? [] },
                  undefined,
                  active,
                );
                const createdAt = outbox
                  .snapshot()
                  .find((item) => item.event.id === eventId)?.event.created_at;
                try {
                  await session.channelWrites.delivered(
                    eventId,
                    active,
                    false,
                    false,
                  );
                } catch (error) {
                  if (
                    event.kind !== 9 ||
                    !active() ||
                    outbox
                      .snapshot()
                      .some(
                        (item) =>
                          item.event.id === eventId &&
                          item.delivery === "failed",
                      )
                  )
                    throw error;
                  // A lost receipt can still leave a message visible. Preserve its ID.
                  throw new Error(
                    `Agent event ${eventId} unconfirmed; it may or may not have been accepted`,
                  );
                }
                return {
                  id: eventId,
                  created_at: createdAt ?? Math.floor(Date.now() / 1000),
                };
              },
            );
            if ("delta" in update) utterances.set(id, line);
          }
          if ("delta" in update) line.append(update.delta);
          else {
            utterances.delete(id);
            void line.finish(update.final).catch(report);
          }
        },
      },
      onError(_failure, error) {
        fail(error);
      },
      onState(state) {
        ready = state === "listening";
        if (state !== "idle" || !healthy || signal.aborted) return;
        if (expiresAt && Date.now() >= expiresAt - 2000) queueMicrotask(start);
        else fail("The hosted transcription connection closed early.");
      },
    });
  };
  const unsubscribe = speech.subscribe(() => {
    if (
      !healthy ||
      (speech.backend() === backend && speech.status() === "ready")
    )
      return;
    fail("The speech to text provider became unavailable.");
    connection?.cancel();
  });
  signal.addEventListener(
    "abort",
    () => {
      unsubscribe();
      connection?.cancel();
    },
    { once: true },
  );
  start();
  return {
    get healthy() {
      return healthy;
    },
    input(frame: number[]) {
      if (!ready) return;
      const loud =
        frame.reduce((energy, sample) => energy + sample * sample, 0) >
        frame.length * 0.009 ** 2;
      if (loud) {
        voiced += frame.length;
        silence = 0;
      } else if (voiced) silence += frame.length;
      if (!voiced) return;
      duration += frame.length;
      if (silence >= sampleRate * 0.65 || duration >= sampleRate * 19) flush();
    },
    flush,
  };
}
