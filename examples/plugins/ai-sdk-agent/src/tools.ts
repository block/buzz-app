// The coding tools of the pi harness (read, bash, edit, write, grep, find, ls),
// built on the four calls a plugin agent's workspace has. What the model gets back
// is capped here, because a single file or command can exceed its context.
import type { AgentWorkspace } from "@buzz/author";
import { tool } from "ai";
import { z } from "zod";

export const MAX_LINES = 2000;
export const MAX_CHARS = 50_000;
const MAX_LINE = 500;
const MAX_ENTRIES = 500;
const MAX_FILES = 1000;
const MAX_MATCH_LINES = 100;

/** A shell word that bash reads as exactly this text. */
export const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** How many of the leading lines fit both limits. */
function fitting(lines: readonly string[]) {
  let chars = 0;
  let count = 0;
  for (const line of lines) {
    chars += line.length + 1;
    if (count === MAX_LINES || chars > MAX_CHARS) break;
    count += 1;
  }
  return count;
}

/** The end of long output, which is where a command says how it went. `dropped`
 * says the start was already thrown away. */
export function tail(text: string, dropped = false) {
  const lines = text.replace(/\n$/, "").split("\n");
  const kept = lines.slice(-fitting([...lines].reverse()) || -1);
  const shown = kept.join("\n").slice(-MAX_CHARS);
  return dropped || shown.length < lines.join("\n").length
    ? `[Earlier output is not shown. This is the end of it.]\n${shown}`
    : shown;
}

/** `rg` where it is installed, because it skips what .gitignore names; otherwise
 * the `grep` every system has. */
export function grepCommand(input: {
  pattern: string;
  path?: string | undefined;
  glob?: string | undefined;
  ignoreCase?: boolean | undefined;
  literal?: boolean | undefined;
  context?: number | undefined;
  limit?: number | undefined;
}) {
  const shared = [
    input.ignoreCase ? "-i" : "",
    input.context ? `-C ${input.context}` : "",
  ];
  const target = `-- ${quote(input.pattern)} ${quote(input.path ?? ".")}`;
  const rg = [
    "rg --line-number --with-filename --no-heading --color=never --hidden",
    `--glob '!.git' --max-columns=${MAX_LINE} --max-columns-preview`,
    ...shared,
    input.literal ? "-F" : "",
    input.glob ? `--glob ${quote(input.glob)}` : "",
    target,
  ];
  const grep = [
    "grep -rnHI --color=never --exclude-dir=.git",
    ...shared,
    input.literal ? "-F" : "-E",
    input.glob ? `--include=${quote(input.glob)}` : "",
    target,
  ];
  const join = (words: string[]) => words.filter(Boolean).join(" ");
  return `if command -v rg >/dev/null 2>&1; then ${join(rg)}; else ${join(grep)} | cut -c1-${MAX_LINE}; fi | head -n ${input.limit ?? MAX_MATCH_LINES}`;
}

/** Files under `path` whose path matches a glob, relative to `path` and sorted. */
export function findCommand(input: {
  pattern: string;
  path?: string | undefined;
  limit?: number | undefined;
}) {
  const { pattern } = input;
  // find's -name sees one path segment, and its -path lets `*` cross `/`.
  const test = pattern.includes("/")
    ? `-path ${quote(`./${pattern}`)}`
    : `-name ${quote(pattern)}`;
  return `cd -- ${quote(input.path ?? ".")} && { if command -v rg >/dev/null 2>&1; then rg --files --hidden --glob '!.git' --glob ${quote(pattern)}; else find . -type f -not -path '*/.git/*' ${test} | sed 's|^\\./||'; fi; } | sort | head -n ${input.limit ?? MAX_FILES}`;
}

/** Runs a command and returns what it printed, however it ended. */
async function capture(
  workspace: AgentWorkspace,
  command: string,
  signal: AbortSignal,
  timeoutMs?: number,
) {
  let output = "";
  let dropped = false;
  const text = () => tail(output, dropped);
  try {
    const code = await workspace.exec(command, {
      signal,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      onData(chunk) {
        output += chunk;
        // A long build can print far more than is ever returned.
        if (output.length > 4 * MAX_CHARS) {
          output = output.slice(-2 * MAX_CHARS);
          dropped = true;
        }
      },
    });
    return { code, text: text() };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error([text(), reason].filter(Boolean).join("\n\n"));
  }
}

/** The seven tools for one run. `signal` ends any command still running. */
export function codingTools(workspace: AgentWorkspace, signal: AbortSignal) {
  const path = z
    .string()
    .min(1)
    .describe("Relative to the workspace, or absolute inside it");
  return {
    read: tool({
      description: `Read a text file. Returns at most ${MAX_LINES} lines or ${MAX_CHARS / 1000}k characters; use offset and limit for the rest of a long file.`,
      inputSchema: z.object({
        path,
        offset: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("Line to start from, counting from 1"),
        limit: z.number().int().min(1).optional().describe("Most lines"),
      }),
      execute: async ({ path, offset = 1, limit }) => {
        const lines = (await workspace.readFile(path)).split("\n");
        if (offset > lines.length)
          throw new Error(
            `Offset ${offset} is past the end of the file (${lines.length} lines)`,
          );
        const wanted = lines.slice(offset - 1).slice(0, limit);
        const count = fitting(wanted);
        if (!count)
          return `[Line ${offset} is longer than ${MAX_CHARS} characters. Read part of it with bash.]`;
        const end = offset - 1 + count;
        const text = wanted.slice(0, count).join("\n");
        return end < lines.length
          ? `${text}\n\n[Lines ${offset}-${end} of ${lines.length}. Use offset=${end + 1} to continue.]`
          : text;
      },
    }),
    write: tool({
      description:
        "Create a file, or replace all of it. Folders in the path are created.",
      inputSchema: z.object({ path, content: z.string() }),
      execute: async ({ path, content }) => {
        await workspace.writeFile(path, content);
        return `Wrote ${content.length} characters to ${path}.`;
      },
    }),
    edit: tool({
      description:
        "Change a file by exact text replacement. Each oldText must occur exactly once in the file as it is now, and the edits must not overlap.",
      inputSchema: z.object({
        path,
        edits: z
          .array(
            z.object({
              oldText: z
                .string()
                .min(1)
                .describe("Exact text, including whitespace"),
              newText: z.string(),
            }),
          )
          .min(1),
      }),
      execute: async ({ path, edits }) => {
        const before = await workspace.readFile(path);
        const spans = edits
          .map(({ oldText, newText }, index) => {
            const at = before.indexOf(oldText);
            if (at < 0)
              throw new Error(
                `edits[${index}]: oldText is not in ${path}. It must match exactly, including whitespace.`,
              );
            if (before.indexOf(oldText, at + 1) >= 0)
              throw new Error(
                `edits[${index}]: oldText occurs more than once in ${path}. Include more of the surrounding text.`,
              );
            return { at, end: at + oldText.length, newText };
          })
          .sort((a, b) => a.at - b.at);
        let after = "";
        let from = 0;
        for (const span of spans) {
          if (span.at < from) throw new Error("Two edits overlap");
          after += before.slice(from, span.at) + span.newText;
          from = span.end;
        }
        after += before.slice(from);
        if (after === before) throw new Error("The edits change nothing");
        await workspace.writeFile(path, after);
        return `Applied ${edits.length} ${edits.length === 1 ? "edit" : "edits"} to ${path}.`;
      },
    }),
    bash: tool({
      description: `Run a bash command, starting in the workspace. Returns standard output and error together: the last ${MAX_LINES} lines or ${MAX_CHARS / 1000}k characters. A command may run for 30 minutes at most.`,
      inputSchema: z.object({
        command: z.string().min(1),
        timeout: z
          .number()
          .positive()
          .optional()
          .describe("Seconds before the command is killed"),
      }),
      execute: async ({ command, timeout }) => {
        const { code, text } = await capture(
          workspace,
          command,
          signal,
          timeout === undefined ? undefined : Math.ceil(timeout * 1000),
        );
        if (code === 0) return text || "(no output)";
        throw new Error(
          [
            text,
            code === null
              ? "Command was ended by a signal"
              : `Command exited with code ${code}`,
          ]
            .filter(Boolean)
            .join("\n\n"),
        );
      },
    }),
    grep: tool({
      description: `Search file contents. Returns path:line:text for each match, at most ${MAX_MATCH_LINES} lines unless limit says otherwise. Files named in .gitignore are skipped where ripgrep is installed.`,
      inputSchema: z.object({
        pattern: z.string().min(1).describe("Regular expression"),
        path: z.string().min(1).optional().describe("File or directory"),
        glob: z.string().min(1).optional().describe("Such as *.ts"),
        ignoreCase: z.boolean().optional(),
        literal: z
          .boolean()
          .optional()
          .describe("Treat the pattern as plain text"),
        context: z
          .number()
          .int()
          .min(0)
          .max(20)
          .optional()
          .describe("Lines shown before and after each match"),
        limit: z.number().int().min(1).max(MAX_LINES).optional(),
      }),
      execute: async (input) => {
        const { text } = await capture(workspace, grepCommand(input), signal);
        return text || "No matches.";
      },
    }),
    find: tool({
      description: `Find files by glob, such as *.ts or src/**/*.test.ts. Returns paths relative to the searched directory, sorted, at most ${MAX_FILES} unless limit says otherwise.`,
      inputSchema: z.object({
        pattern: z.string().min(1).describe("Glob"),
        path: z.string().min(1).optional().describe("Directory to search"),
        limit: z.number().int().min(1).max(10_000).optional(),
      }),
      execute: async (input) => {
        const { text } = await capture(workspace, findCommand(input), signal);
        return text || "No files.";
      },
    }),
    ls: tool({
      description: `List a directory, dotfiles included. Directories end in "/". Returns at most ${MAX_ENTRIES} entries.`,
      inputSchema: z.object({ path: path.optional() }),
      execute: async ({ path = "." }) => {
        const names = (await workspace.list(path))
          .map((entry) => (entry.directory ? `${entry.name}/` : entry.name))
          .sort((a, b) => a.localeCompare(b));
        if (!names.length) return "(empty directory)";
        const shown = names.slice(0, MAX_ENTRIES).join("\n");
        return names.length > MAX_ENTRIES
          ? `${shown}\n\n[${names.length - MAX_ENTRIES} more entries are not shown.]`
          : shown;
      },
    }),
  };
}
