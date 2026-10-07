import type { AgentRunLive, LiveStep, StepKind } from "@buzz/author";
import type { Wire } from "./rpc.ts";
type Item = {
  id: string;
  type: string;
  text?: string;
  command?: string;
  aggregatedOutput?: string;
  tool?: string;
  status?: string;
  exitCode?: number;
  phase?: string;
  changes?: { path: string }[];
  commandActions?: { type: string; path?: string; query?: string }[];
  summary?: string[];
};
/** Codex item IDs map to one Buzz step, updated in place through completion. */
export function activity(live: AgentRunLive) {
  const rows = new Map<string, { step: LiveStep; label: string }>();
  let final: { text: string; step: LiveStep } | undefined;
  function row(item: Item) {
    const found = rows.get(item.id);
    if (found) return found;
    let kind: StepKind = "tool";
    let label = item.tool ?? item.type;
    if (item.type === "agentMessage") {
      kind = "message";
      label = "";
    } else if (item.type === "reasoning" || item.type === "plan") {
      kind = "thinking";
      label = "";
    } else if (item.type === "fileChange") {
      kind = "write";
      label = item.changes?.map((c) => c.path).join(", ") ?? "files";
    } else if (item.type === "commandExecution") {
      const action =
        item.commandActions?.length === 1 ? item.commandActions[0] : undefined;
      kind =
        action?.type === "read" || action?.type === "listFiles"
          ? "read"
          : action?.type === "search"
            ? "search"
            : "command";
      label =
        (kind === "read"
          ? action?.path
          : kind === "search"
            ? action?.query
            : item.command) ??
        item.command ??
        "command";
    }
    const created = { step: live.step({ kind, label }), label };
    rows.set(item.id, created);
    return created;
  }
  return {
    accept({ method, params }: Wire) {
      const p = params as
        | { item: Item; itemId: string; delta: string }
        | undefined;
      if (!p) return;
      // With streaming disabled, some models expose no reasoning summary.
      // Wait for a readable snapshot instead of accumulating empty "Thought" rows.
      if (
        p.item?.type === "reasoning" &&
        (method !== "item/completed" || !p.item.summary?.some((s) => s.trim()))
      )
        return;
      if (method === "item/started" && p.item.type !== "userMessage")
        row(p.item);
      if (method === "item/completed" && p.item.type !== "userMessage") {
        const item: Item = p.item;
        const value = row(item);
        const error =
          item.status === "failed" ||
          item.status === "declined" ||
          (item.exitCode != null && item.exitCode !== 0)
            ? `${item.status === "declined" ? "Declined" : "Failed"}${item.exitCode != null ? ` (exit ${item.exitCode})` : ""}`
            : undefined;
        // Completed snapshots make activity useful without token streaming.
        if (item.type === "agentMessage" || item.type === "plan")
          value.step.append(item.text ?? "");
        if (item.type === "commandExecution" && item.aggregatedOutput)
          value.step.append(`${value.label}\n${item.aggregatedOutput}`);
        if (item.type === "reasoning")
          value.step.append(item.summary?.join("\n\n") ?? "");
        // Keep the final row open until publishing succeeds, so it can be marked published.
        if (item.type === "agentMessage" && item.phase !== "commentary")
          final = { text: item.text ?? "", step: value.step };
        else value.step.finish(error ? { error } : undefined);
      }
    },
    final: () => final,
    finish(error?: string) {
      for (const { step } of rows.values())
        step.finish(error ? { error } : undefined);
    },
  };
}
