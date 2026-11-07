import { describe, expect, it, vi } from "vitest";
import { fakeSpawn } from "./goose-testing";
import { GooseProcess, REQUEST_TIMEOUT_MS } from "./goose";
import { GooseVoiceSettings, voiceEndpoint } from "./voice-settings";

const endpoint = "GOOSE_LIVE_VOICE_ENDPOINT";
const key = "GOOSE_LIVE_VOICE_API_KEY";
const a = "http://a.example.org/v1/live/sessions";
const b = "http://b.example.org/v1/live/sessions";
const edit = {
  endpoint: b,
  key: "token-b",
  model: "gpt-live-1",
  voice: "marin",
};
function setup(
  configWrite?: NonNullable<Parameters<typeof fakeSpawn>[0]>["configWrite"],
) {
  const config = new Map<string, unknown>([
    [endpoint, a],
    [key, "token-a"],
  ]);
  const fake = fakeSpawn({ config, ...(configWrite && { configWrite }) });
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  } as Storage;
  const changed = vi.fn();
  const settings = new GooseVoiceSettings(fake, storage, changed);
  return { fake, config, settings, changed, storage };
}

describe("voice settings admission and credentials", () => {
  it("defaults off, masks secrets, and clears shell overrides at launch", async () => {
    const { settings, fake } = setup();
    expect(settings.enabled).toBe(false);
    expect(await settings.read()).toEqual({
      endpoint: a,
      saved: true,
      model: "gpt-live-1",
      voice: "marin",
    });
    const run = vi.fn();
    await expect(
      settings.start(new AbortController().signal, run),
    ).rejects.toThrow("Turn on");
    expect(run).not.toHaveBeenCalled();
    expect(fake.geese[0]?.env).toMatchObject({
      GOOSE_LIVE_VOICE_ENABLED: "false",
      GOOSE_LIVE_VOICE_ENDPOINT: null,
      GOOSE_LIVE_VOICE_MODEL: null,
      GOOSE_LIVE_VOICE_API_KEY: null,
      GOOSE_LIVE_VOICE: null,
    });
  });

  it("refuses a changed endpoint with the previous Saved key before writing (D9)", async () => {
    const { settings, config } = setup();
    await expect(settings.save({ ...edit, key: "" })).rejects.toThrow(
      "Enter an API key",
    );
    expect(config.get(endpoint)).toBe(a);
    expect(config.get(key)).toBe("token-a");
  });

  it("reads again before save, so an external endpoint edit cannot reuse Saved", async () => {
    const { settings, config } = setup();
    await settings.read();
    config.set(endpoint, b);
    await expect(
      settings.save({ ...edit, endpoint: a, key: "" }),
    ).rejects.toThrow("Enter an API key");
    expect(config.get(endpoint)).toBe(b);
  });

  it("does not recycle on key saves and removes the key when choosing OpenAI", async () => {
    const { settings, changed, config } = setup();
    await settings.setEnabled(true);
    changed.mockClear();
    await settings.save({ ...edit, key: "12345" });
    expect(config.get(key)).toBe("12345");
    expect(changed).not.toHaveBeenCalled();
    await settings.save({ ...edit, endpoint: "", key: "" });
    expect(config.has(endpoint)).toBe(false);
    expect(config.has(key)).toBe(false);
    expect(changed).not.toHaveBeenCalled();
  });

  it("holds a start across writes, then fails closed while the old process stays alive (D10)", async () => {
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const writing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const { settings, fake, config } = setup(async (method, params) => {
      if (method.endsWith("/upsert") && params.key === endpoint) {
        entered();
        await gate;
        throw new Error("endpoint write failed");
      }
    });
    await settings.setEnabled(true);
    const old = await GooseProcess.start(fake.spawn, {
      cwd: "/",
      env: { GOOSE_LIVE_VOICE_ENABLED: "true" },
    });
    const process = fake.geese[0];
    if (!process) throw new Error("Expected a running process");
    const save = settings.save(edit);
    const failed = expect(save).rejects.toThrow("Voice is now off");
    await writing;
    const run = vi.fn(() =>
      old.request("_goose/unstable/session/live-voice/start", {}),
    );
    const start = settings.start(new AbortController().signal, run);
    const refused = expect(start).rejects.toThrow("Turn on");
    try {
      expect(run).not.toHaveBeenCalled();
    } finally {
      release();
    }
    await failed;
    await refused;
    expect(process.killed).toBe(false);
    expect(settings.enabled).toBe(false);
    expect(config.has(endpoint)).toBe(false);
    expect(config.has(key)).toBe(false);
    expect(run).not.toHaveBeenCalled();
    expect(
      process.received.filter((m) => m.method?.endsWith("live-voice/start")),
    ).toEqual([]);
    await old.kill();
  });

  it("starts only after a successful save has written the matching pair", async () => {
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const writing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const { settings, config } = setup(async (method, params) => {
      if (method.endsWith("/upsert") && params.key === key) {
        entered();
        await gate;
      }
    });
    await settings.setEnabled(true);
    const save = settings.save(edit);
    await writing;
    const run = vi.fn(async () => [config.get(endpoint), config.get(key)]);
    const start = settings.start(new AbortController().signal, run);
    try {
      expect(config.has(endpoint)).toBe(false);
      expect(run).not.toHaveBeenCalled();
    } finally {
      release();
    }
    await save;
    expect(await start).toEqual([b, "token-b"]);
  });
});

it.each([
  "file:///tmp/live",
  "https://user@example.org/live",
  "https://example.org/live?",
  "https://example.org/live#",
])("rejects invalid endpoint %s", (endpoint) => {
  expect(() => voiceEndpoint(endpoint)).toThrow();
});

it("releases serialized settings after a silent ACP read times out", async () => {
  vi.useFakeTimers();
  const fake = fakeSpawn({ silent: ["_goose/unstable/config/read"] });
  const storage = {
    getItem: () => null,
    setItem: vi.fn(),
  } as unknown as Storage;
  const settings = new GooseVoiceSettings(fake, storage, vi.fn());
  try {
    const failed = expect(settings.read()).rejects.toThrow("did not answer");
    const toggled = settings.setEnabled(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(
      fake.geese[0]?.received.some(
        (m) => m.method === "_goose/unstable/config/read",
      ),
    ).toBe(true);
    expect(settings.enabled).toBe(false);
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
    await failed;
    await toggled;
    expect(settings.enabled).toBe(true);
    expect(fake.geese[0]?.killed).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});

it("refuses to enable voice when the device preference cannot be saved", async () => {
  const { settings, storage, changed } = setup();
  vi.spyOn(storage, "setItem").mockImplementation(() => {
    throw new Error("storage unavailable");
  });
  await expect(settings.setEnabled(true)).rejects.toThrow(
    "storage unavailable",
  );
  expect(settings.enabled).toBe(false);
  expect(changed).not.toHaveBeenCalled();
  const start = vi.fn();
  await expect(
    settings.start(new AbortController().signal, start),
  ).rejects.toThrow("Turn on");
  expect(start).not.toHaveBeenCalled();
});
