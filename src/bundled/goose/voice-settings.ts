import { REQUEST_TIMEOUT_MS, type GooseHost, type GooseProcess } from "./goose";
import { briefly } from "./setup";

const ENDPOINT = "GOOSE_LIVE_VOICE_ENDPOINT";
const KEY = "GOOSE_LIVE_VOICE_API_KEY";
const MODEL = "GOOSE_LIVE_VOICE_MODEL";
const VOICE = "GOOSE_LIVE_VOICE";
const ENABLED = "buzz.goose.voice.enabled";
export type VoiceSettings = {
  endpoint: string;
  model: string;
  voice: string;
  saved: boolean;
};
export type VoiceEdit = Omit<VoiceSettings, "saved"> & { key: string };

export function voiceEndpoint(value: string): string {
  const endpoint = value.trim();
  if (!endpoint) return "";
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error("Enter a full HTTP or HTTPS sessions URL.");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.href.includes("?") ||
    url.href.includes("#")
  )
    throw new Error(
      "Use an HTTP or HTTPS URL without credentials, query or fragment.",
    );
  return endpoint;
}

/** Serializes only this device's Buzz writes and starts. Goose CLI writers
 * are independent; goose itself must read credentials fresh on each start. */
export class GooseVoiceSettings {
  private tail: Promise<unknown> = Promise.resolve();
  private allowed: boolean;
  constructor(
    private readonly host: GooseHost | undefined,
    private readonly storage: Storage,
    private readonly changed: (enabled: boolean) => void,
  ) {
    this.allowed = storage?.getItem(ENABLED) === "true";
  }

  get enabled() {
    return this.allowed;
  }
  private serial<T>(run: () => Promise<T>): Promise<T> {
    const result = this.tail.then(run);
    this.tail = result.catch(() => undefined);
    return result;
  }
  private toggle(enabled: boolean) {
    const previous = this.allowed;
    // A storage failure must never enable voice. Disabling takes effect in
    // memory even if this device cannot persist its preference.
    if (!enabled) this.allowed = false;
    try {
      this.storage.setItem(ENABLED, String(enabled));
      this.allowed = enabled;
    } finally {
      if (previous !== this.allowed) this.changed(this.allowed);
    }
  }
  setEnabled(enabled: boolean) {
    return this.serial(async () => {
      this.toggle(enabled);
    });
  }
  start<T>(signal: AbortSignal, run: () => Promise<T>): Promise<T> {
    return this.serial(async () => {
      signal.throwIfAborted();
      if (!this.allowed)
        throw new Error("Turn on Goose voice in settings first.");
      return run();
    });
  }
  availability(): Promise<string> {
    return this.serial(() =>
      briefly(
        this.host,
        async (goose) => {
          const result = (await goose.request(
            "_goose/unstable/session/live-voice/availability",
            {},
            REQUEST_TIMEOUT_MS,
          )) as { message: string };
          return result.message;
        },
        { GOOSE_LIVE_VOICE_ENABLED: String(this.allowed) },
      ),
    );
  }
  read(): Promise<VoiceSettings> {
    return this.serial(() => briefly(this.host, read));
  }
  save(edit: VoiceEdit): Promise<VoiceSettings> {
    return this.serial(async () => {
      const endpoint = voiceEndpoint(edit.endpoint);
      const model = edit.model.trim() || "gpt-live-1";
      const voice = edit.voice.trim() || "marin";
      return briefly(this.host, async (goose) => {
        const previous = await read(goose);
        if (
          endpoint &&
          !edit.key &&
          (endpoint !== previous.endpoint || !previous.saved)
        )
          throw new Error("Enter an API key for this endpoint.");
        const remove = (key: string, isSecret = false) =>
          goose.request(
            "_goose/unstable/config/remove",
            { key, isSecret },
            REQUEST_TIMEOUT_MS,
          );
        const put = (key: string, value: string, isSecret = false) =>
          goose.request(
            "_goose/unstable/config/upsert",
            {
              key,
              value,
              isSecret,
            },
            REQUEST_TIMEOUT_MS,
          );
        try {
          await remove(ENDPOINT);
          if (!endpoint) await remove(KEY, true);
          else if (edit.key) await put(KEY, edit.key, true);
          await put(MODEL, model);
          await put(VOICE, voice);
          if (endpoint) await put(ENDPOINT, endpoint);
          return await read(goose);
        } catch (error) {
          // Refuse all subsequent starts even if the old process is busy.
          try {
            this.toggle(false);
          } catch {
            /* Admission is already closed. */
          }
          await remove(ENDPOINT).catch(() => undefined);
          await remove(KEY, true).catch(() => undefined);
          throw new Error(
            "Voice settings could not be saved. Voice is now off.",
            { cause: error },
          );
        }
      });
    });
  }
}

async function read(goose: GooseProcess): Promise<VoiceSettings> {
  const values = await Promise.all(
    [ENDPOINT, MODEL, VOICE, KEY].map(async (key) => {
      const result = (await goose.request(
        "_goose/unstable/config/read",
        {
          key,
          isSecret: key === KEY,
        },
        REQUEST_TIMEOUT_MS,
      )) as { value?: unknown };
      return typeof result.value === "string" ? result.value : "";
    }),
  );
  return {
    endpoint: values[0]?.trim() || "",
    model: values[1] || "gpt-live-1",
    voice: values[2] || "marin",
    saved: Boolean(values[0]?.trim() && values[3]),
  };
}
