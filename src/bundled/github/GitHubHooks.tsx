import { useEffect, useState, useSyncExternalStore } from "react";
import type { PanelProps } from "../../features/panels/service";
import { usePanelTabTitle } from "../../features/panels/PanelWorkspace";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import { ARTIFACT_REVISION_KIND } from "../../features/relay/artifact-sync";
import { GithubLogoIcon } from "../../shared/design-system/icons/index";
import { writeClipboardText } from "../../shared/clipboard";
import { Button } from "../../shared/design-system/ui/Button";
import { Field } from "../../shared/design-system/ui/Field";
import { Header, InlineHeader } from "../../shared/design-system/ui/Header";
import { Input } from "../../shared/design-system/ui/Input";
import { PreferenceRow } from "../../shared/design-system/ui/PreferenceRow";
import { Radio, RadioGroup } from "../../shared/design-system/ui/RadioGroup";
import { SettingsGroup } from "../../shared/design-system/ui/SettingsGroup";
import {
  HOOK_EVENTS,
  HOOK_TYPE,
  canSeal,
  follow,
  followFromDevice,
  parseHook,
  regenerate,
  repositoryOf,
  sealHookSecret,
  unfollow,
  webhookUrl,
  type Hook,
  type Seal,
} from "./hooks";

const tabIcon = <GithubLogoIcon size="1rem" />;

type Setup = Readonly<{ url: string; repo: string; secret: string }>;
type Mode = "device" | "relay";

type HookView = ReturnType<RelaySession["artifacts"]["sync"]>;
const NONE = { status: "loading", events: [] } as const;
const noSubscribe = () => () => {};

function useHooks(session: RelaySession, channel: string) {
  const [view, setView] = useState<HookView | "unavailable">();
  useEffect(() => {
    let next: HookView;
    try {
      next = session.artifacts.sync({
        artifact: "current",
        kinds: [ARTIFACT_REVISION_KIND],
        "#h": [channel],
        "#type": [HOOK_TYPE],
      });
    } catch {
      setView("unavailable");
      return;
    }
    setView(next);
    return () => next.dispose();
  }, [session, channel]);
  const live = typeof view === "object" ? view : undefined;
  const { status, events } = useSyncExternalStore(
    live?.subscribe ?? noSubscribe,
    live?.snapshot ?? (() => NONE),
  );
  return {
    status: view === "unavailable" ? "unsupported" : status,
    hooks: events.flatMap((event) => parseHook(event) ?? []),
  };
}

function CopyButton({ label, text }: { label: string; text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      size="sm"
      aria-label={`Copy ${label}`}
      onClick={() => {
        void writeClipboardText(text).then(
          () => setCopied(true),
          () => setCopied(false),
        );
      }}
    >
      {copied ? "Copied" : "Copy"}
    </Button>
  );
}

function Copyable({ label, value }: { label: string; value: string }) {
  return (
    <Field label={label}>
      <div className="flex items-center gap-2">
        <Input readOnly value={value} aria-label={label} />
        <CopyButton label={label.toLowerCase()} text={value} />
      </div>
    </Field>
  );
}

function SetupSteps({ setup, done }: { setup: Setup; done(): void }) {
  return (
    <SettingsGroup layout="form">
      <InlineHeader
        title={`Add the webhook to ${setup.repo}`}
        subtitle="In the repository on GitHub, open Settings, then Webhooks, then Add webhook. The secret is shown only now."
      />
      <Copyable label="Payload URL" value={setup.url} />
      <Copyable label="Secret" value={setup.secret} />
      <p className="m-0 text-body-sm text-subtle">
        Set Content type to application/json. Choose Let me select individual
        events and select {HOOK_EVENTS.join(", ")}.
      </p>
      <div className="flex flex-wrap items-center justify-end gap-3">
        <Button type="button" variant="primary" onClick={done}>
          Done
        </Button>
      </div>
    </SettingsGroup>
  );
}

function Hooks({
  session,
  origin,
  channel,
  seal,
}: {
  session: RelaySession;
  origin: string;
  channel: string;
  seal: Seal | undefined;
}) {
  const { status, hooks } = useHooks(session, channel);
  const [repo, setRepo] = useState("");
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState("");
  const [setup, setSetup] = useState<Setup>();
  const [mode, setMode] = useState<Mode>("device");
  const name = repositoryOf(repo);
  const viewer = session.viewer;
  const able = mode === "device" ? !!viewer : !!seal;
  const run = async (key: string, action: () => Promise<void>) => {
    setBusy(key);
    setError("");
    try {
      await action();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(undefined);
    }
  };
  const duplicate = !!name && hooks.some((hook) => hook.repo === name);
  return (
    <section aria-label="GitHub repositories">
      <Header
        title="GitHub"
        subtitle="Follow a repository to post its pull requests here, with their checks and reviews kept current."
      />
      {setup ? (
        <SetupSteps setup={setup} done={() => setSetup(undefined)} />
      ) : (
        <form
          aria-label="Follow a repository"
          onSubmit={(event) => {
            event.preventDefault();
            if (!name || !able || duplicate || busy) return;
            void run("follow", async () => {
              if (mode === "device" || !seal) {
                await followFromDevice(session, channel, name);
                setRepo("");
                return;
              }
              const { d, secret } = await follow(
                session,
                origin,
                seal,
                channel,
                name,
              );
              setRepo("");
              setSetup({ url: webhookUrl(origin, d), repo: name, secret });
            });
          }}
        >
          <SettingsGroup layout="form">
            <Field
              label="Follow a repository"
              description="Enter owner/repo or its github.com link."
              error={
                duplicate
                  ? "This channel already follows it."
                  : repo.trim() && !name
                    ? "Enter a repository as owner/repo."
                    : undefined
              }
            >
              <Input
                value={repo}
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
                autoComplete="off"
                placeholder="owner/repo"
                onChange={(event) => setRepo(event.target.value)}
              />
            </Field>
            <Field label="Publish with">
              <RadioGroup
                value={mode}
                onValueChange={(value) => setMode(value as Mode)}
              >
                <Radio
                  value="device"
                  label="Publish from this device"
                  description="Your Buzz reads the repository with gh and posts its pull requests as you, while it is open."
                />
                <Radio
                  value="relay"
                  label="Relay webhook"
                  description="GitHub sends the repository's events to the community, which posts them whether or not anyone is online. GitHub must be able to reach the community."
                />
              </RadioGroup>
            </Field>
            {mode === "relay" && !seal && (
              <p role="status" className="m-0 text-body-sm text-subtle">
                A relay webhook needs the desktop app, which holds your key.
              </p>
            )}
            <div className="flex flex-wrap items-center justify-end gap-3">
              <Button
                type="submit"
                variant="primary"
                disabled={!name || !able || duplicate || !!busy}
              >
                Follow
              </Button>
            </div>
          </SettingsGroup>
        </form>
      )}
      {error && (
        <p role="alert" className="m-0 text-body-sm text-danger">
          {error}
        </p>
      )}
      <InlineHeader title="Followed repositories" />
      {status === "unsupported" || status === "error" ? (
        <p role="status" className="m-0 text-body-sm text-subtle">
          This community can’t list followed repositories.
        </p>
      ) : !hooks.length ? (
        <p role="status" className="m-0 text-body-sm text-subtle">
          {status === "loading"
            ? "Loading…"
            : "No repositories followed in this channel."}
        </p>
      ) : (
        <SettingsGroup>
          {hooks.map((hook: Hook) => (
            <PreferenceRow
              key={hook.d}
              title={hook.repo}
              {...(hook.publisher && {
                subtitle:
                  hook.publisher === viewer
                    ? "Published from your Buzz. Cards update while it is open."
                    : "Published from a member's Buzz. Cards update while it is open.",
              })}
              trailing={
                <div className="flex flex-wrap items-center justify-end gap-2">
                  {seal && !hook.publisher && (
                    <Button
                      type="button"
                      disabled={!!busy}
                      onClick={() =>
                        void run(`rotate:${hook.d}`, async () => {
                          const secret = await regenerate(
                            session,
                            origin,
                            seal,
                            channel,
                            hook,
                          );
                          setSetup({
                            url: webhookUrl(origin, hook.d),
                            repo: hook.repo,
                            secret,
                          });
                        })
                      }
                    >
                      Regenerate secret
                    </Button>
                  )}
                  <Button
                    type="button"
                    disabled={!!busy}
                    onClick={() =>
                      void run(`unfollow:${hook.d}`, () =>
                        unfollow(session, channel, hook),
                      )
                    }
                  >
                    Unfollow
                  </Button>
                </div>
              }
            />
          ))}
        </SettingsGroup>
      )}
    </section>
  );
}

export function GitHubHooks({
  relay,
  channelContext,
}: { relay: RelayData } & Pick<PanelProps, "channelContext">) {
  usePanelTabTitle("GitHub", tabIcon);
  const state = useSyncExternalStore(relay.subscribe, relay.snapshot);
  if (
    !channelContext ||
    state.status !== "ready" ||
    !state.origin ||
    state.scope !== channelContext.scope
  )
    return (
      <p role="status">
        GitHub repositories are unavailable while the connection recovers.
      </p>
    );
  return (
    <Hooks
      key={`${state.scope}:${state.generation}:${channelContext.channelId}`}
      session={state.session}
      origin={state.origin}
      channel={channelContext.channelId}
      seal={canSeal() ? sealHookSecret : undefined}
    />
  );
}
