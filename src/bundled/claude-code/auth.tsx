// How Buzz's Claude authenticates: a device-local choice between an Anthropic
// API key (native OS credential store, `claude_key.rs`) and a Claude account
// (`claude auth login`). Builds can replace this one file, so the rest of the
// plugin reaches authentication only through its exports: keep their names
// and shapes when changing it.
import { invoke, isTauri } from "@tauri-apps/api/core";
import { useEffect, useState, useSyncExternalStore } from "react";
import { localStore, type AgentStore } from "../../features/agents/store";
import { Button } from "../../shared/design-system/ui/Button";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import { Select } from "../../shared/design-system/ui/Select";
import inlineStyles from "../../shared/InlineReference.module.css";
import { ENV, type Spawn } from "./claude";
import type { ClaudeSetup } from "./setup";

const NO_KEY =
  "Claude needs an Anthropic API key. Add one in Settings → Agent setup → Harness defaults → Claude → Edit configuration.";
const NO_ACCOUNT =
  "Claude needs a Claude account sign-in. Sign in in Settings → Agent setup → Harness defaults → Claude → Edit configuration.";
const NO_REVIEW_SIGN_IN =
  "Claude security reviews need their own sign-in. Run claude setup-token in Terminal, then paste the token under Sign in for reviews in Settings → Agent setup → Harness defaults → Claude → Edit configuration. It needs a Claude Pro, Max, Team or Enterprise subscription.";
const REJECTED_REVIEW_SIGN_IN =
  "Claude rejected the security-review sign-in. It may have expired (it lasts a year) or been revoked, or the account has no Claude subscription. Run claude setup-token again and paste the new token under Sign in for reviews in Settings → Agent setup → Harness defaults → Claude → Edit configuration.";
/** What setup says first: the key is one for all of Claude, not per agent. */
const KEY_ONCE =
  "Claude requires an API key to connect to your account. Create one at console.anthropic.com and paste it below. You only have to set this up once, and Buzz keeps it securely on this computer.";
const ACCOUNT_ONCE =
  "Claude runs with the Claude account signed in on this computer. Click Sign in to open Claude's login. Buzz does not send your Anthropic API key while this is selected.";
const REJECTED_KEY =
  "Anthropic rejected the Claude API key. It may have been revoked or run out of credit. Paste a working key in Settings → Agent setup → Harness defaults → Claude → Edit configuration.";
export const AUTH_METHOD_KEY = "buzz.claude-code.auth-method.v1";
export type AuthMethod = "api-key" | "cli-account";

/** Runs one process as a setup step, its output shown; throws unless it
 * succeeds. */
export type Step = (
  id: string,
  args: readonly string[],
  label: string,
) => Promise<void>;
type Env = Readonly<Record<string, string | null>>;

/** Runs a `claude.sh` step; its output, or throws what it printed. */
async function output(
  spawn: Spawn,
  id: string,
  args?: readonly string[],
  env?: Env,
) {
  let stdout = "";
  let stderr = "";
  const process = await spawn(id, {
    ...(args ? { args } : {}),
    ...(env ? { env } : {}),
    onStdout: (text) => {
      stdout += text;
    },
    onStderr: (text) => {
      stderr += text;
    },
  });
  await process.end();
  const code = await process.exited;
  if (code !== 0)
    throw new Error(stderr.trim() || `${id} ended (${code ?? "stopped"}).`);
  return stdout;
}

function defaultMethodStore(): AgentStore {
  try {
    if (typeof localStorage !== "undefined") return localStore();
  } catch {
    // Node tests have no Storage; keep the choice in memory.
  }
  const data = new Map<string, string>();
  return Object.freeze({
    keys: () => [...data.keys()],
    get: (key: string) => data.get(key) ?? null,
    read: async (key: string) => data.get(key) ?? null,
    scan: async (prefix: string) =>
      Object.fromEntries([...data].filter(([key]) => key.startsWith(prefix))),
    set: async (key: string, value: string | null) => {
      if (value === null) data.delete(key);
      else data.set(key, value);
    },
    add: async (key: string, value: string) => {
      const held = data.get(key);
      if (held !== undefined) return held;
      data.set(key, value);
      return value;
    },
  });
}

function readMethod(storage: AgentStore): AuthMethod {
  try {
    const value: unknown = JSON.parse(storage.get(AUTH_METHOD_KEY) ?? "null");
    if (
      value &&
      typeof value === "object" &&
      (value as { version?: unknown }).version === 1 &&
      ((value as { method?: unknown }).method === "api-key" ||
        (value as { method?: unknown }).method === "cli-account")
    )
      return (value as { method: AuthMethod }).method;
  } catch {
    // Malformed preferences keep the API-key default.
  }
  return "api-key";
}

/** The key's native store (`claude_key.rs`): the OS credential store,
 * which hands the key to the Claude processes that ask for it. Nothing
 * here reads it back; native code relies on that, as it gives the key to
 * `claude-sh`, which runs whatever script it is given. */
const nativeStore = ():
  | Readonly<{
      /** Whether a key is saved. */
      status(): Promise<boolean>;
      /** Saves the key; it is never read back. */
      save(key: string): Promise<void>;
    }>
  | undefined =>
  isTauri()
    ? {
        status: async () => (await invoke("claude_api_key_status")) === true,
        save: (value) => invoke("claude_api_key_set", { value }),
      }
    : undefined;

/** Whether Claude leads the Harness list and is new agents' default
 * (`src/bundled/index.ts`). Not here: Claude asks for an API key before its
 * first agent, so Codex leads. A build whose Claude signs in without that
 * friction can put it first. */
export const leadsHarnesses = false;

/** Claude's credentials on this computer. */
export class ClaudeAuth {
  private currentMethod: AuthMethod;
  private saved: Promise<boolean> | undefined;
  private cliAccount:
    | Promise<Readonly<{ account?: string }> | undefined>
    | undefined;
  private readonly listeners = new Set<() => void>();
  private readonly store;
  private readonly storage;

  constructor(
    private readonly spawn: Spawn | undefined,
    storage: AgentStore = defaultMethodStore(),
  ) {
    this.store = spawn ? nativeStore() : undefined;
    this.storage = storage;
    this.currentMethod = readMethod(storage);
  }

  /** Which way this build authenticates. */
  get id() {
    return this.currentMethod === "cli-account"
      ? "buzz-claude-auth:cli-account"
      : "buzz-claude-auth:api-key";
  }
  /** What the agent type's row asks for while Claude cannot run. */
  get attentionLabel() {
    return this.currentMethod === "cli-account"
      ? "Sign in to Claude"
      : "Add Claude API key";
  }
  /** Ends "Claude 2.1.0 …" while Claude cannot run. */
  get needs() {
    return this.currentMethod === "cli-account"
      ? "needs a Claude account sign-in"
      : "needs an Anthropic API key";
  }
  /** An interactive sign-in setup runs as its step, when there is one. */
  get signIn(): ((step: Step) => Promise<void>) | undefined {
    if (this.currentMethod !== "cli-account") return undefined;
    return (step) => step("claude", ["auth", "login"], "Sign-in");
  }
  /** The persisted sign-in method. */
  get method(): AuthMethod {
    return this.currentMethod;
  }

  /** Saves the method before it becomes active, then tells listeners. */
  async setMethod(next: AuthMethod, signal?: AbortSignal) {
    if (next !== "api-key" && next !== "cli-account")
      throw new Error("Unknown Claude sign-in method");
    signal?.throwIfAborted();
    await this.storage.set(
      AUTH_METHOD_KEY,
      JSON.stringify({ version: 1, method: next }),
    );
    this.currentMethod = next;
    this.saved = undefined;
    this.cliAccount = undefined;
    for (const listener of this.listeners) listener();
  }

  /** Told when the credentials change, so running sessions start again. */
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Whether a key is saved, asked once until it is saved again or checked;
   * no key is asked again each time. */
  private has() {
    const store = this.store;
    if (!store) return Promise.resolve(false);
    if (this.saved) return this.saved;
    const asking = store.status();
    this.saved = asking;
    // Only a saved key is kept: another Buzz on this computer may save one.
    const forget = () => {
      if (this.saved === asking) this.saved = undefined;
    };
    asking.then((saved) => saved || forget(), forget);
    return asking;
  }

  /** Whether Claude can run turns: an account to show, or undefined. */
  async check(): Promise<Readonly<{ account?: string }> | undefined> {
    const method = this.currentMethod;
    if (method === "cli-account") {
      this.cliAccount = undefined;
      return this.account();
    }
    this.saved = undefined;
    return (await this.has()) ? {} : undefined;
  }

  private account() {
    const spawn = this.spawn;
    if (!spawn) return Promise.resolve(undefined);
    if (this.cliAccount) return this.cliAccount;
    const asking = (async () => {
      try {
        const stdout = await output(
          spawn,
          "claude",
          ["auth", "status", "--json"],
          ENV,
        );
        const status = JSON.parse(stdout) as {
          loggedIn?: boolean;
          email?: string;
          orgName?: string;
        };
        if (!status.loggedIn) return undefined;
        const account = [status.email, status.orgName]
          .filter(Boolean)
          .join(" · ");
        return account ? { account } : {};
      } catch {
        return undefined;
      }
    })();
    this.cliAccount = asking;
    const forget = () => {
      if (this.cliAccount === asking) this.cliAccount = undefined;
    };
    asking.then((signed) => signed || forget(), forget);
    return asking;
  }

  /** Saves `key` for every `claude` started from now on; what to say. A
   * save can't be stopped once it reaches the store, so `signal` only
   * stops one that hasn't. */
  async save(key: string, signal?: AbortSignal) {
    const store = this.store;
    if (!store) throw new Error("Claude runs only in the desktop app");
    signal?.throwIfAborted();
    try {
      await store.save(key);
    } finally {
      // A refused save leaves the key as it was; anything else may not.
      this.saved = undefined;
    }
    for (const listener of this.listeners) listener();
    return "Saved the Anthropic API key.";
  }

  /** `spawn`, starting each `claude` with the selected credentials.
   * `required` refuses to start a turn without them, so no turn falls back
   * on the other method. */
  authorize(spawn: Spawn, required = false): Spawn {
    return async (id, options) => {
      const method = this.currentMethod;
      // Buzz's copy, and the protected release (`claude-protected-*`).
      if (id !== "claude" && !id.startsWith("claude-protected-"))
        return spawn(id, options);
      if (method === "cli-account") {
        if (required && !(await this.account())) throw new Error(NO_ACCOUNT);
        const secrets = (options?.secrets ?? []).filter(
          (secret) => secret !== "anthropic-api-key",
        );
        return spawn(id, {
          ...options,
          env: { ...ENV, ...options?.env, ANTHROPIC_API_KEY: null },
          ...(secrets.length ? { secrets } : { secrets: undefined }),
        });
      }
      if (required && !(await this.has())) throw new Error(NO_KEY);
      return spawn(id, {
        ...options,
        secrets: [...(options?.secrets ?? []), "anthropic-api-key"],
      });
    };
  }

  /** Security reviews' own Claude folder (absolute), which contained agents
   * cannot write, and what they authenticate with. API-key mode uses the
   * stored key; account mode uses a separately pasted setup-token. */
  async review(): Promise<Readonly<{ home: string; env: Env }>> {
    const spawn = this.spawn;
    const method = this.currentMethod;
    if (!spawn) throw new Error("Claude reviews need the desktop app");
    if (method === "cli-account") {
      const stdout = await output(spawn, "review");
      const [home, token] = stdout.trimEnd().split("\n");
      if (!home?.startsWith("/") || !token) throw new Error(NO_REVIEW_SIGN_IN);
      return { home, env: { CLAUDE_CODE_OAUTH_TOKEN: token } };
    }
    if (!(await this.has())) throw new Error(NO_KEY);
    const home = (await output(spawn, "review")).trim();
    if (!home.startsWith("/"))
      throw new Error("Claude's review folder is unreadable");
    return { home, env: {} };
  }

  /** A failed review's error, as the person can act on it. */
  explain(error: string) {
    if (error.includes(NO_REVIEW_SIGN_IN)) return NO_REVIEW_SIGN_IN;
    if (rejectedReview(error)) return REJECTED_REVIEW_SIGN_IN;
    return rejected(error) ? REJECTED_KEY : error;
  }

  /** A failed turn's error as its report in the conversation says it, in
   * Markdown: a missing or rejected key links to `settings`, where it is
   * added once for every Claude agent. */
  explainTurn(error: string, settings: string) {
    if (error.includes(NO_KEY))
      return `Claude is missing an API key. Head to [Settings](${settings}) to add one.`;
    if (error.includes(NO_ACCOUNT))
      return `Claude needs a Claude account sign-in. Head to [Settings](${settings}) to sign in.`;
    return rejected(error)
      ? `Anthropic rejected Claude's API key. It may have been revoked or run out of credit. Head to [Settings](${settings}) to replace it.`
      : error;
  }
}

/** Whether a turn's error is Buzz's own refusal to start Claude without a
 * key, rather than anything Claude said. */
export const refusedByBuzz = (error: string) =>
  error.includes(NO_KEY) || error.includes(NO_ACCOUNT);

/** Whether Claude's error says Anthropic refused the key; turns end with
 * "Invalid API key · Fix external API key". */
const rejected = (error: string) =>
  /authentication_error|invalid x-api-key|invalid api key/i.test(error);

const rejectedReview = (error: string) =>
  /oauth|setup-token|not logged in|authentication_error/i.test(error) &&
  !/invalid x-api-key|invalid api key/i.test(error);

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

function useAuthMethod(setup: ClaudeSetup) {
  return useSyncExternalStore(
    setup.auth.subscribe,
    () => setup.auth.method,
    () => setup.auth.method,
  );
}

function AuthMethodPicker({
  setup,
  disabled = false,
}: {
  setup: ClaudeSetup;
  disabled?: boolean;
}) {
  const method = useAuthMethod(setup);
  const [saving, setSaving] = useState(false);
  return (
    <Select
      label="How Claude signs in"
      variant="field"
      value={method}
      disabled={disabled || saving}
      groups={[
        {
          label: "",
          options: [
            {
              value: "api-key",
              label: "Anthropic API key",
              description:
                "Bills the Console organization that owns the key, at API token rates.",
            },
            {
              value: "cli-account",
              label: "Claude account",
              description:
                "Uses claude auth login on this computer. Bills your Claude plan.",
            },
          ],
        },
      ]}
      onValueChange={(value) => {
        if (value !== "api-key" && value !== "cli-account") return;
        if (value === method) return;
        setSaving(true);
        void setup.auth
          .setMethod(value)
          .then(() => setup.check())
          .finally(() => setSaving(false));
      }}
    />
  );
}

/** Setup's ask while Claude cannot run: the selected method, once for every
 * agent. `onSaved` follows a saved key, so a surface can close. */
export function SignIn({
  setup,
  disabled = false,
  variant = "full",
  onSaved,
}: {
  setup: ClaudeSetup;
  disabled?: boolean;
  variant?: "full" | "compact";
  onSaved?: (() => void) | undefined;
}) {
  const method = useAuthMethod(setup);
  const running = useSyncExternalStore(
    setup.subscribe,
    setup.snapshot,
    setup.snapshot,
  ).running;
  return (
    <div className="grid gap-3">
      <AuthMethodPicker setup={setup} disabled={disabled} />
      {method === "cli-account" ? (
        <>
          <p className="m-0 text-body-sm text-secondary">{ACCOUNT_ONCE}</p>
          <div>
            <Button
              type="button"
              variant="prominent"
              size={variant === "compact" ? "sm" : "md"}
              disabled={disabled || !!running}
              loading={running === "sign-in"}
              onClick={() => void setup.run("sign-in")}
            >
              Sign in
            </Button>
          </div>
        </>
      ) : (
        <>
          <p className="m-0 text-body-sm text-secondary">{KEY_ONCE}</p>
          <KeyForm
            setup={setup}
            disabled={disabled}
            compact={variant === "compact"}
            onSaved={onSaved}
          />
        </>
      )}
    </div>
  );
}

/** Claude's settings once it can run. `onSaved` follows a saved key, so a
 * surface can close. */
export function SignedIn({
  setup,
  onSaved,
}: {
  setup: ClaudeSetup;
  onSaved?: (() => void) | undefined;
}) {
  const method = useAuthMethod(setup);
  const status = useSyncExternalStore(
    setup.subscribe,
    setup.snapshot,
    setup.snapshot,
  ).status;
  const account =
    status?.state === "ready" && status.account ? status.account : undefined;
  return (
    <div className="grid gap-3">
      <AuthMethodPicker setup={setup} />
      {method === "cli-account" ? (
        <>
          <p className="m-0 text-body-sm text-subtle">
            Claude runs with your Claude account
            {account ? ` (${account})` : ""}.
          </p>
          <ReviewSignInForm setup={setup} />
        </>
      ) : (
        <>
          <p className="m-0 text-body-sm text-subtle">
            Claude runs with your Anthropic API key.
          </p>
          <KeyForm setup={setup} replace onSaved={onSaved} />
        </>
      )}
    </div>
  );
}

function ReviewSignInForm({ setup }: { setup: ClaudeSetup }) {
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState<AbortController>();
  const [saved, setSaved] = useState<{ ok: boolean; text: string }>();
  useEffect(() => () => saving?.abort(), [saving]);
  const save = async () => {
    if (!token.trim() || saving) return;
    const controller = new AbortController();
    setSaving(controller);
    setSaved(undefined);
    try {
      const text = await setup.saveReviewSignIn(
        token.trim(),
        controller.signal,
      );
      setToken("");
      setSaved({ ok: true, text });
    } catch (error) {
      if (!controller.signal.aborted)
        setSaved({ ok: false, text: message(error) });
    } finally {
      setSaving(undefined);
    }
  };
  return (
    <div className="grid gap-2" aria-busy={saving ? true : undefined}>
      <Field
        label="Sign in for reviews"
        description={
          <>
            Security reviews sign in apart from your agents. Run{" "}
            <code>claude setup-token</code> in Terminal, then paste the token it
            prints. It lasts a year.
          </>
        }
      >
        <Input
          type="password"
          autoComplete="off"
          value={token}
          readOnly={!!saving}
          aria-disabled={saving ? true : undefined}
          onValueChange={setToken}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
            event.preventDefault();
            void save();
          }}
        />
      </Field>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          disabled={!token.trim()}
          focusableWhenDisabled
          loading={!!saving}
          onClick={() => void save()}
        >
          Save review sign-in
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
    </div>
  );
}

/** Where an agent's own surface, such as its library card, says Claude
 * cannot run: setup is one step in Settings, not one per agent. */
export function Missing({
  openSettings,
  method = "api-key",
}: {
  openSettings?: (() => void) | undefined;
  method?: AuthMethod;
}) {
  const account = method === "cli-account";
  return (
    <p className="m-0 text-body-sm text-secondary">
      {account
        ? "Claude needs a Claude account sign-in. "
        : "Claude is missing an API key. "}
      {openSettings ? (
        <>
          Head to{" "}
          <button
            type="button"
            className={inlineStyles.link}
            onClick={openSettings}
          >
            Settings
          </button>{" "}
          {account ? "to sign in." : "to add one."}
        </>
      ) : account ? (
        "Sign in in Settings → Agent setup."
      ) : (
        "Add one in Settings → Agent setup."
      )}
    </p>
  );
}

function KeyForm({
  setup,
  disabled = false,
  compact = false,
  replace = false,
  onSaved,
}: {
  setup: ClaudeSetup;
  disabled?: boolean;
  compact?: boolean;
  replace?: boolean;
  onSaved?: (() => void) | undefined;
}) {
  const [key, setKey] = useState("");
  const [saving, setSaving] = useState<AbortController>();
  // Kept until the form closes.
  const [saved, setSaved] = useState<{ ok: boolean; text: string }>();
  // Closing the form cancels a save.
  useEffect(() => () => saving?.abort(), [saving]);
  const save = async () => {
    if (!key.trim() || saving || disabled) return;
    const controller = new AbortController();
    setSaving(controller);
    setSaved(undefined);
    try {
      const text = await setup.auth.save(key.trim(), controller.signal);
      setKey("");
      setSaved({ ok: true, text });
      await setup.check();
      onSaved?.();
    } catch (error) {
      if (!controller.signal.aborted)
        setSaved({ ok: false, text: message(error) });
    } finally {
      setSaving(undefined);
    }
  };
  return (
    // Not a form: it sits inside agent creation's and Settings' own.
    <div className="grid gap-2" aria-busy={saving ? true : undefined}>
      <Field
        label={replace ? "Replace API key" : "Anthropic API key"}
        {...(replace && {
          description:
            "Create a key at console.anthropic.com. Buzz keeps it securely on this computer and gives it only to Claude, so commands your Claude agents run can read it.",
        })}
      >
        <Input
          type="password"
          autoComplete="off"
          value={key}
          readOnly={!!saving}
          aria-disabled={saving || disabled ? true : undefined}
          onValueChange={setKey}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
            event.preventDefault();
            void save();
          }}
        />
      </Field>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          {...(!replace && { variant: "prominent" as const })}
          size={compact ? "sm" : "md"}
          disabled={disabled || !key.trim()}
          focusableWhenDisabled
          loading={!!saving}
          onClick={() => void save()}
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
    </div>
  );
}
