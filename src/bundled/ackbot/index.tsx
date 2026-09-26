import type { PluginModule } from "../../plugins/api";
import type {
  AgentProviderSetupProps,
  AgentWork,
  AgentProviderHost,
} from "../../features/agents/providers";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";

export const inject = ["agentProviders"];

function AckbotSetup({ value, onChange, disabled }: AgentProviderSetupProps) {
  return (
    <Field
      label="Reply"
      description="Posted in the thread, as this agent, each time it is mentioned."
    >
      <Input
        disabled={disabled}
        value={value.reply ?? ""}
        onChange={(event) => onChange({ ...value, reply: event.target.value })}
      />
    </Field>
  );
}

/** No model or harness: one bundled `buzz` process replies as the agent. */
export async function ack(work: AgentWork, host: AgentProviderHost) {
  const reply = work.agent.config.reply?.trim() || "ack";
  const result = await host.invoke({
    program: "buzz",
    args: [
      "messages",
      "send",
      "--channel",
      work.channelId,
      "--reply-to",
      work.replyTo,
      "--content",
      reply,
    ],
    timeoutSeconds: 30,
  });
  if (result.timedOut || result.exitCode !== 0)
    throw new Error(
      result.timedOut
        ? "Ackbot timed out"
        : `Ackbot reply failed (${result.exitCode}): ${result.stderr.slice(0, 500)}`,
    );
}

export const apply: PluginModule["apply"] = (ctx) => {
  ctx.agentProviders.register({
    id: "ackbot",
    title: "Ackbot",
    description:
      "Replies in the thread whenever it is mentioned. No model or harness.",
    setup: AckbotSetup,
    defaultConfig: { reply: "ack" },
    handle: ack,
  });
};
