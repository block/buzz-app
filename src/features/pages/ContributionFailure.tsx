import { createContext, useContext } from "react";
import { Button } from "../../shared/design-system/ui/Button";
import { ErrorDetails } from "../../shared/ErrorDetails";

/** The external plugin behind a failed page or panel, so the failure can name
 * it and offer its management UI. Built-in contributions pass nothing. */
export type FailedPlugin = Readonly<{
  name: string;
  /** Open this plugin in Settings → Plugins. */
  manage(): void;
}>;

/** The external plugin with this ID, or undefined for a built-in one. */
export type PluginOwners = (pluginId: string) => FailedPlugin | undefined;

const Owners = createContext<PluginOwners | undefined>(undefined);
/** Given by the app to the whole shell (pages, launcher companions), so a
 * panel's caller can name the panel's plugin when it fails. */
export const PluginOwnersProvider = Owners.Provider;
/** Resolves contributions' plugins; undefined without a provider, where every
 * failure reads as built-in. */
export const usePluginOwners = () => useContext(Owners);

/** What a page or panel shows in place of itself after it threw while
 * rendering. The raw exception text stays behind a collapsed "Details". */
export function ContributionFailure({
  kind,
  plugin,
  details,
  onRetry,
}: {
  kind: "page" | "panel";
  plugin?: FailedPlugin | undefined;
  details?: string | undefined;
  onRetry(): void;
}) {
  const Title = kind === "page" ? "h2" : "h3";
  return (
    <div role="alert" className="notice">
      <Title>This {kind} couldn’t open</Title>
      <p>
        {plugin
          ? `${plugin.name} had a problem showing it.`
          : `Something went wrong showing this ${kind}.`}
      </p>
      {!plugin && <p>If it keeps happening, restart Buzz.</p>}
      {/* Secondary first, primary last, as in dialog footers and forms. */}
      <div className="flex flex-wrap gap-2">
        {plugin && (
          <Button type="button" onClick={plugin.manage}>
            Manage plugin
          </Button>
        )}
        <Button type="button" variant="primary" onClick={onRetry}>
          Try again
        </Button>
      </div>
      <ErrorDetails {...(details ? { details } : {})} />
    </div>
  );
}
