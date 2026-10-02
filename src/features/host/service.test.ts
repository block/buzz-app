import { Context } from "@deepseek-ai/cordis";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { beforeEach, expect, it, vi } from "vitest";
import { HostService } from "./service";

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: vi.fn(),
  invoke: vi.fn(),
  Channel: class {
    onmessage: (message: unknown) => void = () => {};
  },
}));
type Events = { onmessage(message: unknown): void };
/** Answers `plugin_host_fetch` with a head and exposes that call's event channel. */
function nativeFetch(status = 200) {
  const native: { events?: Events; request?: unknown; cancelled: string[] } = {
    cancelled: [],
  };
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    const input = args as Record<string, unknown>;
    if (command === "plugin_host_fetch_cancel")
      return void native.cancelled.push(input.streamId as string);
    native.events = input.onEvent as Events;
    native.request = input;
    return { status, headers: { "content-type": "text/event-stream" } };
  });
  return native;
}

beforeEach(() => {
  vi.mocked(isTauri).mockReturnValue(true);
  vi.mocked(invoke).mockReset();
});

function pluginContext() {
  const root = new Context();
  new HostService(root);
  return {
    root,
    plugin: root.extend({
      pluginOwner: { id: "example.plugin", revision: "abc" },
    }),
  };
}

it("uses the calling plugin identity and preserves bounded command output", async () => {
  const { plugin } = pluginContext();
  vi.mocked(invoke).mockResolvedValue("ready \n");
  await expect(plugin.host.runCommand("status")).resolves.toBe("ready \n");
  expect(invoke).toHaveBeenCalledWith("plugin_host_run_command", {
    id: "example.plugin",
    revision: "abc",
    commandId: "status",
  });
});

it("keeps native command failures and browser calls nullable", async () => {
  const { root, plugin } = pluginContext();
  vi.mocked(invoke).mockRejectedValue(new Error("secret stderr"));
  await expect(plugin.host.runCommand("status")).resolves.toBeNull();
  await expect(root.host.runCommand("status")).resolves.toBeNull();
  vi.mocked(isTauri).mockReturnValue(false);
  await expect(plugin.host.runCommand("status")).resolves.toBeNull();
  expect(invoke).toHaveBeenCalledTimes(1);
});

it("routes HTTPS requests with plugin identity and rejects browser requests", async () => {
  const { plugin } = pluginContext();
  const response = {
    status: 200,
    headers: { "content-type": "application/json" },
    body: "{}",
  };
  vi.mocked(invoke).mockResolvedValue(response);
  const request = {
    url: "https://api.example.com/graphql",
    method: "POST" as const,
    headers: { Authorization: "Bearer token" },
    body: "{}",
  };
  await expect(plugin.host.request(request)).resolves.toEqual(response);
  expect(invoke).toHaveBeenCalledWith("plugin_host_request", {
    id: "example.plugin",
    revision: "abc",
    request,
  });
  vi.mocked(isTauri).mockReturnValue(false);
  await expect(plugin.host.request(request)).rejects.toThrow(/desktop plugin/);
});

it("streams a declared-origin response body through a platform Response", async () => {
  const { plugin } = pluginContext();
  const native = nativeFetch();
  const response = await plugin.host.fetch("https://api.example.com/v1", {
    method: "post",
    headers: { Authorization: "Bearer token" },
    body: "{}",
  });
  expect(native.request).toMatchObject({
    id: "example.plugin",
    revision: "abc",
    request: {
      url: "https://api.example.com/v1",
      method: "POST",
      headers: { authorization: "Bearer token" },
      body: "{}",
    },
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("text/event-stream");
  const reader = response.body?.getReader() as ReadableStreamDefaultReader;
  const decoder = new TextDecoder();
  // The first chunk is readable before the body has ended.
  native.events?.onmessage({ type: "chunk", text: "data: a\n" });
  expect(decoder.decode((await reader.read()).value)).toBe("data: a\n");
  native.events?.onmessage({ type: "chunk", text: "data: é\n" });
  native.events?.onmessage({ type: "end" });
  expect(decoder.decode((await reader.read()).value)).toBe("data: é\n");
  expect((await reader.read()).done).toBe(true);
  expect(native.cancelled).toEqual([]);
});

it("fails the body on a native stream error and rejects unusable calls", async () => {
  const { root, plugin } = pluginContext();
  const native = nativeFetch();
  const response = await plugin.host.fetch("https://api.example.com/v1");
  native.events?.onmessage({ type: "error", message: "Host response stalled" });
  await expect(response.text()).rejects.toThrow("Host response stalled");
  await expect(
    plugin.host.fetch("https://api.example.com/v1", {
      method: "POST",
      body: new Uint8Array(1),
    }),
  ).rejects.toThrow(/text bodies/);
  await expect(root.host.fetch("https://api.example.com/v1")).rejects.toThrow(
    /desktop plugin/,
  );
  vi.mocked(invoke).mockRejectedValue("Host request origin is not declared");
  await expect(plugin.host.fetch("https://other.example/")).rejects.toThrow(
    "Host request origin is not declared",
  );
});

it("cancels the native stream when the caller aborts or stops reading", async () => {
  const { plugin } = pluginContext();
  const native = nativeFetch();
  const controller = new AbortController();
  const response = await plugin.host.fetch("https://api.example.com/v1", {
    signal: controller.signal,
  });
  const streamId = (native.request as { streamId: string }).streamId;
  const reading = response.text();
  controller.abort(new Error("stopped"));
  await expect(reading).rejects.toThrow("stopped");
  expect(native.cancelled).toEqual([streamId]);
  // A late native event after cancellation is ignored.
  native.events?.onmessage({ type: "chunk", text: "late" });

  const second = await plugin.host.fetch("https://api.example.com/v1");
  await second.body?.cancel();
  expect(native.cancelled).toHaveLength(2);

  // An abort before the headers arrive rejects with the caller's reason.
  const early = new AbortController();
  vi.mocked(invoke).mockImplementation((command) =>
    command === "plugin_host_fetch"
      ? new Promise((_, reject) =>
          early.signal.addEventListener("abort", () =>
            reject("Host request was cancelled"),
          ),
        )
      : Promise.resolve(),
  );
  const pending = plugin.host.fetch("https://api.example.com/v1", {
    signal: early.signal,
  });
  early.abort(new Error("too slow"));
  await expect(pending).rejects.toThrow("too slow");
});
