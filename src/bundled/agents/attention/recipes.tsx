import { parseBuzzLink } from "../../../features/navigation/buzz-links";
import * as React from "react";
import { Field } from "../../../shared/design-system/ui/Field";
import { Input } from "../../../shared/design-system/ui/Input";
import { Textarea } from "../../../shared/design-system/ui/Textarea";
import { Button } from "../../../shared/design-system/ui/Button";
import { Select } from "../../../shared/design-system/ui/Select";
import type { Context } from "../../../plugins/author";
import type { Watch } from "./model";

export type Recipe = {
  kind: "pr" | "schedule" | "command" | "event";
  instructions: string;
  pr: string;
  command: string;
  when: string;
  repeat: string;
  count: string;
  end: string;
  channel: string;
  thread?: string;
  listen?: string;
  kinds?: string;
  keywords?: string;
  question?: string;
  authors?: string;
  exclude?: string;
  replies?: string;
  tags?: string;
  classifier?: string;
  interest?: string;
};
type Channel = { id: string; name: string };
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const eventId = /^[a-f0-9]{64}$/i;
export function conversationLink(
  input: string,
): { channel: string; root?: string; message?: string } | null {
  const link = parseBuzzLink(input.trim());
  if (link?.format !== "legacy" || !uuid.test(link.channelId)) return null;
  return {
    channel: link.channelId.toLowerCase(),
    ...(link.messageId ? { message: link.messageId } : {}),
    ...(link.threadRootId ? { root: link.threadRootId } : {}),
  };
}

export function channelId(input: string, channels: readonly Channel[]): string {
  const value = input.trim();
  const link = conversationLink(value);
  if (link) return link.channel;
  if (uuid.test(value)) return value.toLowerCase();
  const matches = channels.filter(
    (channel) =>
      channel.name.toLowerCase() === value.replace(/^#/, "").toLowerCase(),
  );
  if (matches.length !== 1 || !matches[0])
    throw new Error(
      "Choose a unique channel name or paste a Buzz channel link.",
    );
  return matches[0].id;
}
export function delivery(
  channel: string,
  thread: string,
  channels: readonly Channel[],
): { channel?: string; root?: string } {
  const destination = channel.trim() ? channelId(channel, channels) : undefined;
  if (!thread.trim()) return destination ? { channel: destination } : {};
  const link = conversationLink(thread);
  if (!link?.root) throw new Error("Paste a Buzz thread link.");
  if (destination && destination !== link.channel)
    throw new Error("The thread belongs to a different channel.");
  return { channel: link.channel, root: link.root };
}
/** A copied top-level message can start a thread; a reply must retain its canonical root. */
export async function resolveDelivery(
  channel: string,
  thread: string,
  channels: readonly Channel[],
  read?: (
    id: string,
  ) => Promise<readonly { id: string; tags: readonly (readonly string[])[] }[]>,
) {
  const link = thread.trim() ? conversationLink(thread) : null;
  if (!link || link.root || !link.message)
    return delivery(channel, thread, channels);
  if (!read)
    throw new Error("Connect to the relay to resolve this message link.");
  const message = (await read(link.message)).find(
    (event) =>
      event.id === link.message &&
      event.tags.some((tag) => tag[0] === "h" && tag[1] === link.channel),
  );
  if (!message)
    throw new Error("The linked message is unavailable in this channel.");
  let root: string | undefined, reply: string | undefined;
  for (const [name, value, , marker] of message.tags) {
    if (name !== "e" || !value || !eventId.test(value)) continue;
    if (marker === "root") root = value.toLowerCase();
    if (marker === "reply") reply = value.toLowerCase();
  }
  const target = reply ? (root ?? reply) : link.message;
  return delivery(
    channel,
    `buzz://message?channel=${link.channel}&id=${link.message}&thread=${target}`,
    channels,
  );
}

export function recipeWatch(
  recipe: Recipe,
  id: string,
  now = Math.floor(Date.now() / 1000),
): Watch {
  if (!recipe.interest && !recipe.instructions.trim())
    throw new Error("Describe what the agent should do.");
  const base = {
    interest_id: recipe.interest || id,
    enabled: true,
    ...(recipe.channel ? { channel: recipe.channel } : {}),
    ...(recipe.thread ? { root: recipe.thread } : {}),
  };
  if (recipe.kind === "event") {
    const kinds =
      recipe.kinds?.trim() === "all"
        ? []
        : recipe.kinds?.trim()
          ? recipe.kinds
              .trim()
              .split(/[\s,]+/)
              .map(Number)
          : [9];
    if (
      kinds.length > 100 ||
      kinds.some(
        (kind) => !Number.isSafeInteger(kind) || kind < 0 || kind > 65535,
      )
    )
      throw new Error("Event kinds must be whole numbers between 0 and 65535.");
    const keys = (text: string | undefined) => {
      const values = text?.trim()
        ? [...new Set(text.trim().split(/[\s,]+/))]
        : [];
      if (values.length > 100 || values.some((value) => !eventId.test(value)))
        throw new Error("Authors must be up to 100 hex public keys.");
      return values.map((value) => value.toLowerCase());
    };
    const keywords =
      recipe.keywords
        ?.split("\n")
        .map((value) => value.trim())
        .filter(Boolean) ?? [];
    if (
      keywords.length > 32 ||
      keywords.some(
        (value) =>
          new TextEncoder().encode(value).length > 256 || value.includes("\0"),
      )
    )
      throw new Error("Use up to 32 keywords, each at most 256 bytes.");
    const authors = keys(recipe.authors),
      exclude = keys(recipe.exclude);
    if (authors.length && exclude.length)
      throw new Error("Use either included or excluded authors.");
    const parse = (text: string | undefined, label: string) => {
      if (!text?.trim()) return undefined;
      try {
        const value = JSON.parse(text);
        if (!value || typeof value !== "object" || Array.isArray(value))
          throw new Error();
        return value;
      } catch {
        throw new Error(`${label} must be a JSON object.`);
      }
    };
    const tags = parse(recipe.tags, "Tags");
    const classifier =
      parse(recipe.classifier, "Classifier") ??
      (recipe.question?.trim()
        ? { questions: { relevant: { question: recipe.question.trim() } } }
        : undefined);
    return {
      ...base,
      type: "event",
      since: now,
      channels: recipe.listen ? recipe.listen.split("\n") : "all",
      kinds: [...new Set(kinds)],
      ...(keywords.length ? { keywords } : {}),
      ...(authors.length ? { authors } : {}),
      ...(exclude.length ? { exclude_authors: exclude } : {}),
      ...(recipe.replies ? { is_reply: recipe.replies === "replies" } : {}),
      ...(tags ? { tags } : {}),
      ...(classifier ? { classifier } : {}),
    };
  }
  if (recipe.kind === "pr") {
    const pr = recipe.pr.trim().replace(/\/$/, "");
    if (!/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/[0-9]+$/.test(pr))
      throw new Error("Enter a GitHub pull request URL.");
    return {
      ...base,
      type: "source",
      provider: "attention/github-pr",
      name: `[${pr.split("/").slice(3, 5).join("/")}#${pr.split("/").pop()}](${pr})`,
      config: { pr },
    };
  }
  if (recipe.kind === "command") {
    let command: unknown;
    try {
      command = JSON.parse(recipe.command);
    } catch {
      throw new Error(
        'Enter a command as a JSON argument list, such as ["program", "argument"].',
      );
    }
    if (
      !Array.isArray(command) ||
      !command.length ||
      command.some(
        (value) => typeof value !== "string" || value.includes("\0"),
      ) ||
      !command[0].trim()
    )
      throw new Error("Enter a nonempty command argument list.");
    return {
      ...base,
      type: "source",
      provider: "attention/command",
      name: command.join(" "),
      config: { command },
    };
  }
  const due = Math.floor(Date.parse(recipe.when) / 1000);
  if (!Number.isSafeInteger(due) || due <= now)
    throw new Error("Choose a future start time.");
  const interval = recipe.repeat ? Number(recipe.repeat) * 60 : due - now;
  if (!Number.isSafeInteger(interval) || interval < 1 || interval > 31_536_000)
    throw new Error(
      "Repeat must be between 1 second and one year, in minutes.",
    );
  const count = recipe.repeat
    ? recipe.count
      ? Number(recipe.count)
      : null
    : 1;
  if (count !== null && (!Number.isSafeInteger(count) || count < 1))
    throw new Error("End after must be a positive whole number of runs.");
  const end = recipe.end ? Math.floor(Date.parse(recipe.end) / 1000) : null;
  if (end !== null && (!Number.isSafeInteger(end) || end <= due))
    throw new Error("End time must be after the first run.");
  return {
    ...base,
    type: "timer",
    prompt: "Scheduled check",
    armed_at: due - interval,
    interval_secs: interval,
    max_occurrences: count,
    expires_at: end,
  };
}

export function createRecipeForm({
  agents,
  relay,
}: Pick<Context, "agents" | "relay">) {
  return function RecipeForm({
    running,
    channels,
    close,
  }: {
    running: ReturnType<Context["agents"]["snapshot"]>["running"];
    channels: readonly { id: string; name: string }[];
    close(): void;
  }) {
    const [agent, setAgent] = React.useState("");
    const [recipe, setRecipe] = React.useState<Recipe>({
      kind: "pr",
      instructions: "",
      pr: "",
      command: "",
      when: "",
      repeat: "",
      count: "",
      end: "",
      channel: "",
    });
    const listId = React.useId();
    const [pending, setPending] = React.useState(false);
    const [error, setError] = React.useState("");
    const field = (
      key: keyof Recipe,
      label: string,
      type: React.HTMLInputTypeAttribute = "text",
    ) => {
      const props = {
        value: recipe[key] ?? "",
        disabled: pending,
        onChange: (
          event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
        ) => setRecipe({ ...recipe, [key]: event.target.value }),
      };
      return (
        <Field label={label}>
          {key === "instructions" || key === "keywords" || key === "listen" ? (
            <Textarea {...props} />
          ) : (
            <Input {...props} type={type} />
          )}
        </Field>
      );
    };
    const select = (
      label: string,
      value: string,
      options: { value: string; label: string }[],
      onValueChange: (value: string) => void,
    ) => (
      <Select
        label={label}
        variant="field"
        value={value}
        groups={[{ label: "", options }]}
        disabled={pending}
        onValueChange={onValueChange}
      />
    );
    const submit = async () => {
      if (pending) return;
      setPending(true);
      setError("");
      try {
        if (!running.some((value) => value.key === agent))
          throw new Error("Choose an available agent.");
        if (
          recipe.interest &&
          running.find((value) => value.key === agent)?.attention[
            `interest/${recipe.interest}`
          ]?.value.type !== "interest"
        )
          throw new Error("Choose an Interest belonging to this agent.");
        const id = `${
          recipe.instructions
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .slice(0, 30) || recipe.kind
        }-${crypto.randomUUID().slice(0, 12)}`;
        const connection = relay?.snapshot();
        const address = await resolveDelivery(
          recipe.channel,
          recipe.thread ?? "",
          channels,
          connection?.status === "ready"
            ? (id) => connection.session.read([{ ids: [id], limit: 1 }])
            : undefined,
        );
        const watch = recipeWatch(
          {
            ...recipe,
            channel: address.channel ?? "",
            thread: address.root ?? "",
            listen: recipe.listen?.trim()
              ? [
                  ...new Set(
                    recipe.listen
                      .split("\n")
                      .filter((value) => value.trim())
                      .map((value) => channelId(value, channels)),
                  ),
                ].join("\n")
              : "",
          },
          id,
        );
        const slug = `watch/${id}`;
        await agents.save(agent, {
          attentionEnabled: true,
          attention: {
            ...(!recipe.interest
              ? {
                  [`interest/${id}`]: {
                    type: "interest" as const,
                    instructions: recipe.instructions.trim(),
                  },
                }
              : {}),
            [slug]: watch,
          },
          ...(watch.type === "timer" ? { restart: [slug] } : {}),
        });
        close();
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        setPending(false);
      }
    };
    return (
      <form
        className="attention-card attention-recipe"
        aria-label="New watch"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {select(
          "Agent",
          agent,
          [
            { value: "", label: "Choose an agent" },
            ...running.map((value) => ({
              value: value.key,
              label: value.name,
            })),
          ],
          (value) => {
            setAgent(value);
            setRecipe({ ...recipe, interest: "" });
          },
        )}
        {select(
          "Recipe",
          recipe.kind,
          [
            { value: "pr", label: "PR watcher" },
            { value: "schedule", label: "Scheduled task" },
            { value: "command", label: "Custom command" },
            { value: "event", label: "Event filter" },
          ],
          (value) => setRecipe({ ...recipe, kind: value as Recipe["kind"] }),
        )}
        {!recipe.interest && field("instructions", "Interest instructions")}
        {select(
          "Interest",
          recipe.interest ?? "",
          [
            { value: "", label: "Create a new Interest" },
            ...Object.entries(
              running.find((value) => value.key === agent)?.attention ?? {},
            )
              .filter(([, object]) => object.value.type === "interest")
              .map(([slug]) => ({
                value: slug.slice(9),
                label: slug.slice(9),
              })),
          ],
          (value) => setRecipe({ ...recipe, interest: value }),
        )}
        {recipe.kind === "pr" && field("pr", "Pull request URL", "url")}
        {recipe.kind === "command" &&
          field("command", "Command (JSON argument list)")}
        {recipe.kind === "schedule" && (
          <>
            {field("when", "First run", "datetime-local")}
            {field("repeat", "Repeat every (minutes, optional)", "number")}
            {recipe.repeat &&
              field("count", "End after (runs, optional)", "number")}
            {field("end", "End at (optional)", "datetime-local")}
          </>
        )}
        {recipe.kind === "event" && (
          <>
            {field(
              "listen",
              "Listening channels (one name or link per line, optional)",
            )}
            {field("kinds", "Event kinds (default: 9; all for any kind)")}
            {field("authors", "Only these authors (hex keys, optional)")}
            {field("exclude", "Exclude these authors (hex keys, optional)")}
            {select(
              "Message position",
              recipe.replies ?? "",
              [
                { value: "", label: "Any message" },
                { value: "replies", label: "Thread replies only" },
                { value: "top", label: "Top-level messages only" },
              ],
              (value) => setRecipe({ ...recipe, replies: value }),
            )}
            {field("keywords", "Message keywords (one per line, optional)")}
            {field("tags", "Tag filters (JSON object, optional)")}
            <p className="text-body-sm text-muted">
              Blank listening channel watches all channels the agent belongs to.
              A message passes when it contains any keyword, ignoring case.
              Keywords are literal text, including phrases and punctuation.
            </p>
          </>
        )}
        <fieldset className="attention-field">
          <legend className="text-label-sm">Deliver to</legend>
          <Field label="Channel (optional)">
            <Input
              list={listId}
              value={recipe.channel}
              disabled={pending}
              placeholder="Channel name or Buzz link"
              onChange={(event) =>
                setRecipe({ ...recipe, channel: event.target.value })
              }
            />
          </Field>
          <Field label="Thread link (optional)">
            <Input
              value={recipe.thread ?? ""}
              disabled={pending}
              placeholder="Paste a Buzz thread link"
              onChange={(event) => {
                const thread = event.target.value;
                const link = conversationLink(thread);
                setRecipe({
                  ...recipe,
                  thread,
                  ...(link
                    ? {
                        channel:
                          channels.find((value) => value.id === link.channel)
                            ?.name ?? link.channel,
                      }
                    : {}),
                });
              }}
            />
          </Field>
          {!recipe.channel.trim() && !recipe.thread?.trim() && (
            <p className="text-body-sm text-muted">Independent agent turn</p>
          )}
        </fieldset>
        <datalist id={listId}>
          {channels.map((value) => (
            <option key={value.id} value={value.name}>
              {value.id}
            </option>
          ))}
        </datalist>
        {error && (
          <p role="alert" className="text-body-sm text-danger">
            {error}
          </p>
        )}
        <div className="attention-actions">
          <Button type="submit" size="sm" variant="primary" disabled={pending}>
            Create watch
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={close}
          >
            Cancel
          </Button>
        </div>
      </form>
    );
  };
}
