import { useEffect, useState, useSyncExternalStore } from "react";
import type { PanelProps } from "../../features/panels/service";
import { usePanelTabTitle } from "../../features/panels/PanelWorkspace";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import { ARTIFACT_REVISION_KIND } from "../../features/relay/artifact-sync";
import { GithubLogoIcon } from "../../shared/design-system/icons/index";
import { AlertDialog } from "../../shared/design-system/ui/AlertDialog";
import { Button } from "../../shared/design-system/ui/Button";
import { Field } from "../../shared/design-system/ui/Field";
import { Header, InlineHeader } from "../../shared/design-system/ui/Header";
import { Input } from "../../shared/design-system/ui/Input";
import { PreferenceRow } from "../../shared/design-system/ui/PreferenceRow";
import { SettingsGroup } from "../../shared/design-system/ui/SettingsGroup";
import styles from "./GitHub.module.css";
import type { PublisherStatus } from "./publisher";
import {
  HOOK_TYPE,
  HookChanged,
  follow,
  parseHook,
  repositoryOf,
  unfollow,
  type Hook,
} from "./hooks";

const tabIcon = <GithubLogoIcon size="1rem" />;

const noVersion = () => 0;

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

function Hooks({
  session,
  channel,
  publisher,
  nameOf,
}: {
  session: RelaySession;
  channel: string;
  publisher: PublisherStatus | undefined;
  nameOf: (pubkey: string) => string;
}) {
  const { status, hooks } = useHooks(session, channel);
  useSyncExternalStore(
    publisher?.subscribe ?? noSubscribe,
    publisher?.version ?? noVersion,
  );
  const [repo, setRepo] = useState("");
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState<Hook>();
  const name = repositoryOf(repo);
  const viewer = session.viewer;
  const able = !!viewer && !!publisher;
  // Only a complete, current list can say a repository isn't followed yet.
  const complete = status === "live";
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
  const ready = !!name && able && complete && !duplicate && !busy;
  const whose = (hook: Hook) =>
    hook.publisher === viewer
      ? "Your Buzz"
      : `${nameOf(hook.publisher)}’s Buzz`;
  return (
    <section className={styles.hooks} aria-label="GitHub repositories">
      <Header
        title="GitHub"
        subtitle="Follow a repository to post its pull requests here, with their checks and reviews kept current."
      />
      <form
        aria-label="Follow a repository"
        onSubmit={(event) => {
          event.preventDefault();
          if (!ready) return;
          void run("follow", async () => {
            await follow(session, channel, name);
            setRepo("");
          });
        }}
      >
        <SettingsGroup layout="form">
          <Field
            label="Follow a repository"
            description={
              publisher
                ? "Enter owner/repo or its github.com link. Your Buzz reads it with gh and posts its pull requests as you, while it is open."
                : "Following needs the desktop app, which reads GitHub with your gh sign-in."
            }
            error={
              duplicate
                ? "This channel already follows it."
                : repo.trim() && !name
                  ? "Enter a repository as owner/repo."
                  : name && able && !complete
                    ? "Following waits until this channel’s followed repositories are up to date."
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
          <div className="flex flex-wrap items-center justify-end gap-3">
            <Button type="submit" variant="primary" disabled={!ready}>
              Follow
            </Button>
          </div>
        </SettingsGroup>
      </form>
      {error && (
        <p role="alert" className="m-0 text-body-sm text-danger">
          {error}
        </p>
      )}
      <div className="mt-section-gap">
        <InlineHeader title="Followed repositories" />
        {status === "unsupported" || status === "error" ? (
          <p role="status" className="m-0 text-body-sm text-subtle">
            This community can’t list followed repositories.
          </p>
        ) : status === "restricted" ? (
          <p role="status" className="m-0 text-body-sm text-subtle">
            You can’t read this channel’s followed repositories.
          </p>
        ) : !hooks.length ? (
          <p role="status" className="m-0 text-body-sm text-subtle">
            {status === "live"
              ? "No repositories followed in this channel."
              : "Loading…"}
          </p>
        ) : (
          <>
            {!complete && (
              <p role="status" className="m-0 text-body-sm text-subtle">
                Reconnecting. This list may be out of date.
              </p>
            )}
            <SettingsGroup>
              {hooks.map((hook: Hook) => (
                <PreferenceRow
                  key={hook.d}
                  title={hook.repo}
                  subtitle={
                    !complete
                      ? `Last known publisher: ${hook.publisher === viewer ? "you" : nameOf(hook.publisher)}.`
                      : hook.publisher === viewer
                        ? (publisher?.get(channel, hook.d) ??
                          "Published from your Buzz. Cards update while it is open.")
                        : `Published from ${nameOf(hook.publisher)}’s Buzz. Cards update while it is open.`
                  }
                  trailing={
                    <div className="flex flex-wrap items-center justify-end gap-2">
                      <Button
                        type="button"
                        disabled={!!busy}
                        onClick={() => setConfirming(hook)}
                      >
                        Unfollow
                      </Button>
                    </div>
                  }
                />
              ))}
            </SettingsGroup>
          </>
        )}
      </div>
      {confirming && (
        <AlertDialog
          title={`Unfollow ${confirming.repo}?`}
          description={`${whose(confirming)} stops posting its pull requests here, and their cards turn back into plain links for everyone in this channel.`}
          pending={busy === `unfollow:${confirming.d}`}
          onClose={() => setConfirming(undefined)}
          actions={
            <>
              <Button
                disabled={!!busy}
                onClick={() => setConfirming(undefined)}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                loading={busy === `unfollow:${confirming.d}`}
                onClick={() =>
                  void run(`unfollow:${confirming.d}`, async () => {
                    try {
                      await unfollow(session, channel, confirming);
                    } catch (reason) {
                      if (reason instanceof HookChanged)
                        setConfirming(undefined);
                      throw reason;
                    }
                    setConfirming(undefined);
                  })
                }
              >
                Unfollow
              </Button>
            </>
          }
        />
      )}
    </section>
  );
}

export function GitHubHooks({
  relay,
  channelContext,
  publisher,
  nameOf,
}: {
  relay: RelayData;
  nameOf: (pubkey: string) => string;
  /** This device's publishing, where it can publish. */
  publisher?: PublisherStatus | undefined;
} & Pick<PanelProps, "channelContext">) {
  usePanelTabTitle("GitHub", tabIcon);
  const state = useSyncExternalStore(relay.subscribe, relay.snapshot);
  if (
    !channelContext ||
    state.status !== "ready" ||
    state.scope !== channelContext.scope
  )
    return (
      <p role="status" className={styles.hooks}>
        GitHub repositories are unavailable while the connection recovers.
      </p>
    );
  return (
    <Hooks
      key={`${state.scope}:${state.generation}:${channelContext.channelId}`}
      session={state.session}
      channel={channelContext.channelId}
      publisher={publisher}
      nameOf={nameOf}
    />
  );
}
