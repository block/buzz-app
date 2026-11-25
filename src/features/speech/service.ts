// Speech to text for app code and plugins. A caller listens; the provider
// this device chose in Settings transcribes. Hosted providers are plugins:
// each registers with `ctx.speech.registerProvider` and answers a WebRTC
// offer. On-device recognition is built in and free. The host owns the
// choice, the microphone, the call, the transcript and its pauses, so every
// provider reports the same events and fails for the same reasons.
import { Service, type Context } from "@deepseek-ai/cordis";
import { invoke, isTauri } from "@tauri-apps/api/core";
import type { ComponentType } from "react";
import {
  createContributions,
  type Contribution,
} from "../../plugins/contributions";
import {
  SPEECH_FAILURES,
  isCallSeconds,
  listenHosted,
  listenOnDevice,
  type ListenOptions,
  type Listening,
} from "./listen";

export type {
  ListenOptions,
  Listening,
  ListenState,
  SpeechFailure,
} from "./listen";
import type { SpeechFailure } from "./listen";

/**
 * - `checking`: not known yet. A listen waits for it.
 * - `ready`: it can transcribe.
 * - `unconfirmed`: it may be able to, but could not check.
 * - `needs-setup`: it cannot until the user sets it up in Settings.
 */
export type SpeechProviderStatus =
  | "checking"
  | "ready"
  | "unconfirmed"
  | "needs-setup";

export type SpeechConnectRequest = Readonly<{
  /** The WebRTC SDP offer for one audio track and an `oai-events` data
   * channel, as OpenAI Realtime transcription takes it. */
  offer: string;
  /** The Buzz community (its relay URL) the speech is for. A provider that
   * bills the community, such as Builderlab, refuses a call without one. */
  community?: string;
  timeoutMs: number;
  /** The call's cap the caller asks for, in whole seconds. Without one the
   * provider uses its default, as voice commands do; a longer call is
   * always one the caller asked for. */
  maxSeconds?: number;
}>;

/** What a provider's `connect` resolves with. `maxSeconds` is the cap the
 * provider granted, when it says: it hangs up that long after answering. */
export type SpeechConnectReply =
  | Readonly<{ outcome: "answered"; sdp: string; maxSeconds?: number }>
  | Readonly<{ outcome: "failed"; reason: SpeechFailure }>;

/** A hosted speech provider, as a plugin registers it. It answers the host's
 * offer with a transcription session's SDP answer; audio then streams peer to
 * peer and transcripts arrive on the data channel as Realtime events. */
export type SpeechProvider = Readonly<{
  /** Unique within the plugin. */
  id: string;
  /** The name Settings shows, such as "Builderlab". */
  label: string;
  /** One line about what it uses, such as "Use your Builderlab account." */
  description: string;
  status(): SpeechProviderStatus;
  subscribe(listener: () => void): () => void;
  /** The host stops waiting at the deadline and aborts `signal`. */
  connect(
    request: SpeechConnectRequest,
    options: { signal: AbortSignal },
  ): Promise<SpeechConnectReply>;
  /** Its settings, shown under Settings > Speech to text while selected. */
  Settings?: ComponentType<{ active(): boolean }>;
  /** Lower comes first in Settings. Default 0. */
  order?: number;
}>;

export type RegisteredSpeechProvider = Contribution<SpeechProvider>;

/** One choice in Settings: a registered provider, or on-device speech. */
export type SpeechChoice = Readonly<{
  key: string;
  label: string;
  description: string;
  /** The registered provider; undefined for on-device speech. */
  entry?: RegisteredSpeechProvider;
}>;

/** What plugins get as `ctx.speech`. */
export interface Speech {
  /** Starts listening with the provider this device uses. Failures arrive
   * on `onError`; it never throws. */
  listen(options: ListenOptions): Listening;
  /** Warms the recognizer ahead of a listen, such as on-device speech's
   * language model. */
  prepare(): void;
  /** The key of the provider that listens, or undefined when none can. */
  backend(): string | undefined;
  /** That provider's status, or `unavailable` when there is none. */
  status(): SpeechProviderStatus | "unavailable";
  subscribe(listener: () => void): () => void;
  /** Offers a hosted provider while the calling plugin runs, or until the
   * returned function removes it. The user chooses it in Settings. */
  registerProvider(provider: SpeechProvider): () => void;
  /** Clears a saved choice for a retired provider owned by this plugin. */
  retireProvider(id: string): void;
}
declare module "@deepseek-ai/cordis" {
  interface Context {
    speech: Speech;
  }
}

export const SPEECH_PROVIDER_KEY = "buzz-speech-provider.v1";
/** On-device speech's key. It has no slash, so no plugin's key can match. */
export const ON_DEVICE_SPEECH = "on-device";
/** Providers that listen, in this order, while the user has not chosen one.
 * The first that can listen does. */
export const DEFAULT_SPEECH_PROVIDERS: readonly string[] = [
  "block.builderlab/builderlab",
  ON_DEVICE_SPEECH,
];
const CONNECT_TIMEOUT_MS = 20_000;

const ON_DEVICE: SpeechChoice = Object.freeze({
  key: ON_DEVICE_SPEECH,
  label: "On this Mac",
  description: "Apple speech recognition. Free, and audio stays on this Mac.",
});

const orderOf = (provider: SpeechProvider) =>
  Number.isFinite(provider.order) ? (provider.order as number) : 0;
const byOrder = (a: RegisteredSpeechProvider, b: RegisteredSpeechProvider) =>
  orderOf(a) - orderOf(b) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
/** A provider's status; one that throws is unconfirmed. */
export const speechStatusOf = (
  provider: SpeechProvider,
): SpeechProviderStatus => {
  try {
    return provider.status();
  } catch {
    return "unconfirmed";
  }
};

/** Whether on-device recognition runs here: `undefined` until known. */
export type OnDevice = Readonly<{
  available(): Promise<boolean>;
  prepare(): void;
}>;
const nativeOnDevice = (): OnDevice | undefined =>
  isTauri()
    ? {
        available: () =>
          invoke<boolean>("speech_on_device_available").catch(() => false),
        prepare: () => void invoke("speech_on_device_prepare").catch(() => {}),
      }
    : undefined;

/** Audio goes to the provider the user chose, or the first default that can
 * listen until they choose. Speech can be private, so no other provider gets
 * it without that choice: while the chosen provider can't listen, speech is
 * unavailable rather than sent somewhere else. */
export class SpeechService extends Service implements Speech {
  private readonly registry;
  private chosen: string | undefined;
  private sorted: readonly RegisteredSpeechProvider[] = [];
  private choices: readonly SpeechChoice[] = [];
  /** Whether on-device speech runs here; undefined while checking. */
  private onDevice: boolean | undefined;
  private readonly listeners = new Set<() => void>();
  constructor(
    ctx: Context,
    private readonly storage: Storage | undefined = typeof window ===
    "undefined"
      ? undefined
      : window.localStorage,
    private readonly device: OnDevice | undefined = nativeOnDevice(),
  ) {
    super(ctx, "speech");
    this.registry = createContributions<SpeechProvider>(ctx);
    try {
      this.chosen = storage?.getItem(SPEECH_PROVIDER_KEY) ?? undefined;
    } catch {
      // Unreadable storage means no choice.
    }
    if (!device) this.onDevice = false;
    else
      void device.available().then((available) => {
        this.onDevice = available;
        this.refresh();
      });
    let stops: (() => void)[] = [];
    const watch = () => {
      for (const stop of stops) stop();
      this.sorted = Object.freeze([...this.registry.snapshot()].sort(byOrder));
      stops = this.sorted.map((provider) => {
        try {
          return provider.subscribe(() => this.notify());
        } catch {
          return () => {};
        }
      });
      this.refresh();
    };
    ctx.effect(() => {
      const stop = this.registry.subscribe(watch);
      watch();
      return () => {
        stop();
        for (const each of stops) each();
        stops = [];
      };
    });
  }
  private refresh() {
    this.choices = Object.freeze([
      ...this.sorted.map((entry) =>
        Object.freeze({
          key: entry.key,
          label: entry.label,
          description: entry.description,
          entry,
        }),
      ),
      ...(this.onDevice ? [ON_DEVICE] : []),
    ]);
    this.notify();
  }
  registerProvider(provider: SpeechProvider): () => void {
    return this.registry.register(this.ctx, provider);
  }
  retireProvider(id: string): void {
    const owner = this.ctx.pluginOwner;
    if (!owner)
      throw new Error("Only an installed plugin can retire a provider");
    if (!id || id.includes("/")) throw new Error("Invalid speech provider ID");
    if (this.chosen !== `${owner.id}/${id}`) return;
    this.storage?.removeItem(SPEECH_PROVIDER_KEY);
    this.chosen = undefined;
    this.notify();
  }
  /** Host-only: every choice, in Settings order. */
  providers = (): readonly SpeechChoice[] => this.choices;
  /** Host-only: a choice's status. */
  statusOf = (key: string): SpeechProviderStatus | undefined => {
    if (key === ON_DEVICE_SPEECH)
      return this.onDevice === undefined
        ? "checking"
        : this.onDevice
          ? "ready"
          : undefined;
    const entry = this.sorted.find((provider) => provider.key === key);
    return entry && speechStatusOf(entry);
  };
  private route():
    | Readonly<{ key: string; status: SpeechProviderStatus }>
    | undefined {
    const known = (key: string) => {
      const status = this.statusOf(key);
      return status === undefined ? undefined : { key, status };
    };
    if (this.chosen !== undefined) return known(this.chosen);
    const defaults = DEFAULT_SPEECH_PROVIDERS.flatMap((key) => {
      const route = known(key);
      return route ? [route] : [];
    });
    const listening = defaults.find(
      ({ status }) => status === "ready" || status === "unconfirmed",
    );
    if (listening) return listening;
    const fallback = defaults[0];
    if (!fallback) return undefined;
    return defaults.some(({ status }) => status === "checking")
      ? { key: fallback.key, status: "checking" }
      : fallback;
  }
  backend = (): string | undefined => this.route()?.key;
  status = (): SpeechProviderStatus | "unavailable" =>
    this.route()?.status ?? "unavailable";
  /** Host-only: Settings chooses the provider. Not part of `Speech`. */
  setBackend(key: string): void {
    if (!this.choices.some((choice) => choice.key === key)) return;
    const before = this.backend();
    this.chosen = key;
    try {
      this.storage?.setItem(SPEECH_PROVIDER_KEY, key);
    } catch {
      // Still in effect for this session.
    }
    if (before !== key) this.notify();
  }
  private notify() {
    for (const listener of [...this.listeners]) listener();
  }
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };
  prepare(): void {
    if (this.backend() === ON_DEVICE_SPEECH) this.device?.prepare();
  }
  listen(options: ListenOptions): Listening {
    const key = this.backend();
    if (key === ON_DEVICE_SPEECH) return listenOnDevice(options);
    const provider = this.sorted.find((entry) => entry.key === key);
    if (!provider) {
      queueMicrotask(() => {
        options.onError?.(
          "unavailable",
          "Speech to text isn’t set up. Choose a provider in Settings.",
        );
        options.onState?.("idle");
      });
      return { stop() {}, cancel() {} };
    }
    return listenHosted(options, async (offer, signal) => {
      const abort = new AbortController();
      const stop = () => abort.abort();
      signal.addEventListener("abort", stop, { once: true });
      const timer = setTimeout(stop, CONNECT_TIMEOUT_MS);
      try {
        const reply = await Promise.race([
          provider.connect(
            Object.freeze({
              offer,
              ...(options.community === undefined
                ? {}
                : { community: options.community }),
              ...(isCallSeconds(options.maxSeconds)
                ? { maxSeconds: options.maxSeconds }
                : {}),
              timeoutMs: CONNECT_TIMEOUT_MS,
            }),
            { signal: abort.signal },
          ),
          new Promise<SpeechConnectReply>((resolve) =>
            abort.signal.addEventListener(
              "abort",
              () => resolve({ outcome: "failed", reason: "timeout" }),
              { once: true },
            ),
          ),
        ]);
        if (
          reply?.outcome === "answered" &&
          typeof reply.sdp === "string" &&
          reply.sdp
        )
          return isCallSeconds(reply.maxSeconds)
            ? {
                outcome: "answered",
                sdp: reply.sdp,
                maxSeconds: reply.maxSeconds,
              }
            : { outcome: "answered", sdp: reply.sdp };
        if (reply?.outcome === "failed")
          return {
            outcome: "failed",
            reason: SPEECH_FAILURES.includes(reply.reason)
              ? reply.reason
              : "invalid_response",
          };
        return { outcome: "failed", reason: "invalid_response" };
      } catch {
        return { outcome: "failed", reason: "service_error" };
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", stop);
      }
    });
  }
}
