import { Context } from "@deepseek-ai/cordis";
import { expect, vi } from "vitest";
import { PluginRuntime } from "../../plugins/runtime";
import { ConversationService } from "./service";
import type { SendTransform } from "./contracts";

const plugin = {
  manifest: { id: "test.send", name: "Send", apiVersion: 1 as const },
  enabled: true,
  source: "external" as const,
  revision: "one",
  previous: null,
  reloadable: true,
  error: null,
};

/** Registers `transforms` through `registerSendTransform` in a real plugin
 * runtime, as an installed plugin would. `service` is the conversation
 * extension a composer reads; `disable` removes the plugin again. */
export async function sendTransformPlugin(
  ...transforms: readonly SendTransform[]
) {
  const root = new Context();
  const runtime = new PluginRuntime(root, async () => ({
    inject: ["conversation"],
    apply(ctx) {
      for (const transform of transforms)
        ctx.conversation.registerSendTransform(transform);
    },
  }));
  const service = new ConversationService(root);
  runtime.reconcile([plugin]);
  await vi.waitFor(() =>
    expect(service.sendTransforms.snapshot()).toHaveLength(transforms.length),
  );
  return {
    service,
    disable: () => runtime.reconcile([]),
    async dispose() {
      await runtime.dispose();
      await root.fiber.dispose();
    },
  };
}
