// The owner's view of an agent's tables: the agent-signed schemas and rows,
// decrypted for as long as the panel is open, and a form to propose a table
// the agent then adopts.
import { useEffect, useState } from "react";
import { Button } from "../../shared/design-system/ui/Button";
import { Checkbox } from "../../shared/design-system/ui/Checkbox";
import { EmptyState } from "../../shared/design-system/ui/EmptyState";
import { Field } from "../../shared/design-system/ui/Field";
import { Header, InlineHeader } from "../../shared/design-system/ui/Header";
import { Input } from "../../shared/design-system/ui/Input";
import { Select } from "../../shared/design-system/ui/Select";
import { TableIcon } from "../../shared/design-system/icons/index";
import { formatFullTimestamp } from "../../shared/datetime";
import { relativeTimestamp } from "../../shared/relative-timestamp";
import type { MemoryEntry } from "../agents/memory";
import { type AgentMemories, useMemory } from "../agents/MemoryPanel";
import type { Agent } from "../agents/service";
import { boardTables, fieldKeyFor, tableIdFor, type BoardTable } from "./board";
import {
  FIELD_TYPES,
  parseSchema,
  type FieldType,
  type TableSchema,
} from "./schema";

const TYPE_LABELS: Record<FieldType, string> = {
  text: "Text",
  number: "Number",
  date: "Date",
  select: "Choice",
  url: "Link",
  person: "Person",
};

/** The owner's proposals to `pubkey`, read while the board is shown and
 * dropped with it. */
function useProposals(
  memories: AgentMemories | undefined,
  pubkey: string,
  shown: boolean,
) {
  const [entries, setEntries] = useState<readonly MemoryEntry[]>([]);
  const [reads, setReads] = useState(0);
  const read = memories?.proposals?.read;
  // biome-ignore lint/correctness/useExhaustiveDependencies: reads asks for a fresh read
  useEffect(() => {
    if (!read || !shown) {
      setEntries([]);
      return;
    }
    const controller = new AbortController();
    read(pubkey, controller.signal).then(
      (listing) => {
        if (!controller.signal.aborted) setEntries(listing.entries);
      },
      () => {},
    );
    return () => controller.abort();
  }, [read, pubkey, shown, reads]);
  return { entries, reread: () => setReads((count) => count + 1) };
}

export function TablesPanel({
  agent,
  memories,
}: {
  agent: Agent;
  memories: AgentMemories | undefined;
}) {
  const { snapshot, refresh } = useMemory(memories, agent.pubkey);
  const shown = snapshot.status === "ready" || snapshot.status === "loading";
  const proposals = useProposals(memories, agent.pubkey, shown);
  const [editing, setEditing] = useState(false);
  const tables = shown
    ? boardTables(snapshot.listing?.entries ?? [], proposals.entries)
    : [];
  const propose = memories?.proposals?.propose;
  return (
    <div className="grid min-w-0 grid-cols-1 content-start gap-6">
      {!shown ? (
        <p className="m-0 text-body-sm text-secondary">
          {snapshot.status === "denied"
            ? "This community doesn't let you read this agent's tables."
            : snapshot.status === "error"
              ? "Tables couldn't be read."
              : "Tables aren't available here."}
        </p>
      ) : tables.length === 0 && !editing ? (
        <EmptyState
          icon={<TableIcon size={24} />}
          title="No tables yet"
          description={`Define a table's fields and ${agent.name || "the agent"} keeps its rows.`}
          action={
            propose ? (
              <Button variant="prominent" onClick={() => setEditing(true)}>
                New table
              </Button>
            ) : undefined
          }
        />
      ) : (
        tables.map((table) => <TableView key={table.id} table={table} />)
      )}
      {shown && propose && editing ? (
        <TableEditor
          taken={tables.map((table) => table.id)}
          onCancel={() => setEditing(false)}
          onPropose={async (id, schema) => {
            const after = tables.find((table) => table.id === id)?.proposedAt;
            await propose(agent.pubkey, id, JSON.stringify(schema), after ?? 0);
            setEditing(false);
            proposals.reread();
            refresh();
          }}
        />
      ) : shown && propose && tables.length > 0 ? (
        <div>
          <Button onClick={() => setEditing(true)}>New table</Button>
        </div>
      ) : null}
    </div>
  );
}

function TableView({ table }: { table: BoardTable }) {
  const schema = table.schema ?? table.pending?.schema;
  if (!schema)
    return (
      <p className="m-0 text-body-sm text-secondary">
        {table.id} couldn't be read.
      </p>
    );
  return (
    <section className="grid min-w-0 gap-3" aria-label={schema.name}>
      <Header level={3} title={schema.name} />
      {table.pending ? (
        <p className="m-0 text-body-sm text-secondary">
          {table.schema
            ? "Your changes to these fields are waiting for the agent to adopt them."
            : "Waiting for the agent to adopt this table."}
        </p>
      ) : null}
      {table.schema ? (
        table.rows.length ? (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-body-sm">
              <thead>
                <tr>
                  {table.schema.fields.map((field) => (
                    <th key={field.key} scope="col" className="py-1 pr-4">
                      {field.label}
                    </th>
                  ))}
                  <th scope="col" className="py-1">
                    Updated
                  </th>
                </tr>
              </thead>
              <tbody>
                {table.rows.map((row) => (
                  <tr key={row.id}>
                    {table.schema?.fields.map((field) => (
                      <td key={field.key} className="py-1 pr-4">
                        {String(row.values[field.key] ?? "")}
                      </td>
                    ))}
                    <td
                      className="py-1 text-secondary"
                      title={`Signed by the agent, ${formatFullTimestamp(row.createdAt)}, event ${row.eventId}`}
                    >
                      {relativeTimestamp(row.createdAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="m-0 text-body-sm text-secondary">No rows yet.</p>
        )
      ) : null}
      {table.unreadable ? (
        <p className="m-0 text-body-sm text-secondary">
          Some rows couldn't be read.
        </p>
      ) : null}
    </section>
  );
}

type DraftField = {
  label: string;
  type: FieldType;
  required: boolean;
  options: string;
};

function TableEditor({
  taken,
  onPropose,
  onCancel,
}: {
  taken: readonly string[];
  onPropose(id: string, schema: TableSchema): Promise<void>;
  onCancel(): void;
}) {
  const [name, setName] = useState("");
  const [fields, setFields] = useState<DraftField[]>([
    { label: "", type: "text", required: true, options: "" },
  ]);
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const update = (index: number, change: Partial<DraftField>) =>
    setFields((current) =>
      current.map((field, at) =>
        at === index ? { ...field, ...change } : field,
      ),
    );
  const submit = async () => {
    setError(undefined);
    const id = tableIdFor(name);
    let schema: TableSchema;
    try {
      if (!id) throw new Error("A table needs a name");
      schema = parseSchema(
        JSON.stringify({
          version: 1,
          name,
          fields: fields.map((field) => ({
            key: fieldKeyFor(field.label),
            label: field.label,
            type: field.type,
            ...(field.required ? { required: true } : {}),
            ...(field.type === "select"
              ? {
                  options: field.options
                    .split(",")
                    .map((option) => option.trim())
                    .filter(Boolean),
                }
              : {}),
          })),
        }),
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Check the fields");
      return;
    }
    setSaving(true);
    try {
      await onPropose(id, schema);
    } catch {
      setError("The table couldn't be saved. Try again.");
    } finally {
      setSaving(false);
    }
  };
  return (
    <form
      className="grid min-w-0 gap-4"
      aria-label="New table"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <Header level={3} title="New table" />
      <Field
        label="Name"
        description={
          taken.includes(tableIdFor(name))
            ? "This replaces the fields of the table with this name."
            : undefined
        }
      >
        <Input value={name} onValueChange={setName} />
      </Field>
      <InlineHeader title="Fields" />
      {fields.map((field, index) => (
        <fieldset
          // biome-ignore lint/suspicious/noArrayIndexKey: fields are append-only
          key={index}
          className="grid min-w-0 gap-2"
          aria-label={`Field ${index + 1}`}
        >
          <Field label="Label">
            <Input
              value={field.label}
              onValueChange={(label) => update(index, { label })}
            />
          </Field>
          <Select
            label="Type"
            value={field.type}
            onValueChange={(type) => update(index, { type: type as FieldType })}
            groups={[
              {
                label: "Type",
                options: FIELD_TYPES.map((type) => ({
                  value: type,
                  label: TYPE_LABELS[type],
                })),
              },
            ]}
          />
          {field.type === "select" ? (
            <Field label="Choices" description="Separate them with commas.">
              <Input
                value={field.options}
                onValueChange={(options) => update(index, { options })}
              />
            </Field>
          ) : null}
          <Checkbox
            label="Required"
            checked={field.required}
            onCheckedChange={(required) => update(index, { required })}
          />
        </fieldset>
      ))}
      <div className="flex flex-wrap gap-2">
        <Button
          onClick={() =>
            setFields((current) => [
              ...current,
              { label: "", type: "text", required: false, options: "" },
            ])
          }
        >
          Add field
        </Button>
      </div>
      {error ? (
        <p role="alert" className="m-0 text-body-sm text-danger">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="prominent" loading={saving}>
          Save table
        </Button>
        <Button onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}
