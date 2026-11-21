import { expect, it } from "vitest";
import { createInlineDelivery } from "./inline-delivery";
import { createPanelMemory } from "./panel-memory";
it("locks synchronously without retaining composer text or targets", () => {
  const delivery = createInlineDelivery();
  expect(delivery.begin()).toBe(true);
  expect(delivery.begin()).toBe(false);
  delivery.update({ busy: false, unknown: true, attempt: "attempt" });
  expect(delivery.begin()).toBe(false);
  expect(delivery.get()).toEqual({
    busy: false,
    unknown: true,
    attempt: "attempt",
    error: undefined,
    sentUrl: undefined,
  });
});
it("shares only delivery knowledge across canonical PR panels", () => {
  const memory = createPanelMemory();
  const delivery = memory.delivery(
    "https://github.com/Example-org/Sample/pull/1",
  );
  delivery.update({ unknown: true, attempt: "attempt" });
  expect(memory.delivery("https://github.com/example-org/sample/pull/1")).toBe(
    delivery,
  );
  expect(
    memory.delivery("https://github.com/example-org/sample/pull/2").get()
      .unknown,
  ).toBe(false);
});
