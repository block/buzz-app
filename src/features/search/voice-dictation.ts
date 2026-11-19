// Voice jump's speech-to-text: audio goes to OpenAI Realtime over WebRTC
// by default, or to the Mac's on-device recognizer when explicitly selected.
// Both report a short pause while listening goes on. A long pause or a
// second press ends the utterance.
import { Channel, invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";

/** Speech that stops producing text this long has paused: reported, but
 * listening goes on. On-device recognition revises its words about every
 * 200–300 ms while someone speaks; across 20 fluent phrases its longest gap
 * mid-phrase was about 500 ms, and its words settle about 200 ms after speech
 * stops. So 600 ms waits out fluent speech and reports a pause about 0.8 s
 * after the last word. A hesitation of 400 ms or more mid-phrase can still
 * report one early. */
const APPLE_PAUSE_MS = 600;
const REALTIME_PAUSE_MS = 800;
/** Speech that stops producing text this long has ended. */
const END_MS = 3_000;
/** Nothing heard this long after starting ends the attempt. */
const SILENCE_MS = 8_000;
/** How long an ending waits for the final transcript before reporting what
 * was heard so far. Native code usually sends it within 100 ms. */
const FINAL_MS = 1_000;

/** Prepares the selected recognizer (hosted key or Apple speech model). */
export function prepareVoice() {
  void invoke("voice_search_prepare").catch(() => {});
}

export type VoiceBackend = "realtime" | "apple";

let backend: Promise<VoiceBackend | null> | undefined;
/** The selected recognizer, asked of native code once. */
export function useVoiceSearchBackend(enabled: boolean) {
  const [value, setValue] = useState<VoiceBackend | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let current = true;
    backend ??= invoke<VoiceBackend | null>("voice_search_backend").catch(
      () => null,
    );
    void backend.then((next) => {
      if (current) setValue(next);
    });
    return () => {
      current = false;
    };
  }, [enabled]);
  return enabled ? value : null;
}

/** `downloading`: the speech model is being fetched, the first time only. */
export type DictationState = "idle" | "starting" | "downloading" | "listening";
/** Why listening failed: `denied` means microphone or speech recognition
 * access is turned off, so the person has to allow it in System Settings. */
export type DictationFailure = "denied" | "failed";

type VoiceEvent =
  | { kind: "listening" }
  | { kind: "text"; text: string }
  | { kind: "ended"; text: string }
  | { kind: "error"; message: string }
  | { kind: "downloading" }
  | { kind: "denied"; message: string };

const DELTA = "conversation.item.input_audio_transcription.delta";
const COMPLETED = "conversation.item.input_audio_transcription.completed";

type RealtimeEvent = {
  type?: string;
  delta?: string;
  transcript?: string;
  error?: { message?: string };
};

/** Appends one realtime event's text; a completed event repeats its segment. */
function mergeTranscript(current: string, event: RealtimeEvent) {
  if (event.type === DELTA) return current + (event.delta ?? "");
  if (event.type === COMPLETED) {
    const segment = (event.transcript ?? "").trim();
    if (
      !segment ||
      current.trim().toLowerCase().endsWith(segment.toLowerCase())
    )
      return current;
    return `${current.trimEnd()} ${segment}`.trimStart();
  }
  return current;
}

export function useVoiceDictation({
  backend,
  onText,
  onPause,
  onEnd,
  onError,
}: {
  backend: VoiceBackend | null;
  /** The transcript so far, each time it changes. */
  onText: (text: string) => void;
  /** The transcript so far, once speech pauses briefly; listening goes on. */
  onPause?: (text: string) => void;
  /** The finished transcript, once speech pauses or the person stops. */
  onEnd: (text: string) => void;
  onError?: (message: string, failure: DictationFailure) => void;
}) {
  const [state, setState] = useState<DictationState>("idle");
  const run = useRef<{ stop: () => void; cancel: () => void } | undefined>(
    undefined,
  );
  const callbacks = useRef({ onText, onPause, onEnd, onError });
  callbacks.current = { onText, onPause, onEnd, onError };

  /** Ends listening and reports what was heard. */
  const stop = useCallback(() => run.current?.stop(), []);
  /** Ends listening without reporting it. */
  const cancel = useCallback(() => run.current?.cancel(), []);
  useEffect(() => cancel, [cancel]);

  /** Starts listening; only Apple uses the hints. */
  const start = useCallback(
    async (hints: readonly string[] = []) => {
      if (run.current || !backend) return;
      let session: number | undefined;
      let stream: MediaStream | undefined;
      let peer: RTCPeerConnection | undefined;
      let text = "";
      let timer: ReturnType<typeof setTimeout> | undefined;
      let pause: ReturnType<typeof setTimeout> | undefined;
      let ending = false;
      let ended = false;
      const close = (report: boolean, heard = text) => {
        if (ended) return;
        ended = true;
        clearTimeout(timer);
        clearTimeout(pause);
        peer?.close();
        for (const track of stream?.getTracks() ?? []) track.stop();
        run.current = undefined;
        setState("idle");
        if (report && heard.trim()) callbacks.current.onEnd(heard.trim());
      };
      const finish = () => {
        if (ended || ending) return;
        if (backend === "realtime") return close(true);
        ending = true;
        clearTimeout(pause);
        if (session !== undefined)
          void invoke("voice_search_finish", { session }).catch(() => {});
        // Apple sends a final transcript; report what was heard if it doesn't.
        clearTimeout(timer);
        timer = setTimeout(() => close(true), FINAL_MS);
      };
      const abandon = () => {
        if (ended) return;
        if (session !== undefined)
          void invoke("voice_search_cancel", { session }).catch(() => {});
        close(false);
      };
      const wait = (ms: number) => {
        clearTimeout(timer);
        timer = setTimeout(finish, ms);
      };
      const listening = () => {
        setState("listening");
        if (!ending && !text) wait(SILENCE_MS);
      };
      const heard = (next: string) => {
        if (next === text) return;
        text = next;
        callbacks.current.onText(text.trim());
        if (ending || ended) return;
        clearTimeout(pause);
        pause = setTimeout(
          () => callbacks.current.onPause?.(text.trim()),
          backend === "apple" ? APPLE_PAUSE_MS : REALTIME_PAUSE_MS,
        );
        wait(END_MS);
      };
      const fail = (message: string, failure: DictationFailure = "failed") => {
        if (ended) return;
        callbacks.current.onError?.(message, failure);
        close(false);
      };
      run.current = { stop: finish, cancel: abandon };
      setState("starting");
      try {
        if (backend === "apple") {
          const onEvent = new Channel<VoiceEvent>((event) => {
            if (ended) return;
            if (event.kind === "error" || event.kind === "denied")
              return fail(
                event.message,
                event.kind === "denied" ? "denied" : "failed",
              );
            if (event.kind === "downloading") {
              if (!ending) setState("downloading");
              return;
            }
            if (event.kind === "ended") return close(true, event.text || text);
            if (event.kind === "listening") return listening();
            heard(event.text);
          });
          session = await invoke<number>("voice_search_start", {
            hints,
            onEvent,
          });
          // Stopped or cancelled before native code answered.
          if (ended)
            void invoke("voice_search_cancel", { session }).catch(() => {});
          else if (ending)
            void invoke("voice_search_finish", { session }).catch(() => {});
          return;
        }

        // The offer needs no microphone: asking for it and connecting run
        // side by side. The key and SDP exchange stay native.
        peer = new RTCPeerConnection();
        const sender = peer.addTransceiver("audio").sender;
        const channel = peer.createDataChannel("oai-events");
        channel.addEventListener("message", (message) => {
          if (ended) return;
          let event: RealtimeEvent;
          try {
            event = JSON.parse(String(message.data));
          } catch {
            return;
          }
          if (!event || typeof event !== "object") return;
          if (event.type === "error")
            return fail(event.error?.message ?? "Voice search failed");
          heard(mergeTranscript(text, event));
        });
        const offer = await peer.createOffer();
        if (ended) return;
        await peer.setLocalDescription(offer);
        if (ended) return;
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
            if (ended) for (const track of media.getTracks()) track.stop();
            return media;
          });
        const [media, answer] = await Promise.all([
          microphone,
          invoke<string>("voice_search_connect", { offer: offer.sdp ?? "" }),
        ]);
        if (ended) return;
        await sender.replaceTrack(media.getAudioTracks()[0] ?? null);
        if (ended) return;
        await peer.setRemoteDescription({ type: "answer", sdp: answer });
        if (!ended) listening();
      } catch (error) {
        const exception =
          error instanceof Error || error instanceof DOMException;
        if (exception && error.name === "NotAllowedError") {
          fail(
            "Allow Buzz to use your microphone to search by voice.",
            "denied",
          );
        } else {
          fail(
            exception
              ? error.message
              : typeof error === "string"
                ? error
                : "Voice search failed",
          );
        }
      }
    },
    [backend],
  );

  return { state, start, stop, cancel };
}
