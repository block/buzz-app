import { afterEach, expect, it, vi } from "vitest";
import { createAgentControl } from "./control";
import { controlFixture } from "./control-testing";
import { agentDraft, agentEdit } from "../../bundled/agents/agent-edit";

afterEach(() => vi.restoreAllMocks());
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
it("browser is unavailable without any host or runner", async () => {
  const control = createAgentControl(null);
  await control.refresh();
  expect(control.snapshot().status).toBe("unavailable");
  await expect(control.action("x", "start")).rejects.toThrow("desktop app");
});
it("coalesces reads and cannot replace post-action state with a stale read", async () => {
  const fixture = controlFixture();
  const control = createAgentControl(fixture.host);
  await control.refresh();
  const old = structuredClone(fixture.data);
  const late = deferred<typeof old>();
  vi.spyOn(fixture.host, "snapshot").mockReturnValue(late.promise);
  const first = control.refresh();
  expect(control.refresh()).toBe(first);
  await control.action("fixture-agent", "stop");
  late.resolve(old);
  await first;
  expect(control.snapshot().data?.agents[0]?.enabled).toBe(false);
  expect(control.snapshot().data?.agents[0]?.status).toBe("stopped");
});
it("does not optimistically mark an action successful or admit concurrent writes", async () => {
  const fixture = controlFixture();
  const control = createAgentControl(fixture.host);
  await control.refresh();
  const action = deferred<typeof fixture.data>();
  vi.spyOn(fixture.host, "action").mockReturnValue(action.promise);
  const pending = control.action("fixture-agent", "stop");
  expect(control.snapshot().busy).toBe(true);
  expect(control.snapshot().data?.agents[0]?.status).toBe("running");
  await expect(control.action("fixture-agent", "start")).rejects.toThrow(
    "in progress",
  );
  action.resolve({ ...fixture.data, agents: [] });
  await pending;
  expect(control.snapshot().data?.agents).toEqual([]);
  expect(control.snapshot().busy).toBe(false);
});
it("uncertain writes retain last evidence and allow only explicit recovery Stop", async () => {
  const fixture = controlFixture();
  const control = createAgentControl(fixture.host);
  await control.refresh();
  vi.spyOn(fixture.host, "action").mockRejectedValue(
    new Error("RAW OUTPUT MUST NOT DISPLAY"),
  );
  await expect(control.action("fixture-agent", "stop")).rejects.toThrow(
    "confirm",
  );
  expect(control.snapshot().error).not.toContain("RAW OUTPUT");
  expect(control.snapshot().status).toBe("error");
  expect(control.snapshot().data?.agents[0]?.status).toBe("running");
  await expect(control.action("fixture-agent", "start")).rejects.toThrow(
    "Refresh",
  );
  await expect(control.action("fixture-agent", "stop")).rejects.toThrow(
    "confirm",
  );
  expect(fixture.host.action).toHaveBeenCalledTimes(2);
  expect(control.snapshot().status).toBe("error");
  expect(control.snapshot().data?.agents[0]?.enabled).toBe(true);
  await control.refresh();
  expect(control.snapshot().status).toBe("ready");
});
it("save leaves running revision alone; omitted environment values stay host-only", async () => {
  const fixture = controlFixture();
  const control = createAgentControl(fixture.host);
  await control.refresh();
  const agent = fixture.agent;
  const edit = agentEdit({ ...agentDraft(agent), name: "New name" });
  const saved = await control.save(agent.id, 1, edit);
  expect(saved.agents[0]?.revision).toBe(2);
  expect(saved.agents[0]?.runningRevision).toBe(1);
  expect(saved.agents[0]?.harness.environmentKeys).toEqual(["EXAMPLE_TOKEN"]);
  expect(fixture.calls.filter((call) => call.action === "restart")).toEqual([]);
  await expect(control.save(agent.id, 1, edit)).rejects.toThrow();
});
it("subscription cleanup and disposal never send stop or accept a late snapshot", async () => {
  const fixture = controlFixture();
  const control = createAgentControl(fixture.host);
  const listener = vi.fn();
  const unsubscribe = control.subscribe(listener);
  await control.refresh();
  unsubscribe();
  const late = deferred<typeof fixture.data>();
  vi.spyOn(fixture.host, "snapshot").mockReturnValue(late.promise);
  const pending = control.refresh();
  const before = control.snapshot();
  listener.mockClear();
  control.dispose();
  late.resolve({ runtimeAvailable: false, agents: [] });
  await pending;
  expect(listener).not.toHaveBeenCalled();
  expect(control.snapshot()).toBe(before);
  expect(fixture.calls.some((call) => call.action === "stop")).toBe(false);
});
it("failed refresh exposes retry while retaining the last snapshot", async () => {
  const fixture = controlFixture();
  const control = createAgentControl(fixture.host);
  await control.refresh();
  vi.spyOn(fixture.host, "snapshot").mockRejectedValue("failure");
  await control.refresh();
  expect(control.snapshot().status).toBe("error");
  expect(control.snapshot().data?.agents).toHaveLength(1);
});
it("status failure admits only Stop for a retained identity and still serializes it", async () => {
  const fixture = controlFixture();
  const control = createAgentControl(fixture.host);
  await control.refresh();
  vi.spyOn(fixture.host, "snapshot").mockRejectedValue("unreadable store");
  await control.refresh();
  const before = [...fixture.calls];
  const edit = agentEdit(agentDraft(fixture.agent));
  for (const attempt of [
    () => control.action("fixture-agent", "start"),
    () => control.action("fixture-agent", "restart"),
    () => control.action("unknown-agent", "stop"),
    () => control.save("fixture-agent", 1, edit),
    () => control.previewImport("installed"),
    () => control.commitImport("fixture-preview", ["second-fixture"]),
  ]) {
    await expect(attempt()).rejects.toThrow("Refresh");
  }
  expect(fixture.calls).toEqual(before);
  const action = deferred<typeof fixture.data>();
  const nativeAction = vi
    .spyOn(fixture.host, "action")
    .mockReturnValue(action.promise);
  const stopping = control.action("fixture-agent", "stop");
  expect(nativeAction).toHaveBeenCalledExactlyOnceWith("fixture-agent", "stop");
  expect(control.snapshot().busy).toBe(true);
  await expect(control.action("fixture-agent", "stop")).rejects.toThrow(
    "in progress",
  );
  action.resolve({ ...fixture.data, agents: [] });
  await stopping;
  expect(control.snapshot().status).toBe("ready");
});
it("Stop recovery requires retained evidence, an available host and a live projection", async () => {
  const fixture = controlFixture();
  const control = createAgentControl(fixture.host);
  await expect(control.action("fixture-agent", "stop")).rejects.toThrow(
    "Refresh",
  );
  const read = vi
    .spyOn(fixture.host, "snapshot")
    .mockRejectedValue("unreadable store");
  await control.refresh();
  await expect(control.action("fixture-agent", "stop")).rejects.toThrow(
    "Refresh",
  );
  read.mockRestore();
  await control.refresh();
  control.dispose();
  await expect(control.action("fixture-agent", "stop")).rejects.toThrow(
    "desktop app",
  );
  const browser = createAgentControl(null);
  await expect(browser.action("fixture-agent", "stop")).rejects.toThrow(
    "desktop app",
  );
  expect(fixture.calls.filter((call) => call.action !== "snapshot")).toEqual(
    [],
  );
});
it("import forwards exact selection and never starts imported agents", async () => {
  const fixture = controlFixture();
  const control = createAgentControl(fixture.host);
  await control.refresh();
  const preview = await control.previewImport("development");
  await control.commitImport(preview.token, ["second-fixture"]);
  expect(fixture.calls.slice(-2)).toEqual([
    { action: "preview", payload: "development" },
    {
      action: "import",
      payload: { token: preview.token, ids: ["second-fixture"] },
    },
  ]);
  expect(control.snapshot().data?.agents[1]?.enabled).toBe(false);
});
