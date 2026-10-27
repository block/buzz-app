import { attentionOf } from "../../../features/agents/attention";
import { relayOrigin } from "../../../features/communities/destination";
import { relayPartition } from "../../../features/relay/partition";
import { GitHubPolicyPanel } from "./GitHubPolicyEditor";
import { avatarMedia } from "../../../shared/avatar-source";
import { Avatar } from "../../../shared/design-system/ui/Avatar";
import {
  ChatCircleIcon,
  LockIcon,
  HashIcon,
  ClockIcon,
  GitPullRequestIcon,
  TerminalWindowIcon,
  CodeIcon,
  CaretDownIcon,
  CaretRightIcon,
  TrashIcon,
  PlusIcon,
} from "../../../shared/design-system/icons";
import * as React from "react";
import {
  PanelHeader,
  PanelHeaderLabel,
} from "../../../shared/design-system/ui/PanelHeader";
import { Button } from "../../../shared/design-system/ui/Button";
import { IconButton } from "../../../shared/design-system/ui/IconButton";
import { Switch as SharedSwitch } from "../../../shared/design-system/ui/Switch";
import { Select } from "../../../shared/design-system/ui/Select";
import type { Context } from "../../../plugins/author";
import type { Agent, Watch } from "./model";
import { createRecipeForm } from "./recipes";
import { InstructionsMarkdown } from "./InstructionsMarkdown";

import "./AttentionPage.css";

const title = (id: string) =>
  id.replace(/^interest\//, "").replace(/[-_]+/g, " ");
export function heading(value: string) {
  return {
    text: value
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/^#+\s*/, "")
      .replace(/\*\*|__|`/g, "")
      .trim(),
    url: /\]\((https:\/\/[^)\s]+)\)/.exec(value)?.[1],
  };
}
export function describe(
  watch: Watch,
  name: (id: string) => string,
  now = Date.now() / 1000,
  usedOccurrences?: number,
) {
  const delivery = watch.channel
    ? `Delivers to ${name(watch.channel)}${watch.root ? " (thread)" : ""}`
    : "Independent agent turn";
  if (watch.type === "timer") {
    const used =
      usedOccurrences ??
      Math.max(0, Math.floor((now - watch.armed_at) / watch.interval_secs));
    const schedule =
      watch.max_occurrences === 1
        ? `Once · ${new Date((watch.armed_at + watch.interval_secs) * 1000).toLocaleDateString() === new Date(now * 1000).toLocaleDateString() ? "today" : new Date((watch.armed_at + watch.interval_secs) * 1000).toLocaleDateString()} ${new Date((watch.armed_at + watch.interval_secs) * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} (${watch.armed_at + watch.interval_secs > now ? "in " : ""}${Math.ceil(Math.abs(watch.armed_at + watch.interval_secs - now) / 60)}m${watch.armed_at + watch.interval_secs > now ? "" : " ago"})`
        : `Every ${watch.interval_secs % 3600 === 0 ? `${watch.interval_secs / 3600}h` : watch.interval_secs % 60 === 0 ? `${watch.interval_secs / 60}m` : `${watch.interval_secs}s`}${watch.max_occurrences === null ? "" : ` · ${watch.max_occurrences} runs`}`;
    return {
      title: schedule,
      detail: `${watch.prompt} · ${delivery}${watch.expires_at === null ? "" : ` · Ends ${new Date(watch.expires_at * 1000).toLocaleString()}`}`,
      spent:
        (watch.max_occurrences !== null && used >= watch.max_occurrences) ||
        (watch.expires_at !== null && now >= watch.expires_at),
    };
  }
  if (watch.type === "source")
    return {
      title: watch.name || watch.provider,
      detail: `${watch.provider} · ${delivery}`,
    };
  const channels =
    watch.channels === "all"
      ? "all joined channels"
      : watch.channels.map(name).join(", ");
  return {
    title: watch.name || "Messages",
    detail: `Listens in ${channels} · ${delivery}${watch.classifier ? " · Relevance classifier" : ""}`,
  };
}
type Channel = {
  id: string;
  name: string;
  channelType?: string;
  private?: true;
};
/** Matches the sidebar: chats and DMs, private channels, then ordinary channels. */
const channelIcon = (channel?: Channel) =>
  channel?.channelType === "solo" || channel?.channelType === "dm"
    ? ChatCircleIcon
    : channel?.private
      ? LockIcon
      : HashIcon;
const button = { variant: "ghost" as const, size: "sm" as const };

/** Uses the host’s controls and surface roles. */
export function createPage({
  agents,
  relay,
  navigation,
  host,
}: Pick<Context, "agents" | "relay" | "navigation" | "host">) {
  const h = React.createElement;
  const RecipeForm = createRecipeForm({ agents, relay });
  const none = () => () => {};
  const noChannels = { channels: [] as { id: string; name: string }[] };
  const emptyChannels = () => noChannels;
  const problem = (error: string) =>
    error &&
    h("p", { role: "alert", className: "text-body-sm text-danger" }, error);
  function useAction() {
    const [pending, setPending] = React.useState(false);
    const [error, setError] = React.useState("");
    const run = async (action: () => Promise<void>) => {
      if (pending) return;
      setPending(true);
      setError("");
      try {
        await action();
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        setPending(false);
      }
    };
    return { pending, error, run };
  }
  function Switch({
    label,
    tooltip,
    checked,
    disabled,
    onClick,
  }: {
    label: string;
    tooltip?: string;
    checked: boolean;
    disabled: boolean;
    onClick(): void;
  }) {
    return h(SharedSwitch, {
      "aria-label": label,
      title: tooltip || label,
      checked,
      disabled,
      onCheckedChange: onClick,
    });
  }
  function Destination({
    channel,
    root,
    name,
    scope,
    summary,
  }: {
    channel: string;
    root?: string | undefined;
    name: string;
    scope?: string | undefined;
    summary?: Channel | undefined;
  }) {
    const text = h(
      "span",
      { className: "attention-destination-label" },
      "→",
      h(channelIcon(summary), { size: 16, "aria-hidden": true }),
      h(
        "span",
        { className: "attention-channel-name" },
        `${name}${root ? " thread" : ""}`,
      ),
    );
    const at = scope?.lastIndexOf(":") ?? -1;
    if (!scope || at < 0)
      return h(
        "span",
        { className: "text-caption text-subtle", title: `Delivers to ${name}` },
        text,
      );
    return (
      <Button
        {...{
          ...button,
          variant: "link",
          size: "inline",
          type: "button",
          title: `Delivers to ${name}`,
          "aria-label": `Open destination ${name}`,
          onClick: () =>
            void navigation.open({
              version: 1,
              kind: "conversation",
              scope: {
                communityOrigin: scope.slice(0, at),
                viewer: scope.slice(at + 1),
              },
              channelId: channel,
              ...(root ? { messageId: root, threadRootId: root } : {}),
            }),
        }}
      >
        {text}
      </Button>
    );
  }
  function Subscription({
    agent,
    slug,
    watch,
    name,
    find,
    scope,
    returnFocus,
  }: {
    agent: Agent;
    slug: string;
    watch: Watch;
    name(id: string): string;
    find(id: string): Channel | undefined;
    scope?: string | undefined;
    returnFocus: React.RefObject<HTMLButtonElement | null>;
  }) {
    const row = React.useRef<HTMLLIElement>(null);
    React.useLayoutEffect(
      () => () => {
        if (row.current?.contains(document.activeElement))
          returnFocus.current?.focus();
      },
      [returnFocus],
    );
    const [open, setOpen] = React.useState(false);
    const action = useAction();
    const detailsId = React.useId();
    const history = (
      agent as Agent & {
        attentionHistory?: Record<
          string,
          { lastWokeAt?: number; output?: string }
        >;
      }
    ).attentionHistory?.[slug];
    const woke = history?.lastWokeAt
      ? `Last woke ${Math.max(0, Math.floor((Date.now() / 1000 - history.lastWokeAt) / 60))}m ago`
      : undefined;
    const timer = agent.timers[slug];
    const description = describe(
      watch,
      name,
      Date.now() / 1000,
      watch.type === "timer" && timer?.armedAt === watch.armed_at
        ? timer.used
        : undefined,
    );
    const label = heading(
      ("name" in watch && watch.name) ||
        title(watch.interest_id ?? slug.slice(6)),
    );
    const completed =
      watch.type === "source" &&
      agent.sourceRuns?.[slug] === JSON.stringify(agent.attention[slug]);
    const state = completed
      ? "Completed"
      : description.spent
        ? "Spent"
        : !watch.enabled
          ? "Paused"
          : !agent.attentionEnabled
            ? "Agent paused"
            : "On";
    const change = (value: Watch | null) =>
      action.run(() =>
        agents.save(agent.key, { attention: { [slug]: value } }),
      );
    const section = (label: string, content: ReturnType<typeof h>) =>
      h(
        "section",
        { key: label },
        h("h4", { className: "text-label-sm text-subtle" }, label),
        content,
      );
    const type =
      watch.type === "event"
        ? "Messages"
        : watch.type === "timer"
          ? "Schedule"
          : watch.provider === "attention/github-pr"
            ? "GitHub PR"
            : watch.provider === "attention/command"
              ? "Command"
              : "Function";
    const TypeIcon =
      type === "Messages"
        ? ChatCircleIcon
        : type === "Schedule"
          ? ClockIcon
          : type === "GitHub PR"
            ? GitPullRequestIcon
            : type === "Command"
              ? TerminalWindowIcon
              : CodeIcon;
    const pr =
      watch.type === "source" &&
      watch.provider === "attention/github-pr" &&
      typeof watch.config.pr === "string"
        ? /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)$/.exec(
            watch.config.pr,
          )
        : null;
    const target = pr
      ? `${pr[1]?.split("/")[1]}#${pr[2]}`
      : watch.type === "event"
        ? watch.channels === "all"
          ? "All joined channels"
          : watch.channels.map((id) => name(id)).join(", ")
        : watch.type === "timer"
          ? description.title
          : watch.provider === "attention/command" &&
              Array.isArray(watch.config.command)
            ? ("name" in watch && watch.name) ||
              watch.config.command
                .slice(0, 2)
                .map((part, index) =>
                  index ? part : String(part).split(/[\\/]/).pop(),
                )
                .join(" ")
            : label.text;
    const destination = watch.channel
      ? `→ ${name(watch.channel)}${watch.root ? " thread" : ""}`
      : "Independent turn";
    return h(
      "li",
      {
        ref: row,
        className: "attention-card",
        "data-paused":
          completed ||
          description.spent ||
          !watch.enabled ||
          !agent.attentionEnabled
            ? ""
            : undefined,
      },
      h(
        "div",
        { className: "attention-head" },
        h(
          pr ? "a" : "button",
          {
            className: "attention-heading",
            ...(pr
              ? {
                  href:
                    watch.type === "source"
                      ? String(watch.config.pr)
                      : undefined,
                  target: "_blank",
                  rel: "noreferrer",
                  "aria-label": `Open ${target}`,
                }
              : {
                  type: "button",
                  "aria-label": `Details for ${label.text}`,
                  "aria-expanded": open,
                  "aria-controls": detailsId,
                  onClick: () => setOpen(!open),
                }),
          },
          !pr &&
            h(open ? CaretDownIcon : CaretRightIcon, {
              size: 16,
              "aria-hidden": true,
            }),
          h(
            "span",
            { className: "attention-type text-caption", title: type },
            h(TypeIcon, { size: 16, "aria-hidden": true }),
            h("span", { className: "attention-type-label" }, type),
          ),
          h(
            "span",
            {
              className: "attention-title text-caption text-primary",
              title:
                watch.type === "timer" && watch.max_occurrences === 1
                  ? new Date(
                      (watch.armed_at + watch.interval_secs) * 1000,
                    ).toLocaleString()
                  : label.text,
            },
            watch.type === "event" && watch.channels !== "all"
              ? watch.channels.map((id, index) =>
                  h(
                    "span",
                    { key: id, className: "attention-destination-label" },
                    index > 0 ? ", " : null,
                    h(channelIcon(find(id)), { size: 16, "aria-hidden": true }),
                    h(
                      "span",
                      { className: "attention-channel-name" },
                      name(id),
                    ),
                  ),
                )
              : target,
          ),
          pr &&
            h(
              "span",
              { className: "attention-subtitle text-body-sm text-subtle" },
              label.text.replace(/^(?:PR\s+\d+:?\s*|[^ ]*#\d+\s*)/i, ""),
            ),
        ),
        h(
          "div",
          { className: "attention-destination text-caption text-subtle" },
          watch.channel
            ? h(Destination, {
                channel: watch.channel,
                root: watch.root,
                name: name(watch.channel),
                scope,
                summary: find(watch.channel),
              })
            : destination,
        ),
        state !== "On" &&
          h("span", { className: "text-caption text-subtle" }, state),
        h(
          "div",
          { className: "attention-actions" },
          !completed &&
            !description.spent &&
            h(Switch, {
              label: `Watch ${label.text}`,
              checked: watch.enabled,
              disabled: action.pending,
              onClick: () => void change({ ...watch, enabled: !watch.enabled }),
            }),
          <Button
            {...{
              ...button,
              shape: "icon",
              type: "button",
              "aria-label": `Delete ${label.text}`,
              title: "Delete watch",
              disabled: action.pending,
              focusableWhenDisabled: true,
              onClick: () => void change(null),
            }}
          >
            {h(TrashIcon, { size: 16, "aria-hidden": true })}
          </Button>,
        ),
      ),
      woke &&
        h("p", { className: "text-caption text-subtle attention-meta" }, woke),
      problem(action.error),
      open &&
        h(
          "div",
          { id: detailsId, className: "attention-details" },
          watch.type === "source" && watch.provider === "attention/command"
            ? section(
                "Command",
                h(
                  "pre",
                  { className: "text-caption text-standard" },
                  h(
                    "code",
                    null,
                    Array.isArray(watch.config.command)
                      ? watch.config.command.join(" ")
                      : label.text,
                  ),
                ),
              )
            : !pr &&
                h(
                  "p",
                  { className: "text-body-sm text-secondary" },
                  watch.type === "source"
                    ? label.text
                    : watch.type === "event"
                      ? `New messages in ${watch.channels === "all" ? "all joined channels" : watch.channels.map(name).join(", ")}${watch.classifier ? ", filtered for relevance" : ""}.`
                      : `${description.title}. ${watch.prompt}`,
                ),
          !pr &&
            label.url &&
            h(
              "a",
              {
                href: label.url,
                target: "_blank",
                rel: "noreferrer",
                className: "text-body-sm",
              },
              `Open ${label.text}`,
            ),
          watch.type === "source" &&
            watch.provider === "attention/command" &&
            section(
              "Recent output",
              h(
                "pre",
                { className: "text-caption text-standard" },
                history?.output || "No output recorded yet.",
              ),
            ),
          watch.type === "event" &&
            section(
              "Filters",
              h(
                "div",
                { className: "text-body-sm" },
                h(
                  "p",
                  null,
                  watch.kinds?.length
                    ? `Event kinds: ${watch.kinds.join(", ")}`
                    : "All event kinds",
                ),
                watch.keywords?.length &&
                  h(
                    "p",
                    null,
                    `Message keywords (any): ${watch.keywords.join(", ")}`,
                  ),
                watch.authors?.length &&
                  h("p", null, `Authors: ${watch.authors.join(", ")}`),
                watch.exclude_authors?.length &&
                  h(
                    "p",
                    null,
                    `Excluded authors: ${watch.exclude_authors.join(", ")}`,
                  ),
                watch.is_reply !== undefined &&
                  h(
                    "p",
                    null,
                    watch.is_reply ? "Replies only" : "Top-level messages only",
                  ),
                ...Object.entries(watch.tags ?? {}).map(([tag, values]) =>
                  h("p", { key: tag }, `Tag ${tag}: ${values.join(", ")}`),
                ),
                ...Object.values(watch.classifier?.questions ?? {}).map(
                  (question, index) =>
                    h("p", { key: index }, question.question),
                ),
                !watch.authors?.length &&
                  !watch.exclude_authors?.length &&
                  !watch.tags &&
                  !watch.keywords?.length &&
                  !watch.classifier &&
                  watch.is_reply === undefined &&
                  h("p", null, "No additional filters"),
              ),
            ),
        ),
    );
  }

  function AgentPanel({
    agent,
    channels,
    scope,
    picture,
    returnFocus,
  }: {
    agent: Agent;
    channels: readonly Channel[];
    scope?: string | undefined;
    picture?: string | undefined;
    returnFocus: React.RefObject<HTMLButtonElement | null>;
  }) {
    const action = useAction();
    const find = (id: string) => channels.find((channel) => channel.id === id);
    const name = (id: string) => find(id)?.name ?? `Channel ${id.slice(0, 8)}`;
    const { interests, watches, orphans } = attentionOf(agent.attention);
    const skipped = Object.values(agent.skipped ?? {});
    return h(
      "section",
      { className: "attention-agent", "aria-label": agent.name },
      h(
        "div",
        { className: "attention-agent-head" },
        h(
          "div",
          { className: "attention-agent-name" },
          h(Avatar, {
            alt: "",
            fallback: agent.name,
            src: picture,
            size: "compact",
            shape: "squircle",
          }),
          h("h3", { className: "text-label" }, agent.name),
          h(
            "span",
            { className: "text-caption text-subtle" },
            `${interests.length} interest${interests.length === 1 ? "" : "s"} · ${watches.length} watch${watches.length === 1 ? "" : "es"}`,
          ),
        ),
        h(
          "div",
          { className: "attention-agent-toggle" },
          h("span", { className: "text-caption text-subtle" }, "Attention"),
          h(Switch, {
            label: `Attention for ${agent.name}`,
            tooltip: agent.attentionEnabled
              ? "Pause this agent’s watches"
              : "Resume this agent’s watches",
            checked: agent.attentionEnabled,
            disabled: action.pending,
            onClick: () =>
              void action.run(() =>
                agents.save(agent.key, {
                  attentionEnabled: !agent.attentionEnabled,
                }),
              ),
          }),
        ),
      ),
      problem(action.error),
      ...skipped.map((object) =>
        h(
          "section",
          { key: object.slug, className: "attention-card" },
          h("h4", { className: "text-label-sm" }, object.slug),
          h("p", { className: "text-body-sm text-danger" }, object.problem),
          <Button
            {...{
              ...button,
              type: "button",
              disabled: action.pending,
              onClick: () =>
                void action.run(() =>
                  agents.save(agent.key, {
                    attention: { [object.slug]: null },
                  }),
                ),
            }}
          >{`Remove unreadable ${object.slug}`}</Button>,
        ),
      ),
      ...interests.map((object) => {
        const id = object.slug.slice("interest/".length);
        const interest = object.value;
        const subscriptions = watches.filter(
          (object) => (object.value as Watch).interest_id === id,
        );
        const instructions =
          interest?.type === "interest"
            ? interest.instructions
            : "No instructions saved.";
        const firstLine =
          instructions.split("\n").find((line) => line.trim()) || "";
        const label = /^#+\s/.test(firstLine)
          ? heading(firstLine).text
          : title(id);
        return h(
          "section",
          {
            key: id,
            className: "attention-interest",
            "aria-label": `Interest ${label}`,
          },
          h(
            "div",
            { className: "attention-interest-head" },
            h("span", { className: "text-caption text-subtle" }, "Interest"),
            h("h4", { className: "text-label" }, label),
          ),
          h(
            "details",
            { className: "attention-instructions" },
            h(
              "summary",
              { className: "attention-disclosure text-caption text-subtle" },
              h(CaretRightIcon, { size: 16, "aria-hidden": true }),
              h(
                "span",
                { className: "text-caption text-primary whitespace-nowrap" },
                "Instructions:",
              ),
              h(
                "span",
                { className: "attention-instructions-preview" },
                heading(
                  instructions
                    .split("\n")
                    .find((line) => line.trim() && !/^#+\s/.test(line)) ||
                    firstLine,
                ).text,
              ),
            ),
            <InstructionsMarkdown text={instructions} />,
          ),
          !subscriptions.length &&
            h(
              "p",
              { className: "text-body-sm text-subtle" },
              "No watches yet, so nothing wakes this interest.",
            ),
          h(
            "ul",
            {
              className: "attention-list",
              "aria-label": `${label} watches`,
            },
            ...subscriptions.map((object) =>
              h(Subscription, {
                key: object.slug,
                agent,
                slug: object.slug,
                watch: object.value as Watch,
                name,
                find,
                scope,
                returnFocus,
              }),
            ),
          ),
        );
      }),
      orphans.length > 0 &&
        h(
          "section",
          {
            className: "attention-interest",
            "aria-label": "Without an interest",
          },
          h("h4", { className: "text-label" }, "Without an interest"),
          h(
            "p",
            { className: "text-body-sm text-subtle" },
            "These saved watches have no matching Interest. Remove them and create watches under an Interest.",
          ),
          ...orphans.map((object) =>
            h(
              "div",
              { key: object.slug, className: "attention-agent-head" },
              h("span", { className: "text-body-sm" }, object.slug),
              <Button
                size="sm"
                variant="ghost"
                disabled={action.pending}
                onClick={() =>
                  void action.run(() =>
                    agents.save(agent.key, {
                      attention: { [object.slug]: null },
                    }),
                  )
                }
              >{`Delete ${object.slug}`}</Button>,
            ),
          ),
        ),
    );
  }
  return function AttentionPage() {
    const newWatch = React.useRef<HTMLButtonElement>(null);
    const form = React.useRef<HTMLFormElement>(null);
    const [recipeOpen, setRecipeOpen] = React.useState(false);
    const [adding, setAdding] = React.useState(false);
    const [selected, setSelected] = React.useState("");
    const [notice, setNotice] = React.useState("");
    const action = useAction();
    const snapshot = React.useSyncExternalStore(
      agents.subscribe,
      agents.snapshot,
      agents.snapshot,
    );
    const connection = React.useSyncExternalStore(
      relay.subscribe,
      relay.snapshot,
      relay.snapshot,
    );
    const queries =
      connection.status === "ready" ? connection.session.channels : undefined;
    React.useEffect(() => queries?.ensureList(), [queries]);
    const channels = React.useSyncExternalStore<{
      channels: readonly Channel[];
    }>(
      queries?.subscribeList ?? none,
      queries?.list ?? emptyChannels,
      queries?.list ?? emptyChannels,
    ).channels;
    const running = snapshot.running.filter((agent) => {
      try {
        return (
          relayPartition(relayOrigin(agent.relay), agent.owner) ===
          connection.scope
        );
      } catch {
        return false;
      }
    });
    const visible = running.filter(
      (agent) =>
        Object.values(agent.attention).some(
          (object) => object.value.type !== "interest",
        ) || Object.keys(agent.skipped ?? {}).length > 0,
    );
    const enable = () =>
      action.run(async () => {
        const agent = running.find((agent) => agent.key === selected);
        if (!agent) throw new Error("Choose an available agent.");
        await agents.save(agent.key, { attentionEnabled: true });
        setNotice(
          `Attention enabled for ${agent.name}. Watches appear here when the agent creates them.`,
        );
        setAdding(false);
      });
    return h(
      "section",
      {
        "data-buzz-ui": "",
        className: "attention-page",
        "aria-label": "Agent Attention",
      },

      h(PanelHeader, {
        title: h(PanelHeaderLabel, { title: "Agent Attention" }),
        actions: h(IconButton, {
          ref: newWatch,
          size: "sm",
          variant: "ghost",
          icon: h(PlusIcon, { size: 16, "aria-hidden": true }),
          "aria-label": "New watch",
          title: "New watch",
          onClick: () => setRecipeOpen(!recipeOpen),
          disabled: !running.length,
          "aria-expanded": recipeOpen,
        }),
      }),
      h(
        "div",
        { className: "attention-scroll" },
        h(
          "div",
          { className: "attention-content" },
          h(
            "p",
            { className: "text-body-sm text-subtle" },
            "Interests and watches in this community wake your agents.",
          ),
          <GitHubPolicyPanel host={host} />,
          !visible.length &&
            running.some((agent) => !agent.attentionEnabled) && (
              <Button
                {...{
                  ...button,
                  type: "button",
                  "aria-label": "Add agent",
                  "aria-expanded": adding,
                  onClick: () => setAdding(!adding),
                }}
              >
                {"Enable Attention for an agent"}
              </Button>
            ),
          recipeOpen &&
            h(RecipeForm, {
              running,
              channels,
              formRef: form,
              close: () => {
                if (form.current?.contains(document.activeElement))
                  newWatch.current?.focus();
                setRecipeOpen(false);
              },
            }),
          adding &&
            h(
              "form",
              {
                className: "attention-card attention-details",
                "aria-label": "Enable agent attention",
                onSubmit: (event: { preventDefault(): void }) => {
                  event.preventDefault();
                  void enable();
                },
              },
              h(Select, {
                label: "Agent",
                variant: "field",
                value: selected,
                disabled: action.pending,
                onValueChange: setSelected,
                groups: [
                  {
                    label: "Agents",
                    options: [
                      { value: "", label: "Choose an agent" },
                      ...running.map((agent) => ({
                        value: agent.key,
                        label: agent.name,
                      })),
                    ],
                  },
                ],
              }),
              <Button
                {...{
                  ...button,
                  type: "submit",
                  disabled: !selected || action.pending,
                }}
              >
                {"Enable Attention"}
              </Button>,
              problem(action.error),
            ),
          notice &&
            h(
              "p",
              { role: "status", className: "text-body-sm text-secondary" },
              notice,
            ),
          !visible.length &&
            running.length > 0 &&
            h(
              "p",
              { className: "text-body-sm text-secondary" },
              "No watches yet. Create a watch, or enable Attention for an agent and ask it to watch something.",
            ),
          ...visible.map((agent) =>
            h(AgentPanel, {
              key: agent.key,
              agent: agent as Agent,
              returnFocus: newWatch,
              channels,
              scope: connection.scope,
              picture: avatarMedia(
                agent.picture,
                connection.status === "ready"
                  ? connection.session.media
                  : undefined,
              ),
            }),
          ),
          !running.length &&
            h(
              "p",
              {
                className: "text-body-sm text-secondary",
                role: snapshot.status === "loading" ? "status" : undefined,
              },
              !connection.scope
                ? "Choose a community to manage its agent watches."
                : snapshot.status === "loading"
                  ? "Loading agents…"
                  : snapshot.error || "No local agents are available.",
            ),
        ),
      ),
    );
  };
}
