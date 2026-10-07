// The app's editor for an agent's `agent-attention/v1` objects. Every agent type is
// woken through them, so the app edits them once instead of each plugin. Watches
// and timers sit under the Interest they serve; raw JSON covers what the forms
// leave out (tags, classifiers, expiry). Validation is the spec's, at save.
import { useState } from "react";
import {
  AtIcon,
  DotsThreeIcon,
  EyeIcon,
  PencilSimpleIcon,
  PlusIcon,
  TimerIcon,
  TrashIcon,
} from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { Checkbox } from "../../shared/design-system/ui/Checkbox";
import { Field } from "../../shared/design-system/ui/Field";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { Input } from "../../shared/design-system/ui/Input";
import {
  MenuIcon,
  MenuItem,
  MenuPopup,
  MenuRoot,
  MenuTrigger,
} from "../../shared/design-system/ui/Menu";
import { PreferenceRow } from "../../shared/design-system/ui/PreferenceRow";
import { Select } from "../../shared/design-system/ui/Select";
import { SettingsGroup } from "../../shared/design-system/ui/SettingsGroup";
import { Switch } from "../../shared/design-system/ui/Switch";
import { Textarea } from "../../shared/design-system/ui/Textarea";
import {
  attentionOf,
  compileFilter,
  describeWatch,
  interestTitle,
  interval,
  parseSlug,
  plural,
  UNITS,
  validateObject,
  type AttentionObject,
  type AttentionValue,
  type ChannelChoice,
  type EventWatch,
  type Watch,
  type WatchObject,
} from "./attention";
import type { Agent, AgentChange } from "./service";

/** The app's own writer: any field, including attention. */
type Save = (change: AgentChange) => Promise<void>;

function unnamed(watch: EventWatch): EventWatch {
  const { name: _, ...rest } = watch;
  return rest;
}

const watchIcon = (watch: Watch) =>
  watch.type === "timer" ? (
    <TimerIcon size={14} aria-hidden="true" />
  ) : (
    <EyeIcon size={14} aria-hidden="true" />
  );

/** Read-only: what wakes the agent, one line each. For glances like the peek. */
export function AttentionSummary({
  agent,
  channels = [],
}: {
  agent: Agent;
  channels?: readonly ChannelChoice[];
}) {
  const { watches } = attentionOf(agent.attention);
  const on = watches.filter((object) => object.value.enabled);
  const paused = watches.length - on.length;
  return (
    <ul className="m-0 grid list-none gap-1.5 p-0 text-body-sm">
      <li className="flex items-center gap-2">
        <AtIcon size={14} aria-hidden="true" /> Mentions and replies
      </li>
      {on.map((object) => (
        <li key={object.slug} className="flex min-w-0 items-center gap-2">
          {watchIcon(object.value)}
          <span className="truncate">
            {describeWatch(object.value, channels)}
          </span>
        </li>
      ))}
      {paused > 0 && (
        <li className="text-secondary">{plural(paused, "paused watch")}</li>
      )}
    </ul>
  );
}

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
function useAction() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const run = async (action: () => Promise<void>) => {
    setPending(true);
    setError("");
    try {
      await action();
      return true;
    } catch (reason) {
      setError(message(reason));
      return false;
    } finally {
      setPending(false);
    }
  };
  return { pending, error, setError, run };
}
const Problem = ({ error }: { error: string }) =>
  error ? (
    <p role="alert" className="m-0 text-body-sm text-danger">
      {error}
    </p>
  ) : null;

export function AttentionPanel({
  agent,
  save,
  channels = [],
}: {
  agent: Agent;
  save: Save;
  channels?: readonly ChannelChoice[];
}) {
  const { interests, watches, orphans } = attentionOf(agent.attention);
  const [adding, setAdding] = useState(false);
  return (
    <div className="grid content-start gap-6">
      <SettingsGroup>
        <PreferenceRow
          icon={<AtIcon size={16} />}
          title="Mentions and replies"
          subtitle="Messages that mention it or reply to it. Always on."
        />
      </SettingsGroup>
      {interests.map((object) => {
        const id = parseSlug(object.slug)?.id ?? object.slug;
        return (
          <InterestGroup
            key={object.slug}
            id={id}
            object={object}
            watches={watches.filter((watch) => watch.value.interest_id === id)}
            agent={agent}
            channels={channels}
            save={save}
          />
        );
      })}
      {orphans.length > 0 && (
        <section className="grid gap-2" aria-label="Without an interest">
          <div className="grid gap-0.5">
            <h4 className="m-0 text-label">Without an interest</h4>
            <p className="m-0 text-body-sm text-secondary">
              Its Interest was removed, so these wake the agent without
              instructions. Edit its JSON to give it an interest_id, or remove
              it.
            </p>
          </div>
          <SettingsGroup>
            {orphans.map((object) => (
              <WatchRow
                key={`${object.slug}:${object.modifiedAt}`}
                object={object}
                channels={channels}
                save={save}
              />
            ))}
          </SettingsGroup>
        </section>
      )}
      {adding ? (
        <NewInterest
          agent={agent}
          save={save}
          onDone={() => setAdding(false)}
        />
      ) : (
        <div>
          <Button size="compact" onClick={() => setAdding(true)}>
            <PlusIcon size={14} aria-hidden="true" /> Interest
          </Button>
        </div>
      )}
    </div>
  );
}

function InterestGroup({
  id,
  object,
  watches,
  agent,
  channels,
  save,
}: {
  id: string;
  object: AttentionObject;
  watches: readonly WatchObject[];
  agent: Agent;
  channels: readonly ChannelChoice[];
  save: Save;
}) {
  const instructions =
    object.value.type === "interest" ? object.value.instructions : "";
  const title = interestTitle(id);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(instructions);
  const [draft, setDraft] = useState<"event" | "timer">();
  const action = useAction();
  const remove = () =>
    action.run(() =>
      save({
        attention: Object.fromEntries(
          [object, ...watches].map((item) => [item.slug, null]),
        ),
      }),
    );
  return (
    <section className="grid gap-2" aria-label={title}>
      <div className="flex items-center justify-between gap-2">
        <h4 className="m-0 text-label">{title}</h4>
        <RowMenu
          label={title}
          onEdit={() => {
            setText(instructions);
            setEditing(true);
          }}
          removeLabel={
            watches.length
              ? `Remove with ${plural(watches.length, "watch")}`
              : "Remove"
          }
          onRemove={() => void remove()}
        />
      </div>
      {editing ? (
        <div className="grid gap-2">
          <Field label={`${title} instructions`} labelVisibility="hidden">
            <Textarea
              rows={3}
              value={text}
              onChange={(event) => setText(event.target.value)}
            />
          </Field>
          <FormActions
            pending={action.pending}
            submit="Save"
            onSubmit={() =>
              void action
                .run(() =>
                  save({
                    attention: {
                      [object.slug]: { type: "interest", instructions: text },
                    },
                  }),
                )
                .then((ok) => ok && setEditing(false))
            }
            onCancel={() => setEditing(false)}
          />
        </div>
      ) : (
        <p className="m-0 whitespace-pre-wrap text-body-sm text-secondary">
          {instructions}
        </p>
      )}
      <Problem error={action.error} />
      {watches.length > 0 && (
        <SettingsGroup>
          {watches.map((watch) => (
            <WatchRow
              key={`${watch.slug}:${watch.modifiedAt}`}
              object={watch}
              channels={channels}
              save={save}
            />
          ))}
        </SettingsGroup>
      )}
      {draft ? (
        <WatchForm
          kind={draft}
          interest={id}
          agent={agent}
          channels={channels}
          save={save}
          onDone={() => setDraft(undefined)}
        />
      ) : (
        <div className="flex gap-2">
          <Button size="compact" onClick={() => setDraft("event")}>
            <EyeIcon size={14} aria-hidden="true" /> Watch
          </Button>
          <Button size="compact" onClick={() => setDraft("timer")}>
            <TimerIcon size={14} aria-hidden="true" /> Timer
          </Button>
        </div>
      )}
    </section>
  );
}

function RowMenu({
  label,
  onEdit,
  editLabel = "Edit",
  removeLabel = "Remove",
  onRemove,
}: {
  label: string;
  onEdit(): void;
  editLabel?: string;
  removeLabel?: string;
  onRemove(): void;
}) {
  return (
    <MenuRoot>
      <MenuTrigger
        render={
          <IconButton
            aria-label={`Actions for ${label}`}
            size="sm"
            icon={<DotsThreeIcon size={18} aria-hidden="true" />}
          />
        }
      />
      <MenuPopup size="compact" align="end">
        <MenuItem onClick={onEdit}>
          <MenuIcon>
            <PencilSimpleIcon size={14} />
          </MenuIcon>
          {editLabel}
        </MenuItem>
        <MenuItem tone="danger" onClick={onRemove}>
          <MenuIcon>
            <TrashIcon size={14} />
          </MenuIcon>
          {removeLabel}
        </MenuItem>
      </MenuPopup>
    </MenuRoot>
  );
}

function WatchRow({
  object,
  channels,
  save,
}: {
  object: WatchObject;
  channels: readonly ChannelChoice[];
  save: Save;
}) {
  const { value, slug } = object;
  const [editing, setEditing] = useState(false);
  const action = useAction();
  const title = describeWatch(value, channels);
  const put = (next: AttentionValue | null) =>
    action.run(() => save({ attention: { [slug]: next } }));
  const detail =
    value.type === "timer"
      ? [
          `“${value.prompt}”`,
          value.max_occurrences !== null &&
            `at most ${plural(value.max_occurrences, "time")}`,
        ]
      : [
          value.name && describeWatch(unnamed(value), channels),
          value.classifier && "with a classifier",
        ];
  return (
    <>
      <PreferenceRow
        icon={
          value.type === "timer" ? (
            <TimerIcon size={16} />
          ) : (
            <EyeIcon size={16} />
          )
        }
        title={title}
        disabled={!value.enabled}
        subtitle={
          detail.some(Boolean) || action.error ? (
            <>
              {detail.filter(Boolean).join(" · ")}
              <Problem error={action.error} />
            </>
          ) : undefined
        }
        trailing={
          <span className="flex items-center gap-1">
            <Switch
              aria-label={`${title} on`}
              checked={value.enabled}
              disabled={action.pending}
              onCheckedChange={(enabled) => void put({ ...value, enabled })}
            />
            <RowMenu
              label={title}
              editLabel="Edit JSON"
              onEdit={() => setEditing(true)}
              onRemove={() => void put(null)}
            />
          </span>
        }
      />
      {editing && (
        <JsonEditor
          slug={slug}
          value={value}
          save={save}
          onDone={() => setEditing(false)}
        />
      )}
    </>
  );
}

function FormActions({
  pending,
  submit,
  onSubmit,
  onCancel,
}: {
  pending: boolean;
  submit: string;
  onSubmit(): void;
  onCancel(): void;
}) {
  return (
    <div className="flex gap-2">
      <Button
        size="compact"
        variant="primary"
        loading={pending}
        onClick={onSubmit}
      >
        {submit}
      </Button>
      <Button size="compact" disabled={pending} onClick={onCancel}>
        Cancel
      </Button>
    </div>
  );
}

/** Every field of one object, for what the forms leave out. */
function JsonEditor({
  slug,
  value,
  save,
  onDone,
}: {
  slug: string;
  value: AttentionValue;
  save: Save;
  onDone(): void;
}) {
  const [text, setText] = useState(JSON.stringify(value, null, 2));
  const action = useAction();
  const submit = () => {
    let next: unknown;
    try {
      next = JSON.parse(text);
    } catch {
      action.setError("Enter a JSON object");
      return;
    }
    const problem = validateObject(slug, next);
    if (problem) action.setError(problem);
    else
      void action
        .run(() => save({ attention: { [slug]: next as AttentionValue } }))
        .then((ok) => ok && onDone());
  };
  return (
    <div className="grid gap-2 p-3">
      <Field label={slug} description="agent-attention/v1">
        <Textarea
          variant="code"
          rows={10}
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
      </Field>
      <Problem error={action.error} />
      <FormActions
        pending={action.pending}
        submit="Save"
        onSubmit={submit}
        onCancel={onDone}
      />
    </div>
  );
}

// Slug ids are printable ASCII without spaces, unique within the agent.
function freeSlug(space: "interest" | "watch", base: string, agent: Agent) {
  const stem =
    base
      .trim()
      .toLowerCase()
      .replace(/[^!-~]+/g, "-")
      .slice(0, 56) || space;
  let id = stem;
  for (let n = 2; `${space}/${id}` in agent.attention; n++) id = `${stem}-${n}`;
  return `${space}/${id}`;
}
const now = () => Math.floor(Date.now() / 1000);
const straightQuotes = (text: string) =>
  text.replace(/[\u201C\u201D\u201E\u201F\u2033]/g, '"');

function NewInterest({
  agent,
  save,
  onDone,
}: {
  agent: Agent;
  save: Save;
  onDone(): void;
}) {
  const [name, setName] = useState("");
  const [instructions, setInstructions] = useState("");
  const action = useAction();
  const submit = () => {
    const slug = freeSlug("interest", name, agent);
    const value = { type: "interest", instructions } as const;
    const problem = !name.trim()
      ? "Name the interest"
      : validateObject(slug, value);
    if (problem) action.setError(problem);
    else
      void action
        .run(() => save({ attention: { [slug]: value } }))
        .then((ok) => ok && onDone());
  };
  return (
    <section
      className="grid gap-3 rounded-container bg-surface-inset p-4"
      aria-label="New interest"
    >
      <Field
        label="Interest"
        description="Something it looks after, e.g. Releases"
      >
        <Input value={name} onChange={(event) => setName(event.target.value)} />
      </Field>
      <Field label="Instructions">
        <Textarea
          rows={3}
          value={instructions}
          placeholder="Keep the release checklist current and flag blockers."
          onChange={(event) => setInstructions(event.target.value)}
        />
      </Field>
      <Problem error={action.error} />
      <FormActions
        pending={action.pending}
        submit="Add interest"
        onSubmit={submit}
        onCancel={onDone}
      />
    </section>
  );
}

const KINDS = {
  messages: [9],
  any: [],
} as const;

/** Adds one watch or timer for `interest`. Editing an existing one is its JSON,
 * so the form never has to read every field of the schema back in. */
function WatchForm({
  kind,
  interest,
  agent,
  channels,
  save,
  onDone,
}: {
  kind: "event" | "timer";
  interest: string;
  agent: Agent;
  channels: readonly ChannelChoice[];
  save: Save;
  onDone(): void;
}) {
  const [name, setName] = useState("");
  const [scope, setScope] = useState<string[] | "all">("all");
  const [kinds, setKinds] = useState<keyof typeof KINDS>("messages");
  const [filter, setFilter] = useState("");
  const [prompt, setPrompt] = useState("");
  const [count, setCount] = useState("1");
  const [unit, setUnit] = useState(String(interval(3_600).size));
  const [limit, setLimit] = useState("");
  const action = useAction();
  let filterProblem = "";
  if (filter.trim())
    try {
      compileFilter(filter.trim());
    } catch (error) {
      filterProblem = message(error);
    }
  const build = (): AttentionValue =>
    kind === "event"
      ? {
          type: "event",
          interest_id: interest,
          enabled: true,
          since: now(),
          channels: scope,
          kinds: KINDS[kinds],
          ...(name.trim() ? { name: name.trim() } : {}),
          ...(filter.trim() ? { filter: filter.trim() } : {}),
        }
      : {
          type: "timer",
          interest_id: interest,
          prompt,
          enabled: true,
          interval_secs: Math.round(Number(count) * Number(unit)),
          armed_at: now(),
          max_occurrences: limit.trim() ? Number(limit) : null,
          expires_at: null,
        };
  const submit = () => {
    const slug = freeSlug(
      "watch",
      kind === "timer" ? "timer" : name || "messages",
      agent,
    );
    const value = build();
    const problem =
      filterProblem ||
      (Array.isArray(scope) && !scope.length
        ? "Choose at least one channel"
        : validateObject(slug, value));
    // A filter problem is already shown under the field.
    if (problem) {
      if (!filterProblem) action.setError(problem);
    } else
      void action
        .run(() => save({ attention: { [slug]: value } }))
        .then((ok) => ok && onDone());
  };
  const title = `New ${kind === "timer" ? "timer" : "watch"}`;
  return (
    <section
      className="grid gap-3 rounded-container bg-surface-inset p-4"
      aria-label={title}
    >
      {kind === "event" ? (
        <>
          <Field label="Name (optional)">
            <Input
              value={name}
              placeholder="Release questions"
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          <Select
            label="Wake on"
            variant="field"
            value={kinds}
            onValueChange={(value) => setKinds(value as keyof typeof KINDS)}
            groups={[
              {
                label: "Events",
                options: [
                  { value: "messages", label: "Messages" },
                  { value: "any", label: "Any event" },
                ],
              },
            ]}
          />
          <Select
            label="In"
            variant="field"
            value={scope === "all" ? "all" : "some"}
            onValueChange={(value) =>
              setScope(value === "all" ? "all" : scope === "all" ? [] : scope)
            }
            groups={[
              {
                label: "Channels",
                options: [
                  { value: "all", label: "Every channel it can read" },
                  { value: "some", label: "Chosen channels" },
                ],
              },
            ]}
          />
          {scope !== "all" && (
            <fieldset className="m-0 grid max-h-48 gap-1 overflow-auto border-0 p-0">
              <legend className="sr-only">Channels</legend>
              {channels.map((channel) => (
                <Checkbox
                  key={channel.id}
                  label={`#${channel.name}`}
                  checked={scope.includes(channel.id)}
                  onCheckedChange={(checked) =>
                    setScope(
                      checked
                        ? [...scope, channel.id]
                        : scope.filter((id) => id !== channel.id),
                    )
                  }
                />
              ))}
              {!channels.length && (
                <p className="m-0 text-body-sm text-secondary">
                  No channels to choose from yet.
                </p>
              )}
            </fieldset>
          )}
          <Field
            label="Filter (optional)"
            description={
              filterProblem ||
              'Exact match only. e.g. content == "deploy", or is_reply && !(author == "<hex>")'
            }
          >
            <Input
              value={filter}
              spellCheck={false}
              autoCorrect="off"
              autoCapitalize="off"
              aria-invalid={!!filterProblem || undefined}
              // macOS turns typed quotes into curly ones; the grammar only takes ".
              onChange={(event) =>
                setFilter(straightQuotes(event.target.value))
              }
            />
          </Field>
        </>
      ) : (
        <>
          <Field label="Prompt">
            <Textarea
              rows={2}
              value={prompt}
              placeholder="Post a summary of open questions."
              onChange={(event) => setPrompt(event.target.value)}
            />
          </Field>
          <div className="grid grid-cols-[6rem_1fr] items-end gap-2">
            <Field label="Every">
              <Input
                type="number"
                min={1}
                value={count}
                onChange={(event) => setCount(event.target.value)}
              />
            </Field>
            <Select
              label="Unit"
              variant="compact"
              value={unit}
              onValueChange={setUnit}
              groups={[
                {
                  label: "Units",
                  options: UNITS.slice(0, 3).map(([label, size]) => ({
                    value: String(size),
                    label: `${label}s`,
                  })),
                },
              ]}
            />
          </div>
          <Field label="Stop after (optional)" description="Times it runs">
            <Input
              type="number"
              min={1}
              value={limit}
              onChange={(event) => setLimit(event.target.value)}
            />
          </Field>
        </>
      )}
      <Problem error={action.error} />
      <FormActions
        pending={action.pending}
        submit={kind === "timer" ? "Add timer" : "Add watch"}
        onSubmit={submit}
        onCancel={onDone}
      />
    </section>
  );
}
