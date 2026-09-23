import { useState } from "react";
import { Checkbox } from "../../shared/design-system/ui/Checkbox";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import { Textarea } from "../../shared/design-system/ui/Textarea";
import {
  resolveLineup,
  type AgentChoice,
  type KitEntry,
  type Lineup,
} from "../../features/channel-templates/model";
import styles from "../channels/ChannelTemplates.module.css";

export function AgentSelection({
  selected,
  agents,
  onChange,
}: {
  selected: readonly string[];
  agents: readonly AgentChoice[];
  onChange(keys: string[]): void;
}) {
  const [search, setSearch] = useState("");
  const choices = [
    ...agents,
    ...selected
      .filter((key) => !agents.some((a) => a.pubkey === key))
      .map((pubkey) => ({ pubkey, name: "Unavailable agent" })),
  ];
  return (
    <div className={styles.stack}>
      <Field label="Find individual agents">
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Name or public key"
        />
      </Field>
      <div className={styles.choices}>
        {choices
          .filter((a) =>
            `${a.name} ${a.pubkey}`
              .toLowerCase()
              .includes(search.toLowerCase()),
          )
          .map((agent) => (
            <Checkbox
              key={agent.pubkey}
              label={`${agent.name} · ${agent.pubkey.slice(0, 10)}`}
              checked={selected.includes(agent.pubkey)}
              onCheckedChange={(checked) =>
                onChange(
                  checked
                    ? [...selected, agent.pubkey]
                    : selected.filter((key) => key !== agent.pubkey),
                )
              }
            />
          ))}
        {!choices.length && (
          <p className="text-secondary">
            No existing agents are available in this community.
          </p>
        )}
      </div>
    </div>
  );
}

export function TemplateFields({
  value,
  onChange,
  entries,
  agents,
  acceptedAgents,
}: {
  value: Lineup;
  onChange(value: Lineup): void;
  acceptedAgents?: readonly string[] | undefined;
  entries: readonly KitEntry[];
  agents: readonly AgentChoice[];
}) {
  const teams = entries.flatMap((e) =>
    !e.record.deleted && e.record.value.type === "team" ? [e.record.value] : [],
  );
  const missing = value.teamIds.filter((id) => !teams.some((t) => t.id === id));
  let preview = "",
    error = "";
  try {
    preview =
      (acceptedAgents
        ? acceptedAgents.map((pubkey) => ({
            pubkey,
            name: agents.find((a) => a.pubkey === pubkey)?.name ?? pubkey,
          }))
        : resolveLineup(value, entries, agents)
      )
        .map((a) => `${a.name} · ${a.pubkey.slice(0, 10)}`)
        .join(", ") || "Only you";
  } catch (reason) {
    error = reason instanceof Error ? reason.message : String(reason);
  }
  return (
    <div className={styles.stack}>
      <fieldset className={styles.selections}>
        <legend>Saved teams</legend>
        {[
          ...teams,
          ...missing.map((id) => ({
            id,
            name: "Unavailable team",
            agents: [],
          })),
        ].map((team) => (
          <Checkbox
            key={team.id}
            label={`${team.name} (${team.agents.length})`}
            checked={value.teamIds.includes(team.id)}
            onCheckedChange={(checked) =>
              onChange({
                ...value,
                teamIds: checked
                  ? [...value.teamIds, team.id]
                  : value.teamIds.filter((id) => id !== team.id),
              })
            }
          />
        ))}
        {!teams.length && !missing.length && (
          <p className="text-secondary">
            Create reusable teams in Templates & teams.
          </p>
        )}
      </fieldset>
      <AgentSelection
        selected={value.agents}
        agents={agents}
        onChange={(agents) => onChange({ ...value, agents })}
      />
      <p className="text-secondary">
        Access preview: {preview}. Existing identities only; this does not start
        agents or send a message.
      </p>
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
      <Field label="Starting Canvas (Markdown)">
        <Textarea
          rows={8}
          value={value.canvas}
          onChange={(e) => onChange({ ...value, canvas: e.target.value })}
          placeholder={"# Goal\n\n# Scope\n\n# Success criteria"}
        />
      </Field>
    </div>
  );
}
