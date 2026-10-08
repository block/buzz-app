// An example Agents2 type with no network: each agent replies, as itself, with its
// configured text when it is mentioned or one of its watches fires.
//
// It is written the way an external plugin must be: React comes from `ctx.react`,
// and the only imports from the app are types, so the controls are plain HTML.
import type { PluginModule } from "../../plugins/api";
import type { AgentViewProps } from "../../features/agents2/service";

type Config = { reply: string };

export const inject = ["react", "agents2"];
export const apply: PluginModule["apply"] = (ctx) => {
  const { useState } = ctx.react;

  function ReplyTab({ agent, save }: AgentViewProps<Config>) {
    const [reply, setReply] = useState(agent.config.reply);
    const [pending, setPending] = useState(false);
    return (
      <div style={{ display: "grid", gap: "var(--space-2)" }}>
        <label
          className="text-label"
          style={{ display: "grid", gap: "var(--space-1)" }}
        >
          Reply text
          <textarea
            rows={4}
            value={reply}
            onChange={(event) => setReply(event.target.value)}
          />
        </label>
        <div>
          <button
            type="button"
            disabled={pending || reply === agent.config.reply}
            onClick={() => {
              setPending(true);
              void save({ reply }).finally(() => setPending(false));
            }}
          >
            {pending ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    );
  }

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
      <div style={{ display: "grid", gap: "var(--space-1)" }}>
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
      // Reply in the trigger's thread, or start one under the trigger. Buzz
      // threads by the NIP-10 `reply` marker (a lone `root` tag is top-level),
      // and a thread reply written by the app carries only `reply` to its root.
      const marked = (marker: string) =>
        event.tags.reduce<string | undefined>(
          (found, tag) =>
            tag[0] === "e" && tag[3] === marker ? tag[1] : found,
          undefined,
        );
      const parent = marked("reply");
      const root = parent ? (marked("root") ?? parent) : event.id;
      await agent.publish({
        kind: 9,
        content: config.reply,
        tags: [
          ["h", channel],
          ...(root === event.id ? [] : [["e", root, "", "root"]]),
          ["e", event.id, "", "reply"],
          ["p", event.pubkey],
        ],
      });
    },
  });
};
