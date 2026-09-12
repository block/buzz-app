import type {
  WorkflowCapability,
  WorkflowDefinition,
  WorkflowOperation,
  WorkflowView,
} from "../../features/workflows/types";

export const fixtureViewer = "11".repeat(32);
export const fixtureChannel = "44444444-4444-4444-8444-444444444444";
export const fixtureYaml = `# Keep this comment on opening
name: Message helper
enabled: false
trigger:
  on: message_posted
steps:
  - id: notify
    action: send_message
    text: Hello from a fixture
`;
export const fixtureDefinition: WorkflowDefinition = {
  id: "55555555-5555-4555-8555-555555555555",
  owner: fixtureViewer,
  channelId: fixtureChannel,
  revision: "aa".repeat(32),
  createdAt: 1_789_224_000,
  yaml: fixtureYaml,
};

export function fixtureView<T>(data: T) {
  let current: ReturnType<WorkflowView<T>["snapshot"]> = {
    status: "idle",
    data,
  };
  const listeners = new Set<() => void>();
  let disposed = false;
  const update = (next: typeof current) => {
    current = next;
    for (const listener of listeners) listener();
  };
  const view: WorkflowView<T> = {
    snapshot: () => current,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async refresh() {
      if (!disposed && current.status !== "unavailable")
        update({ ...current, status: "ready" });
    },
    dispose() {
      disposed = true;
      listeners.clear();
    },
  };
  return { view, update, disposed: () => disposed };
}

/** Explicit offline test capability; never used by the bundled plugin entry. */
export function createWorkflowFixture() {
  const definitions = fixtureView({
    items: [fixtureDefinition] as readonly WorkflowDefinition[],
    partial: false,
  });
  const listeners = new Set<() => void>();
  let operations: readonly WorkflowOperation[] = [];
  let counter = 0;
  let savedInput: Parameters<WorkflowCapability["save"]>[0] | undefined;
  const calls = { save: 0, delete: 0, trigger: 0, runs: 0, approvals: 0 };
  const publish = (next: readonly WorkflowOperation[]) => {
    operations = next;
    for (const listener of listeners) listener();
  };
  const start = (
    action: WorkflowOperation["action"],
    workflow: WorkflowDefinition,
  ) => {
    const eventId = (++counter).toString(16).padStart(64, "0");
    publish([
      ...operations,
      {
        eventId,
        workflow,
        action,
        delivery: "sending",
        outcome: "pending",
        secretAvailable: false,
      },
    ]);
    return eventId;
  };
  const capability: WorkflowCapability = {
    availability: {
      definitions: true,
      history: true,
      save: true,
      trigger: true,
      delete: true,
      webhookSecrets: false,
    },
    definitions: () => definitions.view,
    runs: () => {
      calls.runs++;
      return fixtureView({ runs: [], next: null }).view;
    },
    approvals: () => {
      calls.approvals++;
      return fixtureView([]).view;
    },
    save(input) {
      calls.save++;
      savedInput = input;
      return start(
        "save",
        input.existing ?? {
          ...fixtureDefinition,
          id: "66666666-6666-4666-8666-666666666666",
          yaml: input.yaml,
        },
      );
    },
    delete(workflow) {
      calls.delete++;
      return start("delete", workflow);
    },
    trigger(workflow) {
      calls.trigger++;
      return start("trigger", workflow);
    },
    operations: {
      snapshot: () => operations,
      subscribe(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      retry() {},
      async dismiss() {},
    },
    takeWebhookSecret() {
      return undefined;
    },
  };
  return {
    capability,
    definitions,
    calls,
    input: () => savedInput,
    finish(outcome: WorkflowOperation["outcome"], exact = true) {
      const operation = operations.at(-1);
      if (!operation) throw new Error("No operation");
      if (
        outcome === "succeeded" &&
        operation.action === "save" &&
        savedInput
      ) {
        const revision = exact ? operation.eventId : "bb".repeat(32);
        definitions.update({
          status: "ready",
          data: {
            partial: false,
            items: [
              {
                ...fixtureDefinition,
                ...operation.workflow,
                revision,
                yaml: savedInput.yaml,
              },
            ],
          },
        });
      }
      if (outcome === "succeeded" && operation.action === "delete")
        definitions.update({
          status: "ready",
          data: { partial: false, items: [] },
        });
      publish(
        operations.map((item) =>
          item.eventId === operation.eventId
            ? {
                ...item,
                outcome,
                delivery: outcome === "rejected" ? "failed" : "accepted",
                ...(outcome === "rejected"
                  ? { error: "Fixture conflict" }
                  : {}),
              }
            : item,
        ),
      );
    },
    revoke() {
      definitions.update({
        status: "unavailable",
        data: { items: [], partial: false },
      });
      publish([]);
    },
  };
}
