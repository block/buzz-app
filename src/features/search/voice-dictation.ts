// Voice jump's speech-to-text: the microphone streams to an OpenAI Realtime
// transcription session over WebRTC, and its transcript arrives as text
// deltas on a data channel. Native code answers the offer
// (`voice_search_connect`) with a key it fetched ahead of time
// (`voice_search_prepare`), so the key stays out of the webview and
// listening starts after one round trip. A short pause in speech is
// reported while listening goes on; a long one, or a second press, ends the
// utterance.
import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";

const DELTA = "conversation.item.input_audio_transcription.delta";
const COMPLETED = "conversation.item.input_audio_transcription.completed";
/** Speech that stops producing text this long has paused: reported, but
 * listening goes on. */
const PAUSE_MS = 800;
/** Speech that stops producing text this long has ended. */
const END_MS = 3_000;
/** Nothing heard this long after starting ends the attempt. */
const SILENCE_MS = 8_000;

/** Fetches the transcription key before it's needed. Native code keeps one
 * until shortly before it expires, so calling this often is cheap. */
export function prepareVoice() {
  void invoke("voice_search_prepare").catch(() => {});
}

let available: Promise<boolean> | undefined;
/** Whether this build can transcribe speech, asked of native code once. */
export function useVoiceSearchAvailable(enabled: boolean) {
  const [value, setValue] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    let current = true;
    available ??= invoke<boolean>("voice_search_available").catch(() => false);
    void available.then((next) => {
      if (current) setValue(next);
    });
    return () => {
      current = false;
    };
  }, [enabled]);
  return enabled && value;
}

export type DictationState = "idle" | "starting" | "listening";

type RealtimeEvent = {
  type?: string;
  delta?: string;
  transcript?: string;
  error?: { message?: string };
};

/** Appends one realtime event's text; a completed event repeats its segment. */
export function mergeTranscript(current: string, event: RealtimeEvent) {
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
  onText,
  onPause,
  onEnd,
  onError,
}: {
  /** The transcript so far, each time it grows. */
  onText: (text: string) => void;
  /** The transcript so far, once speech pauses briefly; listening goes on. */
  onPause?: (text: string) => void;
  /** The finished transcript, once speech pauses or the person stops. */
  onEnd: (text: string) => void;
  onError?: (message: string) => void;
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

  const start = useCallback(async () => {
    if (run.current) return;
    let stream: MediaStream | undefined;
    let peer: RTCPeerConnection | undefined;
    let text = "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pause: ReturnType<typeof setTimeout> | undefined;
    let ended = false;
    const finish = (report: boolean) => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      clearTimeout(pause);
      peer?.close();
      for (const track of stream?.getTracks() ?? []) track.stop();
      run.current = undefined;
      setState("idle");
      if (report && text.trim()) callbacks.current.onEnd(text.trim());
    };
    const wait = (ms: number) => {
      clearTimeout(timer);
      timer = setTimeout(() => finish(true), ms);
    };
    run.current = { stop: () => finish(true), cancel: () => finish(false) };
    setState("starting");
    try {
      // The offer needs no microphone: asking for it and connecting run
      // side by side, and the track joins once both are done.
      peer = new RTCPeerConnection();
      const sender = peer.addTransceiver("audio").sender;
      const channel = peer.createDataChannel("oai-events");
      channel.addEventListener("message", (message) => {
        let event: RealtimeEvent;
        try {
          event = JSON.parse(String(message.data));
        } catch {
          return;
        }
        if (event.type === "error") {
          callbacks.current.onError?.(
            event.error?.message ?? "Voice search failed",
          );
          finish(false);
          return;
        }
        const next = mergeTranscript(text, event);
        if (next === text) return;
        text = next;
        callbacks.current.onText(text.trim());
        clearTimeout(pause);
        pause = setTimeout(
          () => callbacks.current.onPause?.(text.trim()),
          PAUSE_MS,
        );
        wait(END_MS);
      });
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
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
      await peer.setRemoteDescription({ type: "answer", sdp: answer });
      if (ended) return;
      setState("listening");
      wait(SILENCE_MS);
    } catch (error) {
      if (!ended) {
        const name = error instanceof Error ? error.name : "";
        callbacks.current.onError?.(
          name === "NotAllowedError"
            ? "Allow Buzz to use your microphone to search by voice."
            : error instanceof Error
              ? error.message
              : typeof error === "string"
                ? error
                : "Voice search failed",
        );
      }
      finish(false);
    }
  }, []);

  return { state, start, stop, cancel };
}
