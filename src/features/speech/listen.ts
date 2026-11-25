// One listen, from the microphone to a finished transcript. Hosted providers
// transcribe over WebRTC: this side holds the peer connection and its
// `oai-events` data channel, and the provider only answers the offer.
// On-device speech runs natively and sends its events on a channel. Both
// report the transcript as it changes, a short pause while listening goes
// on, and the end, after a long pause or `stop`.
import { Channel, invoke } from "@tauri-apps/api/core";

/**
 * - `unavailable`: no provider can listen, or this device can't.
 * - `denied`: microphone or speech recognition access is off, so the person
 *   has to allow it in System Settings.
 * - `missing_credentials`: the provider has no sign-in.
 * - `unauthorized`: the provider refused this account or community.
 * - `rate_limited`: the community has used its speech for now.
 */
export type SpeechFailure =
  | "unavailable"
  | "denied"
  | "missing_credentials"
  | "unauthorized"
  | "invalid_request"
  | "rate_limited"
  | "timeout"
  | "service_error"
  | "invalid_response";
export const SPEECH_FAILURES: readonly SpeechFailure[] = [
  "unavailable",
  "denied",
  "missing_credentials",
  "unauthorized",
  "invalid_request",
  "rate_limited",
  "timeout",
  "service_error",
  "invalid_response",
];

/** A call cap a caller may ask for or a provider may grant: whole seconds,
 * more than none. */
export const isCallSeconds = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

/** `downloading`: the on-device model is being fetched, the first time only. */
export type ListenState = "starting" | "downloading" | "listening" | "idle";

export type ListenOptions = Readonly<{
  /** Words the speech may contain, such as names. Only on-device speech
   * uses them. */
  hints?: readonly string[];
  /** The Buzz community (its relay URL) the speech is for. Hosted providers
   * that bill the community need it. */
  community?: string;
  /** How long a hosted call may last, in whole seconds, for speech longer
   * than a command. Without it the provider's default applies (30 seconds
   * on Builderlab), so a forgotten microphone cannot run long. The provider
   * may grant less; see `onCallLimit`. */
  maxSeconds?: number;
  /** The cap a hosted provider granted this call, in seconds, once it
   * answers. It hangs up then, and listening ends with what was heard. */
  onCallLimit?(maxSeconds: number): void;
  /** The transcript so far, each time it changes. */
  onText(text: string): void;
  /** The transcript so far, once speech pauses briefly; listening goes on.
   * It can come again for the same pause when the provider settles words. */
  onPause?(text: string): void;
  /** The finished transcript, once speech stops or the caller stops. Not
   * called when nothing was heard. */
  onEnd(text: string): void;
  /** Listening failed; nothing follows. */
  onError?(failure: SpeechFailure, message: string): void;
  onState?(state: ListenState): void;
}>;

export type Listening = Readonly<{
  /** Ends listening and reports what was heard. */
  stop(): void;
  /** Ends listening without reporting it. */
  cancel(): void;
}>;

/** Speech that stops producing text this long has paused: reported, but
 * listening goes on. On-device recognition revises its words about every
 * 200–300 ms while someone speaks; across 20 fluent phrases its longest gap
 * mid-phrase was about 500 ms, and its words settle about 200 ms after speech
 * stops. So 600 ms waits out fluent speech and reports a pause about 0.8 s
 * after the last word. */
const ON_DEVICE_PAUSE_MS = 600;
const HOSTED_PAUSE_MS = 800;
/** Speech that stops producing text this long has ended. */
const END_MS = 3_000;
/** Nothing heard this long after starting ends the attempt. */
const SILENCE_MS = 8_000;
/** How long an ending waits for the final transcript before reporting what
 * was heard so far. */
const FINAL_MS = 1_000;

const MESSAGES: Readonly<Record<SpeechFailure, string>> = {
  unavailable: "Speech to text isn’t available.",
  denied: "Allow Buzz to use your microphone to use speech to text.",
  missing_credentials: "Sign in to use speech to text.",
  unauthorized: "Speech to text isn’t available for this account.",
  invalid_request: "Speech to text couldn’t start.",
  rate_limited: "Speech to text is used up for now. Try again later.",
  timeout: "Speech to text took too long to connect.",
  service_error: "Speech to text couldn’t connect.",
  invalid_response: "Speech to text got an unreadable answer.",
};
export const speechMessage = (failure: SpeechFailure) => MESSAGES[failure];

/** Shared bookkeeping for one listen: timers, state, the end. */
function session(options: ListenOptions, pauseMs: number) {
  let text = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pause: ReturnType<typeof setTimeout> | undefined;
  let paused = false;
  const self = {
    ended: false,
    ending: false,
    text: () => text,
    state(state: ListenState) {
      if (!self.ended) options.onState?.(state);
    },
    /** Waits `ms`, then runs `then`, replacing any earlier wait. */
    wait(ms: number, then: () => void) {
      clearTimeout(timer);
      timer = setTimeout(then, ms);
    },
    close(report: boolean, heard = text, release = () => {}) {
      if (self.ended) return;
      self.ended = true;
      clearTimeout(timer);
      clearTimeout(pause);
      release();
      options.onState?.("idle");
      if (report && heard.trim()) options.onEnd(heard.trim());
    },
    fail(failure: SpeechFailure, message = MESSAGES[failure]) {
      if (self.ended) return false;
      options.onError?.(failure, message);
      return true;
    },
    /** New text. `settled` text is the provider's final word on speech that
     * already paused: reported as the same pause, and it never extends
     * listening. */
    heard(next: string, finish: () => void, settled = false) {
      if (next === text) return;
      text = next;
      options.onText(text.trim());
      if (self.ending || self.ended) return;
      if (settled && paused) {
        options.onPause?.(text.trim());
        return;
      }
      paused = false;
      clearTimeout(pause);
      pause = setTimeout(() => {
        paused = true;
        self.onPaused();
        options.onPause?.(text.trim());
      }, pauseMs);
      self.wait(END_MS, finish);
    },
    onPaused: () => {},
  };
  return self;
}

type NativeEvent =
  | { kind: "listening" }
  | { kind: "text"; text: string }
  | { kind: "ended"; text: string }
  | { kind: "error"; message: string }
  | { kind: "downloading" }
  | { kind: "denied"; message: string };

/** On-device speech: native code listens and sends its events. */
export function listenOnDevice(options: ListenOptions): Listening {
  const run = session(options, ON_DEVICE_PAUSE_MS);
  let id: number | undefined;
  const finish = () => {
    if (run.ended || run.ending) return;
    run.ending = true;
    if (id !== undefined)
      void invoke("speech_on_device_finish", { session: id }).catch(() => {});
    // Native sends a final transcript; report what was heard if it doesn't.
    run.wait(FINAL_MS, () => run.close(true));
  };
  const cancel = () => {
    if (run.ended) return;
    if (id !== undefined)
      void invoke("speech_on_device_cancel", { session: id }).catch(() => {});
    run.close(false);
  };
  const fail = (failure: SpeechFailure, message?: string) => {
    if (run.fail(failure, message)) run.close(false);
  };
  run.state("starting");
  const onEvent = new Channel<NativeEvent>((event) => {
    if (run.ended) return;
    if (event.kind === "error") return fail("service_error", event.message);
    if (event.kind === "denied") return fail("denied", event.message);
    if (event.kind === "downloading") {
      if (!run.ending) run.state("downloading");
      return;
    }
    if (event.kind === "ended")
      return run.close(true, event.text || run.text());
    if (event.kind === "listening") {
      run.state("listening");
      if (!run.ending && !run.text()) run.wait(SILENCE_MS, finish);
      return;
    }
    run.heard(event.text, finish);
  });
  void invoke<number>("speech_on_device_start", {
    hints: options.hints ?? [],
    onEvent,
  }).then(
    (started) => {
      id = started;
      // Stopped or cancelled before native code answered.
      if (run.ended)
        void invoke("speech_on_device_cancel", { session: id }).catch(() => {});
      else if (run.ending)
        void invoke("speech_on_device_finish", { session: id }).catch(() => {});
    },
    () => fail("unavailable"),
  );
  return { stop: finish, cancel };
}

const DELTA = "conversation.item.input_audio_transcription.delta";
const COMPLETED = "conversation.item.input_audio_transcription.completed";
const FAILED = "conversation.item.input_audio_transcription.failed";
const COMMIT = JSON.stringify({ type: "input_audio_buffer.commit" });
/** The provider's answer to a commit that had audio: its item. */
const COMMITTED = "input_audio_buffer.committed";
/** The answer to a commit with nothing new to transcribe; harmless. */
const COMMIT_EMPTY = "input_audio_buffer_commit_empty";

type RealtimeEvent = {
  type?: string;
  item_id?: string;
  delta?: string;
  transcript?: string;
  error?: { message?: string; code?: string };
};

/** The transcript as Realtime items, in the order they started. Deltas add to
 * their item; `completed` replaces it with the final text, which can differ.
 * A committed item counts before its first word. */
export function transcriptItems() {
  const items: { id: string; text: string; done: boolean }[] = [];
  const item = (id = "") => {
    const found = items.find((each) => each.id === id);
    if (found) return found;
    const next = { id, text: "", done: false };
    items.push(next);
    return next;
  };
  return {
    /** Applies one event; true when it changed an item. */
    apply(event: RealtimeEvent) {
      if (event.type === COMMITTED) {
        item(event.item_id);
        return false;
      }
      if (event.type === DELTA) {
        const target = item(event.item_id);
        if (target.done || !event.delta) return false;
        target.text += event.delta;
        return true;
      }
      if (event.type === COMPLETED) {
        const target = item(event.item_id);
        target.text = event.transcript ?? target.text;
        target.done = true;
        return true;
      }
      return false;
    },
    text: () =>
      items
        .map((each) => each.text.trim())
        .filter(Boolean)
        .join(" "),
    /** Every item is final. */
    settled: () => items.every((each) => each.done),
  };
}

export type Connect = (
  offer: string,
  signal: AbortSignal,
) => Promise<
  | Readonly<{ outcome: "answered"; sdp: string; maxSeconds?: number }>
  | Readonly<{ outcome: "failed"; reason: SpeechFailure }>
>;

/** A hosted provider: OpenAI Realtime transcription over WebRTC, with the
 * offer answered by `connect`. Turn detection is the caller's: each pause
 * and the end commit the audio sent since the last commit, which finalizes
 * its words and lets the provider meter what was transcribed. The provider
 * answers every commit, with its item or as empty, so the end waits for
 * those answers and the items' final words. */
export function listenHosted(
  options: ListenOptions,
  connect: Connect,
): Listening {
  const run = session(options, HOSTED_PAUSE_MS);
  const items = transcriptItems();
  const abort = new AbortController();
  let stream: MediaStream | undefined;
  let peer: RTCPeerConnection | undefined;
  let channel: RTCDataChannel | undefined;
  /** Words arrived since the last commit. */
  let uncommitted = false;
  /** Commits the provider has not answered yet. */
  let unanswered = 0;
  /** Commits the audio sent since the last commit: only once words arrived,
   * so silence isn't metered, unless `always`. */
  const commit = (always = false) => {
    if (channel?.readyState !== "open" || !(always || uncommitted)) return;
    uncommitted = false;
    unanswered += 1;
    channel.send(COMMIT);
  };
  const stopMicrophone = () => {
    for (const track of stream?.getTracks() ?? []) track.stop();
  };
  const release = () => {
    abort.abort();
    channel?.close();
    peer?.close();
    stopMicrophone();
  };
  const close = (report: boolean) => run.close(report, run.text(), release);
  /** Ending, and every word is in: report them. */
  const settle = () => {
    if (run.ending && unanswered <= 0 && items.settled()) close(true);
  };
  /** Ends listening once the last commit's words are in. Stop commits
   * even before the first word, so speech cut short still counts. */
  const end = (stopped: boolean) => {
    if (run.ended || run.ending) return;
    run.ending = true;
    stopMicrophone();
    commit(stopped);
    run.wait(FINAL_MS, () => close(true));
    settle();
  };
  const finish = () => end(false);
  const cancel = () => close(false);
  const fail = (failure: SpeechFailure, message?: string) => {
    if (run.fail(failure, message)) close(false);
  };
  run.onPaused = () => commit();
  const heard = (event: RealtimeEvent) => {
    if (event.type === COMMITTED) unanswered -= 1;
    if (items.apply(event)) {
      if (event.type === DELTA) uncommitted = true;
      run.heard(items.text(), finish, event.type === COMPLETED);
    }
    settle();
  };
  run.state("starting");
  void (async () => {
    try {
      // The offer needs no microphone: asking for it and connecting run
      // side by side.
      const connection = new RTCPeerConnection();
      peer = connection;
      connection.onconnectionstatechange = () => {
        if (connection.connectionState === "failed") fail("service_error");
      };
      const sender = peer.addTransceiver("audio").sender;
      channel = peer.createDataChannel("oai-events");
      // Transcripts arrive here, so listening starts once it opens.
      channel.addEventListener("open", () => {
        run.state("listening");
        if (!run.ending && !run.text()) run.wait(SILENCE_MS, finish);
      });
      channel.addEventListener("message", (message) => {
        if (run.ended) return;
        let event: RealtimeEvent;
        try {
          event = JSON.parse(String(message.data));
        } catch {
          return;
        }
        if (!event || typeof event !== "object") return;
        if (event.type === "error" && event.error?.code === COMMIT_EMPTY) {
          unanswered -= 1;
          return settle();
        }
        if (event.type === "error" || event.type === FAILED) {
          return fail(
            "service_error",
            event.error?.message ?? MESSAGES.service_error,
          );
        }
        heard(event);
      });
      // The provider hangs up at its call limit: report what was heard.
      channel.addEventListener("close", () => {
        if (!run.ended) close(true);
      });
      const offer = await peer.createOffer();
      if (run.ended) return;
      await peer.setLocalDescription(offer);
      if (run.ended) return;
      const microphone = navigator.mediaDevices
        .getUserMedia({
          audio: {
            autoGainControl: true,
            echoCancellation: true,
            noiseSuppression: true,
          },
        })
        .then((media) => {
          stream = media;
          // Stopped meanwhile: release the microphone at once.
          if (run.ended || run.ending)
            for (const track of media.getTracks()) track.stop();
          return media;
        });
      const [media, answer] = await Promise.all([
        microphone,
        connect(offer.sdp ?? "", abort.signal),
      ]);
      if (run.ended) return;
      if (answer.outcome === "failed") return fail(answer.reason);
      if (answer.maxSeconds !== undefined)
        options.onCallLimit?.(answer.maxSeconds);
      await sender.replaceTrack(media.getAudioTracks()[0] ?? null);
      if (run.ended) return;
      await peer.setRemoteDescription({ type: "answer", sdp: answer.sdp });
    } catch (error) {
      const exception = error instanceof Error || error instanceof DOMException;
      if (exception && error.name === "NotAllowedError") fail("denied");
      else fail("service_error", exception ? error.message : undefined);
    }
  })();
  return { stop: () => end(true), cancel };
}
