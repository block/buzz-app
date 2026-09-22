import { expect, it, vi } from "vitest";
import {
  createAgentModels,
  type ModelCatalog,
  type ModelRequest,
} from "./models";
import { createAgentControl } from "./control";
import { controlFixture } from "./control-testing";
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const request: ModelRequest = {
  id: "sample",
  expectedRevision: 1,
  edit: {
    name: "Sample",
    systemPrompt: "",
    workspace: "/tmp",
    harness: {
      command: "buzz-agent",
      args: [],
      provider: "databricks_v2",
      model: "",
    },
    environment: {},
  },
  host: "https://example.com",
  filter: "",
  action: "connect",
};
const data: ModelCatalog = {
  host: "https://example.com",
  models: [{ id: "exact.id", name: "Exact label" }],
  modelOverridden: false,
  disconnected: false,
};
it("constructing/disposing without a click never invokes native auth", () => {
  const host = { begin: vi.fn(), run: vi.fn(), cancel: vi.fn() };
  const service = createAgentModels(host);
  service.dispose();
  expect(host.begin).not.toHaveBeenCalled();
  expect(host.run).not.toHaveBeenCalled();
  expect(host.cancel).not.toHaveBeenCalled();
});
it("cancellation overtaking begin prevents run, including late begin", async () => {
  const begin = deferred<number>();
  const host = {
    begin: () => begin.promise,
    run: vi.fn(),
    cancel: vi.fn(async () => {}),
  };
  const service = createAgentModels(host);
  const abort = new AbortController();
  const pending = service.request(request, abort.signal);
  abort.abort();
  begin.resolve(7);
  await expect(pending).rejects.toThrow("cancelled");
  expect(host.run).not.toHaveBeenCalled();
  expect(host.cancel).toHaveBeenCalledWith(7);
});
it("real control composition keeps Stop and Save independent of model waits and fences disposal", async () => {
  const fixture = controlFixture();
  const response = deferred<ModelCatalog>();
  const run = vi.fn(() => response.promise);
  const cancel = vi.fn(async () => {});
  fixture.host.models = { begin: async () => 4, run, cancel };
  const control = createAgentControl(fixture.host);
  await control.refresh();
  if (!control.models) throw new Error("Missing model capability");
  const pending = control.models.request(request, new AbortController().signal);
  await vi.waitFor(() => expect(run).toHaveBeenCalledWith(4, request));
  await control.action(fixture.agent.id, "stop");
  await control.save(fixture.agent.id, fixture.agent.revision, {
    name: "Saved",
    systemPrompt: "",
    workspace: "/tmp",
    harness: {
      command: "buzz-agent",
      args: [],
      model: "",
      provider: "databricks_v2",
    },
    environment: {},
  });
  expect(control.snapshot().busy).toBe(false);
  control.dispose();
  expect(cancel).toHaveBeenCalledWith(4);
  response.resolve(data);
  await expect(pending).rejects.toThrow("cancelled");
});
it("success projects IDs; raw transport failures are hidden; retry is explicit", async () => {
  const host = {
    begin: vi.fn(async () => 1),
    run: vi.fn(async () => data),
    cancel: vi.fn(async () => {}),
  };
  const service = createAgentModels(host);
  const signal = new AbortController().signal;
  expect(await service.request(request, signal)).toEqual(data);
  host.run.mockRejectedValueOnce(new Error("SECRET_TRANSPORT"));
  await expect(service.request(request, signal)).rejects.not.toThrow(
    "SECRET_TRANSPORT",
  );
  expect(host.begin).toHaveBeenCalledTimes(2);
  expect(await service.request(request, signal)).toEqual(data);
});

it("hung transport settles on cancellation; a late native ticket is still retired", async () => {
  const begin = deferred<number>();
  const host = {
    begin: () => begin.promise,
    run: vi.fn(),
    cancel: vi.fn(async () => {}),
  };
  const service = createAgentModels(host);
  const abort = new AbortController();
  const pending = service.request(request, abort.signal);
  abort.abort();
  await expect(pending).rejects.toThrow("cancelled");
  begin.resolve(93);
  await vi.waitFor(() => expect(host.cancel).toHaveBeenCalledWith(93));
  expect(host.run).not.toHaveBeenCalled();
});
