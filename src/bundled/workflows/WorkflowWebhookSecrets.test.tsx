// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { StrictMode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createWorkflows } from "../../features/workflows/capability";
import { createOutbox } from "../../features/relay/outbox";
import { keypair, signed } from "../../features/relay/testing";
import type { RelayEvent } from "../../features/relay/events";
import { WorkflowWebhookSecrets } from "./WorkflowWebhookSecrets";

const channelId = "11111111-1111-4111-8111-111111111111";
const disposers: (() => void)[] = [];
afterEach(() => {
  cleanup();
  for (const dispose of disposers.splice(0)) dispose();
});
function mount() {
  const key = keypair();
  let allowed = true;
  const publish = vi.fn(
    async (event: RelayEvent) =>
      `response:${JSON.stringify({
        workflow_id: event.tags.find(([tag]) => tag === "d")?.[1],
        webhook_secret: `secret-${event.id}`,
      })}`,
  );
  const outbox = createOutbox(
    key.pubkey,
    {
      kinds: [30620],
      sign: async (template) => signed(key, template),
      publish,
    },
    { load: () => [], save: () => {} },
    {
      needsReceipt: () => true,
      onReceipt: (event, message) => workflows.receipt(event, message),
    },
  );
  const workflows = createWorkflows({
    reader: undefined,
    viewer: key.pubkey,
    outbox: outbox.outbox,
    local: outbox.local,
    host: { runs: async () => ({ runs: [], next: null }) },
    canAccess: () => allowed,
  });
  disposers.push(() => {
    workflows.dispose();
    outbox.dispose();
  });
  const take = vi.fn(workflows.capability.takeWebhookSecret);
  render(
    <StrictMode>
      <WorkflowWebhookSecrets
        capability={{ ...workflows.capability, takeWebhookSecret: take }}
      />
    </StrictMode>,
  );
  const save = async () => {
    let eventId = "";
    await act(async () => {
      eventId = workflows.capability.save({
        channelId,
        yaml: "name: Hook\ntrigger: { on: webhook }\nsteps: [{ id: wait, action: delay, duration: 1s }]\n",
      });
      await vi.waitFor(() =>
        expect(
          workflows.capability.operations
            .snapshot()
            .find((op) => op.eventId === eventId)?.outcome,
        ).toBe("succeeded"),
      );
    });
    return eventId;
  };
  return {
    ...workflows,
    take,
    save,
    revoke() {
      allowed = false;
      workflows.clear();
    },
  };
}

it.each(["clear", "revoke", "dispose"] as const)(
  "purges a secret already taken into the dialog on %s",
  async (reason) => {
    const h = mount();
    const id = await h.save();
    expect(screen.getByRole("dialog", { name: "Webhook ready" })).toBeVisible();
    expect(h.take).toHaveBeenCalledTimes(1);
    fireEvent.click(
      screen.getByRole("button", { name: "Reveal webhook secret" }),
    );
    expect(screen.getByTestId("webhook-secret")).toHaveTextContent(
      `secret-${id}`,
    );
    act(() => h[reason]());
    expect(screen.queryByRole("dialog", { name: "Webhook ready" })).toBeNull();
    expect(document.body.textContent).not.toContain(`secret-${id}`);
    expect(h.capability.takeWebhookSecret(id)).toBeUndefined();
  },
);

it("retains the taken secret on transient interruption and delivers queued secrets sequentially", async () => {
  const h = mount();
  const first = await h.save();
  fireEvent.click(
    screen.getByRole("button", { name: "Reveal webhook secret" }),
  );
  act(() => h.interrupt());
  expect(screen.getByTestId("webhook-secret")).toHaveTextContent(
    `secret-${first}`,
  );
  const second = await h.save();
  expect(h.take).toHaveBeenCalledTimes(1);
  expect(screen.getByTestId("webhook-secret")).toHaveTextContent(
    `secret-${first}`,
  );
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  expect(h.take).toHaveBeenCalledTimes(2);
  expect(screen.getByTestId("webhook-secret")).toHaveTextContent(
    "•".repeat(24),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Reveal webhook secret" }),
  );
  expect(screen.getByTestId("webhook-secret")).toHaveTextContent(
    `secret-${second}`,
  );
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  expect(screen.queryByRole("dialog", { name: "Webhook ready" })).toBeNull();
  expect(h.capability.takeWebhookSecret(first)).toBeUndefined();
  expect(h.capability.takeWebhookSecret(second)).toBeUndefined();
});
