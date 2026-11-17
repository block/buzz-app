import { createPlayout } from "../../features/huddle/playout";
import { defaults } from "./config";
import { AppServer, type Spawn } from "./rpc";
import { openVoice } from "./voice";
import promptUrl from "./voice-preview-prompt.mp3?url";

/** A disposable speech sample, with no microphone, tools, or saved conversation. */
export async function previewVoice(
  spawn: Spawn,
  voice: string,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const context = new AudioContext({ sampleRate: 48000 });
  const resumed = context.resume();
  const playout = createPlayout(context, context.destination, 0.02);
  const rpc = new AppServer();
  const abort = new AbortController();
  let quiet: ReturnType<typeof setTimeout> | undefined;
  let finish!: () => void;
  let fail!: (error: unknown) => void;
  const done = new Promise<void>((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });
  void done.catch(() => {});
  const wait = <T>(operation: Promise<T>) =>
    Promise.race([
      operation,
      done.then(() => {
        throw new Error("Voice preview stopped");
      }),
    ]);
  const stop = () => {
    abort.abort();
    playout.close();
    void context.close().catch(() => {});
    void rpc.close();
    finish();
  };
  signal.addEventListener("abort", stop, { once: true });
  const timeout = setTimeout(() => {
    fail(new Error("Voice preview timed out. Try again."));
    abort.abort();
    void rpc.close();
  }, 30_000);
  try {
    await wait(resumed);
    const response = await wait(
      fetch(promptUrl, { signal: AbortSignal.any([signal, abort.signal]) }),
    );
    if (!response.ok)
      throw new Error("Voice preview sample could not be loaded.");
    const prompt = await wait(
      context.decodeAudioData(await wait(response.arrayBuffer())),
    );
    await wait(rpc.open(spawn, defaults.workspace));
    signal.throwIfAborted();
    const { thread } = await wait(
      rpc.request<{ thread: { id: string } }>("thread/start", {
        ephemeral: true,
        approvalPolicy: "never",
        sandbox: "read-only",
        config: { mcp_servers: {}, "features.apps": false },
      }),
    );
    const connection = await wait(
      openVoice(
        rpc,
        thread.id,
        abort.signal,
        async (samples) => {
          playout.play(samples);
          if (samples.some((sample) => Math.abs(sample) > 0.001)) {
            clearTimeout(quiet);
            quiet = setTimeout(finish, 1200);
          }
        },
        (error) => (error ? fail(error) : finish()),
        "Read the supplied speech sample only. Do not use tools.",
        undefined,
        voice || undefined,
        true,
        context,
      ),
    );
    signal.throwIfAborted();
    // A bundled greeting request starts speech without opening a microphone.
    const samples = prompt.getChannelData(0);
    for (let offset = 0; offset < samples.length; offset += 960) {
      abort.signal.throwIfAborted();
      connection.input(Array.from(samples.subarray(offset, offset + 960)));
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await done;
  } finally {
    clearTimeout(timeout);
    clearTimeout(quiet);
    signal.removeEventListener("abort", stop);
    stop();
    await rpc.close();
  }
}
