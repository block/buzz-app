// An example Agents2 type with no network: each agent replies, as itself, with its
// configured text when it is mentioned or one of its watches fires.
import { useState } from "react";
import type { PluginModule } from "../../plugins/api";
import type { AgentViewProps } from "../../features/agents2/service";
import { Button } from "../../shared/design-system/ui/Button";
import { Field } from "../../shared/design-system/ui/Field";
import { Textarea } from "../../shared/design-system/ui/Textarea";

type Config = { reply: string };

export const inject = ["agents2"];
export const apply: PluginModule["apply"] = (ctx) => {
  ctx.agents2.register<Config>({
    id: "responder",
    title: "Responder",
    description:
      "Replies with set text when mentioned or when a watch matches.",
    defaults: () => ({
      config: { reply: "On it." },
      attention: {
        "interest/default": {
          type: "interest",
          instructions: "Reply to anything addressed to this agent.",
        },
      },
    }),
    summary: (agent) => `Replies “${agent.config.reply}”`,
    Peek: ({ agent }) => (
      <div className="grid gap-1">
        <p className="m-0 text-caption text-secondary">Replies with</p>
        <p className="m-0 whitespace-pre-wrap text-body-sm">
          {agent.config.reply.trim() || "Nothing yet; it stays quiet."}
        </p>
      </div>
    ),
    tabs: [{ id: "reply", title: "Reply", component: ReplyTab }],
    run: async ({ trigger, agent, config }) => {
      if (trigger.type === "timer") return;
      const { event } = trigger;
      const channel = event.tags.find((tag) => tag[0] === "h")?.[1];
      if (!channel || !config.reply.trim()) return;
      const root =
        event.tags.find((tag) => tag[0] === "e" && tag[3] === "root")?.[1] ??
        event.id;
      await agent.publish({
        kind: 9,
        content: config.reply,
        tags: [
          ["h", channel],
          ["e", root, "", "root"],
          ...(root === event.id ? [] : [["e", event.id, "", "reply"]]),
          ["p", event.pubkey],
        ],
      });
    },
  });
};

function ReplyTab({ agent, save }: AgentViewProps<Config>) {
  const [reply, setReply] = useState(agent.config.reply);
  const [pending, setPending] = useState(false);
  return (
    <div className="grid gap-2 pt-4">
      <Field label="Reply text">
        <Textarea
          rows={4}
          value={reply}
          onChange={(event) => setReply(event.target.value)}
        />
      </Field>
      <div>
        <Button
          size="compact"
          loading={pending}
          disabled={reply === agent.config.reply}
          onClick={() => {
            setPending(true);
            void save({ config: { reply } }).finally(() => setPending(false));
          }}
        >
          Save
        </Button>
      </div>
    </div>
  );
}
