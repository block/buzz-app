import workletUrl from "./capture.worklet.js?url&no-inline";

export type HuddleAudio = {
  mute(muted: boolean): void;
  play(peer: string, samples: readonly number[]): void;
  participants(peers: readonly string[]): void;
  close(): void;
};
export type OpenHuddleAudio = (
  send: (samples: number[]) => void,
  ended: () => void,
  signal: AbortSignal,
) => Promise<HuddleAudio>;

export const openHuddleAudio: OpenHuddleAudio = async (send, ended, signal) => {
  if (!navigator.mediaDevices?.getUserMedia)
    throw new Error("Microphone access is unavailable in this app.");
  const context = new AudioContext({
    sampleRate: 48000,
    latencyHint: "interactive",
  });
  let stream: MediaStream | undefined;
  let capture: AudioWorkletNode | undefined;
  let source: MediaStreamAudioSourceNode | undefined;
  let closed = false;
  let muted = false;
  const playback = new Map<
    string,
    { next: number; sources: Set<AudioBufferSourceNode> }
  >();
  const clear = (peer: string) => {
    const entry = playback.get(peer);
    for (const node of entry?.sources ?? []) {
      node.stop();
      node.disconnect();
    }
    playback.delete(peer);
  };
  const close = () => {
    if (closed) return;
    closed = true;
    signal.removeEventListener("abort", close);
    if (capture) {
      capture.port.onmessage = null;
      capture.disconnect();
      capture.port.close();
    }
    source?.disconnect();
    for (const track of stream?.getTracks() ?? []) {
      track.onended = null;
      track.stop();
    }
    for (const peer of playback.keys()) clear(peer);
    void context.close().catch(() => {});
  };
  signal.addEventListener("abort", close, { once: true });
  try {
    signal.throwIfAborted();
    await context.resume();
    if (context.sampleRate !== 48000)
      throw new Error("This audio device does not support Huddle audio.");
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        sampleRate: 48000,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    // Permission can finish after Cancel or plugin disposal. Release the late track.
    if (closed || signal.aborted) {
      for (const track of stream.getTracks()) track.stop();
      throw new DOMException("Huddle cancelled", "AbortError");
    }
    for (const track of stream.getAudioTracks()) track.onended = ended;
    await context.audioWorklet.addModule(workletUrl);
    signal.throwIfAborted();
    capture = new AudioWorkletNode(context, "buzz-huddle-capture");
    capture.port.onmessage = ({ data }: MessageEvent<Float32Array>) => {
      if (!closed && !muted) send(Array.from(data));
    };
    source = context.createMediaStreamSource(stream);
    source.connect(capture);
    // The worklet's output is silent; the connection keeps capture processing alive.
    capture.connect(context.destination);
    return {
      close,
      mute(value) {
        muted = value;
        for (const track of stream?.getAudioTracks() ?? [])
          track.enabled = !value;
      },
      participants(peers) {
        for (const peer of playback.keys())
          if (!peers.includes(peer)) clear(peer);
      },
      play(peer, samples) {
        if (closed || !samples.length || samples.length > 5760) return;
        let entry = playback.get(peer);
        if (!entry) {
          entry = { next: context.currentTime + 0.06, sources: new Set() };
          playback.set(peer, entry);
        }
        // Bound latency after a suspended device or a burst; never queue old speech.
        if (entry.next > context.currentTime + 0.2) return;
        entry.next = Math.max(entry.next, context.currentTime + 0.02);
        const buffer = context.createBuffer(1, samples.length, 48000);
        buffer.copyToChannel(Float32Array.from(samples), 0);
        const node = context.createBufferSource();
        node.buffer = buffer;
        node.connect(context.destination);
        entry.sources.add(node);
        node.onended = () => {
          entry.sources.delete(node);
          node.disconnect();
        };
        node.start(entry.next);
        entry.next += buffer.duration;
      },
    };
  } catch (error) {
    close();
    throw error;
  }
};
