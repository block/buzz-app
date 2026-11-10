// What a plugin may change about the app's overall look, and only while it runs.
import { Service, type Context } from "@deepseek-ai/cordis";
import type {} from "../../plugins/api";
import type { Appearance, MessageDensity } from "../../shared/theme/service";

export type PluginAppearance = Readonly<{
  /**
   * Sets `data-plugin-theme` or `data-plugin-theme-<name>` on the document root
   * so CSS can scope itself to the plugin. The value is 1 to 64 characters of
   * lowercase letters, digits, `.`, `_` and `-`. Removed when the plugin stops
   * or the returned function runs; the newest plugin to set a name wins.
   */
  setRootAttribute(name: string, value: string): () => void;
  /**
   * Shows messages at this density instead of the saved choice, which is not
   * changed and returns when the plugin stops or the returned function runs.
   * Settings → Appearance shows the control as set by a plugin meanwhile.
   */
  overrideMessageDensity(value: MessageDensity): () => void;
}>;

declare module "@deepseek-ai/cordis" {
  interface Context {
    /** Read with `ctx.reflect.get("appearance")` for old-host compatibility. */
    appearance?: PluginAppearance;
  }
}

export class PluginAppearanceService
  extends Service
  implements PluginAppearance
{
  constructor(
    ctx: Context,
    private readonly host: Pick<
      Appearance,
      "setRootAttribute" | "overrideDensity"
    >,
  ) {
    super(ctx, "appearance");
  }
  setRootAttribute(name: string, value: string) {
    return this.claim(() => this.host.setRootAttribute(name, value));
  }
  overrideMessageDensity(value: MessageDensity) {
    return this.claim(() => this.host.overrideDensity(value));
  }
  /** Ties a claim to the calling plugin's scope; `apply` throws on a rejected value. */
  private claim(apply: () => () => void) {
    if (!this.ctx.pluginOwner)
      throw new Error("Appearance changes must come from an installed plugin");
    const release = apply();
    const remove = this.ctx.effect(() => release);
    return () => void remove();
  }
}
