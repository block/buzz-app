import type { Context } from "@deepseek-ai/cordis";
import type { AgentControl } from "./control";
import { createNativeAgentControl } from "./control-native";

/** The root owns the projection; native startup/quit owns the processes. */
export function provideAgentControl(ctx: Context): AgentControl {
  const control = createNativeAgentControl();
  ctx.provide("agentControl", control);
  ctx.effect(() => () => control.dispose());
  return control;
}
