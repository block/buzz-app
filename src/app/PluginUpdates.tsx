import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { PluginManager } from "../plugins/manager";
import { pendingManaged } from "../plugins/managed";
import { canRetryPlugin } from "../plugins/manager";
import type { PluginInstallRequests } from "../plugins/installer";
import {
  createPluginUpdates,
  type PluginUpdate,
  type PluginUpdates as Updates,
  pluginUpdateSource,
  updateFailure,
  updateSourceKey,
} from "../plugins/updates";
import type { AppServices } from "./services";
import { Button } from "../shared/design-system/ui/Button";
import { ToastNotice } from "../shared/design-system/ui/Toast";
import {
  MenuItem,
  MenuSubmenu,
  MenuSubmenuTrigger,
  MenuSubmenuPopup,
  MenuIcon,
  MenuSeparator,
  MenuTrailing,
} from "../shared/design-system/ui/Menu";
import { SquaresFourIcon } from "../shared/design-system/icons";
import { RecommendationCount } from "./RecommendationCount";
import { PluginImport } from "./PluginImport";
import { pluginAccessIncreases } from "./PluginAccessReview";
import { PluginMenu } from "./PluginMenu";

const Context = createContext<{
  updates: readonly PluginUpdate[];
  recommended: readonly string[];
  busy: boolean;
  open(update: PluginUpdate): void;
  /** Plugins the owner asked to check again, while that check runs. */
  checking: readonly string[];
  checkAgain(id: string): Promise<void>;
} | null>(null);
const noSubscribe = () => () => {};
const empty: readonly PluginUpdate[] = [];
const noUpdates = () => empty;

export function PluginUpdates({
  plugins,
  relay,
  installRequests,
  navigation,
  children,
}: {
  plugins: PluginManager;
  relay: AppServices["relay"];
  installRequests: PluginInstallRequests;
  navigation: Pick<AppServices["navigation"], "open">;
  children: ReactNode;
}) {
  const [store, setStore] = useState<Updates>();
  const [action, setAction] = useState<PluginUpdate>();
  const returnFocus = useRef<HTMLElement | null>(null);
  const state = useSyncExternalStore(plugins.subscribe, plugins.snapshot);
  const updates = useSyncExternalStore(
    store?.subscribe ?? noSubscribe,
    store?.snapshot ?? noUpdates,
  );
  const authorizeGit = async (repository: string) =>
    (await relay.snapshot().session.authorizeGit?.(repository)) ?? null;
  useEffect(() => {
    const updates = createPluginUpdates(
      plugins,
      async (repository) =>
        (await relay.snapshot().session.authorizeGit?.(repository)) ?? null,
    );
    setStore(updates);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    // Being offline is normal, so background checks wait for a connection.
    const ready = () =>
      document.visibilityState !== "hidden" && navigator.onLine !== false;
    const check = async () => {
      clearTimeout(timer);
      if (!ready()) return;
      const delay = await updates.check();
      if (delay === undefined || disposed || !ready()) return;
      clearTimeout(timer);
      timer = setTimeout(check, delay);
    };
    void check();
    const unsubscribe = plugins.subscribe(check);
    document.addEventListener("visibilitychange", check);
    window.addEventListener("online", check);
    return () => {
      disposed = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", check);
      window.removeEventListener("online", check);
      unsubscribe();
      updates.dispose();
    };
  }, [plugins, relay]);
  const configuration = state.configuration;
  const catalog =
    configuration.status === "ready" ? configuration.catalog : undefined;
  const open = (update: PluginUpdate) => {
    if (state.busy || action) return;
    returnFocus.current = document.activeElement as HTMLElement;
    setAction(update);
  };
  const installed =
    action && catalog?.plugins.find((p) => p.manifest.id === action.id);
  const source = action && pluginUpdateSource(plugins, action.id);
  const validAction =
    action &&
    installed &&
    source &&
    installed.revision === action.installedRevision &&
    updateSourceKey(source) === updateSourceKey(action.source);
  useEffect(() => {
    if (action && !validAction && !state.busy) setAction(undefined);
  }, [action, validAction, state.busy]);
  const needsReview = (update: PluginUpdate) => {
    const previous = catalog?.plugins.find((p) => p.manifest.id === update.id);
    return (
      !previous ||
      !update.candidate ||
      pluginAccessIncreases(update.candidate.manifest, previous.manifest) ||
      (update.candidate.publisher ?? null) !== (previous.publisher ?? null)
    );
  };
  const [recovering, setRecovering] = useState<readonly string[]>([]);
  const [checking, setChecking] = useState<readonly string[]>([]);
  const checkAgain = async (id: string) => {
    if (!store) return;
    setChecking((ids) => (ids.includes(id) ? ids : [...ids, id]));
    try {
      await store.checkAgain(id);
    } finally {
      setChecking((ids) => ids.filter((item) => item !== id));
    }
  };
  return (
    <Context
      value={{
        updates,
        open,
        checking,
        checkAgain,
        busy: state.busy || !!action,
        recommended: pendingManaged(
          configuration.status === "ready" ? configuration.managed : undefined,
        ).map((entry) => entry.id),
      }}
    >
      {children}
      {updates
        .filter(
          (update) =>
            // A background check's failure stays on its Settings row.
            (update.candidate || update.manual) &&
            !store?.hidden(update) &&
            update.id !== action?.id,
        )
        .map((update) => {
          const plugin = catalog?.plugins.find(
            (p) => p.manifest.id === update.id,
          );
          const name = plugin?.manifest.name ?? update.id;
          const manage = {
            label: `Manage ${name} update checks`,
            open: () =>
              void navigation.open({
                version: 1,
                kind: "settings",
                section: "plugins",
                pluginId: update.id,
              }),
          };
          if (update.error) {
            const { cause, retry } = updateFailure(update);
            return (
              <ToastNotice
                key={update.id}
                title={`Couldn’t check ${name} for updates`}
                description={cause ?? "Check your connection, then try again."}
                tone="error"
                onDismiss={() => store?.later(update)}
                closeLabel="Dismiss plugin update notice"
                navigation={manage}
              >
                {retry && (
                  <Button
                    size="sm"
                    loading={checking.includes(update.id)}
                    onClick={() => void checkAgain(update.id)}
                  >
                    Try again
                  </Button>
                )}
              </ToastNotice>
            );
          }
          const review = needsReview(update);
          return (
            <ToastNotice
              key={update.id}
              title={`Update ${name}`}
              description="Save unfinished forms and stop active plugin workers first. Updating an enabled plugin reloads it immediately."
              tone="info"
              onDismiss={() => store?.later(update)}
              closeLabel="Dismiss plugin update notice"
              navigation={manage}
            >
              <Button
                size="sm"
                disabled={state.busy || !!action}
                onClick={() => open(update)}
              >
                {review ? "Review permissions" : "Update and reload"}
              </Button>
              <Button size="sm" onClick={() => store?.later(update)}>
                Later
              </Button>
            </ToastNotice>
          );
        })}
      {validAction && catalog && (
        <PluginImport
          key={`${action.id}:${updateSourceKey(action.source)}`}
          plugins={plugins}
          catalog={catalog}
          busy={state.busy}
          updateId={action.id}
          updateAction={{ source: action.source, apply: !needsReview(action) }}
          reviewRequested
          authorizeGit={authorizeGit}
          holdReview={installRequests.holdReview}
          returnFocus={() => returnFocus.current}
          onClosed={() => {
            setRecovering((ids) =>
              ids.includes(action.id) ? ids : [...ids, action.id],
            );
            setAction(undefined);
          }}
        />
      )}
      {catalog?.plugins
        .filter((plugin) => recovering.includes(plugin.manifest.id))
        .map((recovery) => {
          const activation = state.activation[recovery.manifest.id];
          return activation?.status === "failed" ? (
            <ToastNotice
              key={recovery.manifest.id}
              title={`${recovery.manifest.name} cannot start`}
              description={`${activation.error}${recovery.rollbackBlockedReason ? ` ${recovery.rollbackBlockedReason}` : ""}`}
              tone="error"
            >
              <Button
                size="sm"
                disabled={
                  state.busy ||
                  !canRetryPlugin(
                    recovery,
                    activation,
                    configuration.status === "ready" &&
                      configuration.externalPluginsPaused,
                  )
                }
                onClick={() => plugins.retryPlugin(recovery.manifest.id)}
              >
                Retry activation
              </Button>
              <PluginMenu
                plugin={recovery}
                plugins={plugins}
                busy={state.busy}
                label="Plugin recovery actions"
              />
            </ToastNotice>
          ) : null;
        })}
    </Context>
  );
}

export function PluginUpdatesMenu({
  onManage,
  recommendations,
}: {
  onManage(): void;
  recommendations: number;
}) {
  const context = useContext(Context);
  // A failed check is reported on its plugin's row in Manage plugins.
  const updates = (context?.updates ?? empty).filter(
    (update) => update.candidate,
  );
  const count =
    recommendations +
    updates.filter((update) => !context?.recommended.includes(update.id))
      .length;
  const label = (
    <>
      <MenuIcon>
        <SquaresFourIcon aria-hidden="true" size={16} />
      </MenuIcon>
      Plugins
      {count > 0 && (
        <MenuTrailing>
          <RecommendationCount count={count} />
        </MenuTrailing>
      )}
    </>
  );
  if (!updates.length) return <MenuItem onClick={onManage}>{label}</MenuItem>;
  return (
    <MenuSubmenu>
      <MenuSubmenuTrigger>{label}</MenuSubmenuTrigger>
      <MenuSubmenuPopup>
        {updates.map((update) => (
          <MenuItem
            key={update.id}
            disabled={context?.busy}
            onClick={() => context?.open(update)}
          >
            Update {update.candidate?.manifest.name ?? update.id}
          </MenuItem>
        ))}
        <MenuSeparator />
        <MenuItem onClick={onManage}>Manage plugins</MenuItem>
      </MenuSubmenuPopup>
    </MenuSubmenu>
  );
}

/** A background check's failure, on its plugin's row in Settings → Plugins:
 * what happened, Check again when that can help, and Git's text behind
 * Details. Nothing shows outside `PluginUpdates`. */
export function PluginUpdateFailure({
  pluginId,
  className,
  returnFocus,
}: {
  pluginId: string;
  className?: string | undefined;
  /** Where focus goes when a successful check removes Check again. */
  returnFocus?: () => HTMLElement | null | undefined;
}) {
  const context = useContext(Context);
  const update = context?.updates.find(
    (item) => item.id === pluginId && item.error,
  );
  if (!context || !update?.error) return null;
  const { cause, retry } = updateFailure(update);
  return (
    <div className={className}>
      <div className="flex flex-wrap items-center gap-2">
        <p className="m-0 text-body-sm error">
          Couldn’t check for updates.{cause ? ` ${cause}` : ""}
        </p>
        {retry && (
          <Button
            size="sm"
            variant="subtle"
            loading={context.checking.includes(pluginId)}
            onClick={async (event) => {
              const button = event.currentTarget;
              await context.checkAgain(pluginId);
              const active = document.activeElement;
              if (!button.isConnected && (!active || active === document.body))
                returnFocus?.()?.focus();
            }}
          >
            Check again
          </Button>
        )}
      </div>
      {update.error !== cause && (
        <details>
          <summary className="text-body-sm">Details</summary>
          <p className="m-0 text-body-sm text-subtle">{update.error}</p>
        </details>
      )}
    </div>
  );
}
