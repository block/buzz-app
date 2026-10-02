import type { ChangeEvent, ReactNode } from "react";
import type { AgentConfigProps, Context } from "@buzz/author";
import {
  API_KEY,
  defaults,
  parseConfig,
  PROVIDERS,
  type Config,
  type Provider,
} from "./config.ts";
import { run, RUN_TIMEOUT_MS } from "./run.ts";

export const inject = ["react", "relay", "host", "agentTypes"];

export function apply(ctx: Context) {
  const h = ctx.react.createElement;

  // The host's form classes, so the fields match the Name field above them.
  function Configure({
    config,
    disabled,
    onChange,
  }: AgentConfigProps<unknown>) {
    const value = parseConfig(config);
    const set = (patch: Partial<Config>) => onChange({ ...value, ...patch });
    const field = (label: string, control: ReactNode) =>
      h(
        "label",
        { className: "buzz-field" },
        h("span", { className: "buzz-field-label" }, label),
        control,
      );
    return h(
      ctx.react.Fragment,
      null,
      field(
        "Provider",
        h(
          "select",
          {
            className: "buzz-input",
            disabled,
            value: value.provider,
            onChange: (event: ChangeEvent<HTMLSelectElement>) =>
              set({ provider: event.target.value as Provider }),
          },
          Object.entries(PROVIDERS).map(([id, provider]) =>
            h("option", { key: id, value: id }, provider.title),
          ),
        ),
      ),
      field(
        "Model",
        h("input", {
          className: "buzz-input",
          disabled,
          value: value.model,
          placeholder: PROVIDERS[value.provider].model,
          onChange: (event: ChangeEvent<HTMLInputElement>) =>
            set({ model: event.target.value }),
        }),
      ),
      field(
        "Instructions",
        h("textarea", {
          className: "buzz-textarea",
          disabled,
          value: value.instructions,
          onChange: (event: ChangeEvent<HTMLTextAreaElement>) =>
            set({ instructions: event.target.value }),
        }),
      ),
    );
  }

  ctx.agentTypes.register<unknown>({
    id: "assistant",
    title: "AI SDK assistant",
    description:
      "Answers when mentioned, using your Anthropic or OpenAI API key. It reads and posts in the channel it is mentioned in. Given a workspace folder, it also reads and edits files and runs commands there.",
    defaults,
    Configure,
    secrets: [{ name: API_KEY, label: "API key for the provider" }],
    workspace: true,
    subscription: (_config, agent) => ({ kinds: [9], "#p": [agent.pubkey] }),
    timeoutMs: RUN_TIMEOUT_MS,
    // One run at a time: two runs would edit the same files at once.
    concurrency: 1,
    run: (delivery) =>
      run(delivery, {
        // Read on every call so the host sees the calling plugin's context.
        fetch: (input, init) => ctx.host.fetch(input, init),
        // The session is replaced on reconnect, so take the current one per call.
        read: (filters, signal) =>
          ctx.relay.snapshot().session.read(filters, { signal }),
        names: async (pubkeys) => {
          const profiles = ctx.relay.snapshot().session.profiles;
          await profiles.ensure(pubkeys);
          const known = profiles.snapshot();
          return new Map(
            pubkeys.flatMap((pubkey) => {
              const name = known.get(pubkey)?.name;
              return name ? [[pubkey, name] as const] : [];
            }),
          );
        },
      }),
  });
}
