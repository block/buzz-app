import {
  openaiMark,
  chevronDown,
} from "../../../../src/shared/design-system/icons/svg.ts";
import { conversationHistory } from "./history.ts";
import type { AgentConfigProps, Context } from "@buzz/author";
import type { ChangeEvent, CSSProperties, ReactNode } from "react";
import {
  defaults,
  effortName,
  parseConfig,
  type Config,
  type Model,
} from "./config.ts";
import { AppServer } from "./rpc.ts";
import {
  createRunner,
  controlCommand,
  RUN_TIMEOUT_MS,
  type Sessions,
} from "./run.ts";
export const inject = ["react", "relay", "host", "agentTypes"];
export function apply(ctx: Context) {
  const h = ctx.react.createElement;
  const connect: Context["host"]["connectCommand"] = (id, options) =>
    ctx.host.connectCommand(id, options);
  // WebKit's native menulist appearance otherwise ignores the host field sizing.
  const selectStyle: CSSProperties = {
    appearance: "none",
    backgroundImage: `url("data:image/svg+xml,${encodeURIComponent(chevronDown.replaceAll("currentColor", "#888"))}")`,
    backgroundRepeat: "no-repeat",
    backgroundPosition: "right 12px center",
    backgroundSize: "16px",
    paddingRight: 36,
  };
  function Configure({
    config,
    disabled,
    onChange,
  }: AgentConfigProps<unknown>) {
    const value = parseConfig(config);
    const [models, setModels] = ctx.react.useState<Model[]>([]);
    const [error, setError] = ctx.react.useState("");
    const [attempt, retry] = ctx.react.useState(0);
    const [loading, setLoading] = ctx.react.useState(true);
    ctx.react.useEffect(() => {
      const abort = new AbortController();
      const rpc = new AppServer();
      setLoading(true);
      setError("");
      void (async () => {
        try {
          await rpc.open(connect, abort.signal);
          const found: Model[] = [];
          let cursor: string | null = null;
          do {
            const result: { data: Model[]; nextCursor: string | null } =
              await rpc.request("model/list", { limit: 100, cursor });
            found.push(...result.data);
            cursor = result.nextCursor;
          } while (cursor);
          if (!abort.signal.aborted) setModels(found);
        } catch (problem) {
          if (!abort.signal.aborted)
            setError(
              String(problem instanceof Error ? problem.message : problem),
            );
        } finally {
          rpc.close();
          if (!abort.signal.aborted) setLoading(false);
        }
      })();
      return () => {
        abort.abort();
        rpc.close();
      };
    }, [attempt]);
    const selected =
      models.find((m) => m.model === value.model) ??
      (!value.model ? models.find((m) => m.isDefault) : undefined);
    const set = (patch: Partial<Config>) => onChange({ ...value, ...patch });
    const field = (label: string, control: ReactNode, help?: string) =>
      h(
        "label",
        { className: "buzz-field" },
        h("span", { className: "buzz-field-label" }, label),
        control,
        help && h("span", { className: "buzz-field-description" }, help),
      );
    return h(
      "div",
      { className: "space-y-4" },
      h(
        "div",
        { className: "space-y-2" },
        h(
          "div",
          { className: "flex items-center gap-3" },
          h(
            "span",
            {
              className:
                "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl",
              style: {
                backgroundColor: "#111",
                width: 40,
                height: 40,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
                borderRadius: 12,
              },
            },
            h("img", {
              src: `data:image/svg+xml,${encodeURIComponent(openaiMark.replaceAll("currentColor", "white"))}`,
              width: 26,
              height: 26,
              alt: "",
            }),
          ),
          h(
            "div",
            null,
            h("p", { className: "text-body font-semibold" }, "Codex"),
            h(
              "p",
              { className: "text-caption text-secondary" },
              "Your workspace. Your OpenAI models.",
            ),
          ),
        ),

        h(
          "p",
          { className: "text-body-sm text-secondary" },
          "Uses your Codex account. Each conversation keeps its own coding session.",
        ),
        h(
          "p",
          { className: "text-body-sm text-secondary", role: "status" },
          loading
            ? "Connecting to Codex…"
            : error
              ? "Codex needs attention"
              : `${models.length} ${models.length === 1 ? "model" : "models"} available`,
        ),
        error &&
          h(
            "div",
            { role: "alert", className: "text-body-sm" },
            error,
            h("p", null, "Install Codex and run codex login, then try again."),
            h(
              "button",
              {
                type: "button",
                className: "buzz-button",
                disabled,
                onClick: () => retry((n) => n + 1),
              },
              "Reconnect",
            ),
          ),
      ),
      field(
        "Model",
        h(
          "select",
          {
            "aria-label": "Model",
            className: "buzz-input",
            style: selectStyle,
            disabled: disabled || loading,
            value: value.model,
            onChange: (event: ChangeEvent<HTMLSelectElement>) => {
              const model = models.find((m) => m.model === event.target.value);
              set({
                model: event.target.value,
                effort: model?.defaultReasoningEffort ?? "",
              });
            },
          },
          h(
            "option",
            { value: "" },
            selected && !value.model
              ? `Codex default · ${selected.displayName}`
              : "Codex default",
          ),
          value.model &&
            !models.some((m) => m.model === value.model) &&
            h("option", { value: value.model }, `${value.model} (unavailable)`),
          ...models.map((m) =>
            h("option", { key: m.model, value: m.model }, m.displayName),
          ),
        ),
        selected?.description,
      ),
      field(
        "Thinking",
        h(
          "select",
          {
            "aria-label": "Thinking",
            className: "buzz-input",
            style: selectStyle,
            disabled: disabled || loading || !selected,
            value: value.effort,
            onChange: (event: ChangeEvent<HTMLSelectElement>) =>
              set({ effort: event.target.value }),
          },
          h("option", { value: "" }, "Model default"),
          ...(selected?.supportedReasoningEfforts.map((e) =>
            h(
              "option",
              { key: e.reasoningEffort, value: e.reasoningEffort },
              effortName(e.reasoningEffort),
            ),
          ) ?? []),
        ),
        selected?.supportedReasoningEfforts.find(
          (e) =>
            e.reasoningEffort ===
            (value.effort || selected.defaultReasoningEffort),
        )?.description,
      ),
      field(
        "Instructions",
        h("textarea", {
          "aria-label": "Instructions",
          className: "buzz-textarea",
          rows: 3,
          disabled,
          value: value.instructions,
          placeholder: "What should this agent focus on?",
          onChange: (event: ChangeEvent<HTMLTextAreaElement>) =>
            set({ instructions: event.target.value }),
        }),
        "Buzz's base instructions are included automatically.",
      ),
      h(
        "p",
        { className: "text-body-sm text-secondary" },
        "Codex edits files in your workspace. Mentions queue while it works; use /steer to redirect or /stop to cancel.",
      ),
    );
  }
  const sessions: Sessions = {
    get(key) {
      try {
        return (
          JSON.parse(
            localStorage.getItem(`buzz.codex-session.v1:${key}`) ?? "null",
          ) ?? undefined
        );
      } catch {
        return undefined;
      }
    },
    delete(key) {
      localStorage.removeItem(`buzz.codex-session.v1:${key}`);
    },
    set(key, value) {
      localStorage.setItem(
        `buzz.codex-session.v1:${key}`,
        JSON.stringify(value),
      );
    },
  };
  const run = createRunner(connect, sessions, (delivery, signal) =>
    conversationHistory(delivery, (filters) =>
      ctx.relay.snapshot().session.read(filters, { signal }),
    ),
  );
  ctx.agentTypes.register({
    id: "codex",
    title: "Codex",
    description:
      "OpenAI's coding agent, with your models, thinking controls, and native tools.",
    defaults,
    Configure,
    workspace: "required",
    conversationContext: true,
    concurrency: 16,
    // Up to 15 admitted deliveries can wait behind the active 29-minute turn.
    // The runner starts its work deadline only after that wait.
    timeoutMs: RUN_TIMEOUT_MS * 16,
    control: (event, agent) => controlCommand(event.content, agent.name),
    subscription: (_config, agent) => ({ kinds: [9], "#p": [agent.pubkey] }),
    run: (delivery) => run(delivery, ctx.relay.snapshot().scope ?? ""),
  });
}
