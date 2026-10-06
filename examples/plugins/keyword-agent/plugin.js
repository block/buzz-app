// Prebuilt API v1 module: an agent type with no network access or dependencies.
// Each agent created from it replies, as itself, to messages that contain its word.
export const inject = ["react", "agentTypes"];

export function apply(ctx) {
  const h = ctx.react.createElement;
  const field = (label, value, disabled, onChange, placeholder) =>
    h(
      "label",
      { style: { display: "grid", gap: "0.25rem" } },
      h("span", null, label),
      h("input", {
        value,
        disabled,
        placeholder,
        onChange: (event) => onChange(event.target.value),
      }),
    );

  ctx.agentTypes.register({
    id: "keyword",
    title: "Keyword responder",
    description: "Replies in a thread when a message contains a word.",
    defaults: { word: "deploy", channel: "" },
    Configure: ({ config, onChange, disabled }) =>
      h(
        "div",
        { style: { display: "grid", gap: "0.75rem" } },
        field("Word", config.word, disabled, (word) =>
          onChange({ ...config, word }),
        ),
        field(
          "Channel id",
          config.channel,
          disabled,
          (channel) => onChange({ ...config, channel: channel.trim() }),
          "Any channel you receive",
        ),
      ),
    validate: (config) => (config.word.trim() ? undefined : "Enter a word"),
    subscription: (config) => ({
      kinds: [9],
      ...(config.channel ? { "#h": [config.channel] } : {}),
    }),
    run: async ({ event, channelId, agent, config }) => {
      const word = config.word.trim().toLowerCase();
      if (!channelId || !event.content.toLowerCase().includes(word)) return;
      await agent.publish({
        kind: 9,
        content: `${agent.name} heard "${config.word.trim()}".`,
        tags: [
          ["h", channelId],
          ["e", event.id, "", "reply"],
        ],
      });
    },
  });
}
