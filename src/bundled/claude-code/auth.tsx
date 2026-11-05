// How Buzz's Claude authenticates: with an Anthropic API key, pasted in
// setup, saved beside Buzz's copy of Claude (`claude.sh save-key`) and given
// to every `claude` as `ANTHROPIC_API_KEY`, never as an argument.
//
// Builds can replace this one file with another way to sign in, so the rest
// of the plugin reaches authentication only through its exports: keep their
// names and shapes when changing it.
import { useEffect, useState } from "react";
import { Button } from "../../shared/design-system/ui/Button";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import type { Spawn } from "./claude";
import type { ClaudeSetup } from "./setup";

const NO_KEY =
  "Claude needs an Anthropic API key. Add one in Settings → Agent setup → Harness defaults → Claude → Edit configuration.";
const REJECTED_KEY =
  "Anthropic rejected the Claude API key. It may have been revoked or run out of credit. Paste a working key in Settings → Agent setup → Harness defaults → Claude → Edit configuration.";

/** Runs one process as a setup step, its output shown; throws unless it
 * succeeds. */
export type Step = (
  id: string,
  args: readonly string[],
  label: string,
) => Promise<void>;
type Env = Readonly<Record<string, string | null>>;

/** Runs a `claude.sh` step with `input` on stdin, stopped if `signal`
 * aborts; its output, or throws what it printed. */
async function output(
  spawn: Spawn,
  id: string,
  input = "",
  signal?: AbortSignal,
) {
  let stdout = "";
  let stderr = "";
  const process = await spawn(id, {
    onStdout: (text) => {
      stdout += text;
    },
    onStderr: (text) => {
      stderr += text;
    },
  });
  const stop = () => void process.kill();
  signal?.addEventListener("abort", stop, { once: true });
  if (signal?.aborted) stop();
  try {
    await (input ? process.end(input) : process.end());
    const code = await process.exited;
    if (code !== 0)
      throw new Error(stderr.trim() || `${id} ended (${code ?? "stopped"}).`);
    return stdout;
  } finally {
    signal?.removeEventListener("abort", stop);
  }
}

/** Claude's credentials on this computer. */
export class ClaudeAuth {
  /** Which way this build authenticates. */
  readonly id = "buzz-claude-auth:api-key";
  /** What the agent type's row asks for while Claude cannot run. */
  readonly attentionLabel = "Add Claude API key";
  /** Ends "Claude 2.1.0 …" while Claude cannot run. */
  readonly needs = "needs an Anthropic API key";
  /** An interactive sign-in setup runs as its step, when there is one. */
  readonly signIn: ((step: Step) => Promise<void>) | undefined = undefined;
  private key: Promise<string> | undefined;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly spawn: Spawn | undefined) {}

  /** Told when the credentials change, so running sessions start again. */
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** The saved key, read once until it is saved again or checked. */
  private read() {
    const spawn = this.spawn;
    if (!spawn) return Promise.resolve("");
    if (this.key) return this.key;
    const reading = output(spawn, "key").then((text) => text.trim());
    this.key = reading;
    reading.catch(() => {
      if (this.key === reading) this.key = undefined;
    });
    return reading;
  }

  /** Whether Claude can run turns: an account to show, or undefined. */
  async check(): Promise<Readonly<{ account?: string }> | undefined> {
    this.key = undefined;
    return (await this.read()) ? {} : undefined;
  }

  /** Saves `key` for every `claude` started from now on; the step's line. */
  async save(key: string, signal?: AbortSignal) {
    const spawn = this.spawn;
    if (!spawn) throw new Error("Claude runs only in the desktop app");
    const saved = await output(spawn, "save-key", `${key}\n`, signal);
    this.key = undefined;
    for (const listener of this.listeners) listener();
    return saved.trim();
  }

  /** `spawn`, starting each `claude` with the saved key. `required` refuses
   * to start one without a key, so no turn falls back on an account sign-in
   * that `~/.claude` may hold. */
  authorize(spawn: Spawn, required = false): Spawn {
    return async (id, options) => {
      // Buzz's copy, and the protected release (`claude-protected-*`).
      if (id !== "claude" && !id.startsWith("claude-protected-"))
        return spawn(id, options);
      const key = await this.read();
      if (!key && required) throw new Error(NO_KEY);
      return spawn(
        id,
        key
          ? { ...options, env: { ...options?.env, ANTHROPIC_API_KEY: key } }
          : options,
      );
    };
  }

  /** Security reviews' own Claude folder (absolute), which contained agents
   * cannot write, and what they authenticate with. */
  async review(): Promise<Readonly<{ home: string; env: Env }>> {
    const spawn = this.spawn;
    if (!spawn) throw new Error("Claude reviews need the desktop app");
    const key = await this.read();
    if (!key) throw new Error(NO_KEY);
    const home = (await output(spawn, "review")).trim();
    if (!home.startsWith("/"))
      throw new Error("Claude's review folder is unreadable");
    return { home, env: { ANTHROPIC_API_KEY: key } };
  }

  /** A failed review's error, as the person can act on it. */
  explain(error: string) {
    return /authentication_error|invalid x-api-key/i.test(error)
      ? REJECTED_KEY
      : error;
  }
}

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** Setup's ask while Claude cannot run: the key. */
export function SignIn({
  setup,
  disabled = false,
  variant = "full",
}: {
  setup: ClaudeSetup;
  disabled?: boolean;
  variant?: "full" | "compact";
}) {
  return (
    <KeyForm
      setup={setup}
      disabled={disabled}
      compact={variant === "compact"}
    />
  );
}

/** Claude's settings once it can run: replacing the key. */
export function SignedIn({ setup }: { setup: ClaudeSetup }) {
  return (
    <div className="grid gap-2">
      <p className="m-0 text-body-sm text-subtle">
        Claude runs with your Anthropic API key.
      </p>
      <KeyForm setup={setup} replace />
    </div>
  );
}

function KeyForm({
  setup,
  disabled = false,
  compact = false,
  replace = false,
}: {
  setup: ClaudeSetup;
  disabled?: boolean;
  compact?: boolean;
  replace?: boolean;
}) {
  const [key, setKey] = useState("");
  const [saving, setSaving] = useState<AbortController>();
  // Kept until the form closes.
  const [saved, setSaved] = useState<{ ok: boolean; text: string }>();
  // Closing the form cancels a save.
  useEffect(() => () => saving?.abort(), [saving]);
  const save = async () => {
    const controller = new AbortController();
    setSaving(controller);
    setSaved(undefined);
    try {
      const text = await setup.auth.save(key.trim(), controller.signal);
      setKey("");
      setSaved({ ok: true, text });
      await setup.check();
    } catch (error) {
      if (!controller.signal.aborted)
        setSaved({ ok: false, text: message(error) });
    } finally {
      setSaving(undefined);
    }
  };
  return (
    <form
      className="grid gap-2"
      aria-busy={saving ? true : undefined}
      onSubmit={(event) => {
        event.preventDefault();
        if (key.trim() && !saving && !disabled) void save();
      }}
    >
      <Field
        label={replace ? "Replace API key" : "Anthropic API key"}
        description="Create a key at console.anthropic.com. Buzz keeps it on this computer and gives it only to Claude."
      >
        <Input
          type="password"
          autoComplete="off"
          value={key}
          readOnly={!!saving}
          aria-disabled={saving || disabled ? true : undefined}
          onValueChange={setKey}
        />
      </Field>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="submit"
          {...(!replace && { variant: "prominent" as const })}
          size={compact ? "sm" : "md"}
          disabled={disabled || !key.trim()}
          focusableWhenDisabled
          loading={!!saving}
        >
          Save key
        </Button>
        {saved && (
          <p
            role={saved.ok ? "status" : "alert"}
            className={
              saved.ok ? "m-0 text-body-sm text-subtle" : "buzz-field-error m-0"
            }
          >
            {saved.text}
          </p>
        )}
      </div>
    </form>
  );
}
