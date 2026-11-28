// FOUNDATION: Page contribution contract, shared by bundled and external plugins.
import { Service, type Context } from "@deepseek-ai/cordis";
import type { ComponentType, ReactNode } from "react";
import {
  createContributions,
  type Contribution,
} from "../../plugins/contributions.ts";
import { isBundledOwner } from "../../plugins/provenance";

export type PageProps = {
  companion?: ReactNode | undefined;
  /** Opaque identity for the current shell-owned companion opening. */
  companionOpening?: object | undefined;
  navigation?: import("../navigation/service").PageNavigation | undefined;
};

/** Props for a page-owned replacement in the shell's sidebar slot. */
export type PageSidebarProps = {
  target: import("../navigation/targets").OpenTarget;
  /** Shell-generated primary Pages navigation, when available. */
  children?: ReactNode | undefined;
};

/** Props for a primary page's navigation hover preview. */
export type PagePreviewProps = {
  /** Close the preview, for example after its content opened something. */
  close(): void;
};

export type Page = Readonly<{
  id: string;
  title: string;
  component: ComponentType<PageProps>;
  /** Replace the conversation sidebar while this page is selected. */
  sidebar?: ComponentType<PageSidebarProps>;
  /** Keep the Messages sidebar and dock selection while this page is open. */
  conversationNavigation?: boolean;
  layout?: "document" | "workspace";
  // Opt in only when every page state places the supplied companion card.
  companion?: boolean;
  /** Opt in to versioned page routes. Validation is synchronous and side-effect-free. */
  route?: Readonly<{
    version: number;
    validate(params: import("../navigation/targets").JsonValue): boolean;
  }>;
  /** This page acknowledges its own domain reveal rather than just successful mounting. */
  handlesNavigation?: boolean;
  /**
   * Opt in to the shell's page navigation. Every active page stays
   * listed in search and reachable by deep link or from another page.
   */
  primary?: boolean;
  /** Preferred navigation location for a primary page: a row in the Messages
   * sidebar (the default) or an app in the dock. `topbar` and `toolbar` are
   * pre-dock aliases for `dock`, still accepted.
   */
  placement?: "sidebar" | "dock" | "topbar" | "toolbar";
  /**
   * A `data:image/<subtype>[;params],<payload>` URL shown beside the page in
   * search and primary navigation. Any other value is dropped with a warning,
   * and a missing or unloadable image shows the generic page icon. Bundled
   * pages keep their host icons.
   */
  icon?: string;
  /** Plugin-owned navigation count or mark. Toolbar icons constrain this to a
   * compact corner badge; prefer a short count or dot there.
   */
  badge?: ComponentType;
  /**
   * Supplemental content the shell shows while a pointer rests on this page's
   * sidebar or app-dock entry. It is never shown without hover or while the
   * page is selected, so the page must stay complete without it.
   */
  preview?: ComponentType<PagePreviewProps>;
}>;
export type RegisteredPage = Contribution<Page>;
export type PagesReader = {
  snapshot: () => readonly RegisteredPage[];
  subscribe: (listener: () => void) => () => void;
};
/** A bundled plugin's component the app shell mounts once while the plugin
 * is on, such as a notice or a dialog, which places itself. The design
 * system's toasts and dialogs work in it. */
export type AppOverlay = Readonly<{ id: string; component: ComponentType }>;
export type RegisteredOverlay = Contribution<AppOverlay>;
/** Props for a plugin's quick view body. */
export type QuickViewProps = {
  /** Close the quick view, for example after its content opened something. */
  close(): void;
};
/** A plugin's body for a host-drawn command palette style dialog. The host owns
 * the frame, focus, Escape and outside clicks; the plugin owns only the body. */
export type QuickView = Readonly<{
  id: string;
  /** The dialog's accessible name. The palette shows no visible header. */
  title: string;
  component: ComponentType<QuickViewProps>;
}>;
export type RegisteredQuickView = Contribution<QuickView>;
export type Pages = PagesReader & {
  register(page: Page): void;
  registerQuickView(view: QuickView): void;
  /** Open one of the calling plugin's own quick views, replacing any other. */
  openQuickView(id: string): void;
  readonly quickViews: Readonly<{
    snapshot: () => readonly RegisteredQuickView[];
    subscribe: (listener: () => void) => () => void;
    /** The open quick view, if it is still registered and active. */
    open: () => RegisteredQuickView | undefined;
    close: () => void;
  }>;
  /** Bundled plugins only. */
  registerOverlay(overlay: AppOverlay): void;
  readonly overlays: Readonly<{
    snapshot: () => readonly RegisteredOverlay[];
    subscribe: (listener: () => void) => () => void;
  }>;
};
declare module "@deepseek-ai/cordis" {
  interface Context {
    pages: Pages;
  }
}

const dataImageUrl = /^data:image\/[\w.+-]+(?:;[^,]*)?,/i;

export class PagesService extends Service implements Pages {
  private readonly contributions;
  private readonly overlayContributions;
  private readonly quickViewContributions;
  // Held in one object: plugins call through scoped views of this service.
  private readonly quickViewState: {
    key: string | undefined;
    readonly listeners: Set<() => void>;
  } = { key: undefined, listeners: new Set() };
  constructor(ctx: Context) {
    super(ctx, "pages");
    this.contributions = createContributions<Page>(ctx);
    this.overlayContributions = createContributions<AppOverlay>(ctx);
    this.quickViewContributions = createContributions<QuickView>(ctx);
    // Read-only: registering goes through `registerOverlay`'s check.
    const { snapshot, subscribe } = this.overlayContributions;
    this.overlays = Object.freeze({ snapshot, subscribe });
    const quickViews = this.quickViewContributions;
    const openEntry = () =>
      this.quickViewState.key === undefined
        ? undefined
        : quickViews
            .snapshot()
            .find((entry) => entry.key === this.quickViewState.key);
    // A quick view whose plugin stops closes, and doesn't reopen on restart.
    ctx.effect(() =>
      quickViews.subscribe(() => {
        if (this.quickViewState.key !== undefined && !openEntry())
          this.setOpenQuickView(undefined);
      }),
    );
    this.quickViews = Object.freeze({
      snapshot: quickViews.snapshot,
      subscribe: (listener: () => void) => {
        const stop = quickViews.subscribe(listener);
        this.quickViewState.listeners.add(listener);
        return () => {
          stop();
          this.quickViewState.listeners.delete(listener);
        };
      },
      open: openEntry,
      close: () => this.setOpenQuickView(undefined),
    });
  }
  readonly overlays;
  readonly quickViews;
  private setOpenQuickView(key: string | undefined) {
    if (key === this.quickViewState.key) return;
    this.quickViewState.key = key;
    for (const listener of this.quickViewState.listeners) listener();
  }
  registerQuickView(view: QuickView) {
    if (
      !view ||
      typeof view.id !== "string" ||
      !/^[a-z0-9][a-z0-9._-]*$/.test(view.id) ||
      typeof view.title !== "string" ||
      !view.title.trim() ||
      typeof view.component !== "function"
    )
      throw new Error(
        "A quick view needs an id, a title, and a React component function",
      );
    this.quickViewContributions.register(this.ctx, view);
  }
  openQuickView(id: string) {
    const owner = this.ctx.pluginOwner;
    if (!owner) throw new Error("Only a plugin can open its quick views");
    const key = `${owner.id}/${id}`;
    if (!this.quickViewContributions.snapshot().some((e) => e.key === key))
      throw new Error(`No active quick view ${key}`);
    this.setOpenQuickView(key);
  }
  registerOverlay(overlay: AppOverlay) {
    if (!this.ctx.pluginOwner || !isBundledOwner(this.ctx.pluginOwner))
      throw new Error("App overlays are available only to bundled plugins");
    if (
      !overlay ||
      typeof overlay.id !== "string" ||
      !/^[a-z0-9][a-z0-9._-]*$/.test(overlay.id) ||
      typeof overlay.component !== "function"
    )
      throw new Error("An app overlay needs an id and a React component");
    this.overlayContributions.register(this.ctx, overlay);
  }
  snapshot = () => this.contributions.snapshot();
  subscribe = (listener: () => void) => this.contributions.subscribe(listener);
  register(page: Page) {
    if (
      !page ||
      typeof page.id !== "string" ||
      !/^[a-z0-9][a-z0-9._-]*$/.test(page.id) ||
      typeof page.title !== "string" ||
      !page.title.trim() ||
      typeof page.component !== "function" ||
      (page.sidebar !== undefined && typeof page.sidebar !== "function") ||
      (page.conversationNavigation !== undefined &&
        typeof page.conversationNavigation !== "boolean") ||
      (page.layout !== undefined &&
        page.layout !== "document" &&
        page.layout !== "workspace") ||
      (page.companion !== undefined && typeof page.companion !== "boolean") ||
      (page.primary !== undefined && typeof page.primary !== "boolean") ||
      (page.badge !== undefined && typeof page.badge !== "function") ||
      (page.preview !== undefined && typeof page.preview !== "function")
    ) {
      throw new Error(
        "A page needs an id, a title, and a React component function",
      );
    }
    if (
      page.route &&
      (!Number.isSafeInteger(page.route.version) ||
        page.route.version < 1 ||
        typeof page.route.validate !== "function")
    )
      throw new Error("Invalid page route contract");
    this.contributions.register(
      this.ctx,
      this.withAcceptedPlacement(this.withAcceptedIcon(page)),
    );
  }
  private withAcceptedPlacement(page: Page): Page {
    const { placement, ...rest } = page;
    if (
      placement === undefined ||
      placement === "sidebar" ||
      placement === "dock" ||
      placement === "topbar" ||
      placement === "toolbar"
    )
      return page;
    console.warn(
      `Ignoring page placement for ${this.ctx.pluginOwner?.id}/${page.id}: expected sidebar or dock`,
    );
    return rest;
  }
  // A rejected icon is decoration, so it must not fail plugin activation.
  private withAcceptedIcon(page: Page): Page {
    const { icon, ...rest } = page;
    if (
      icon === undefined ||
      (typeof icon === "string" && dataImageUrl.test(icon))
    )
      return page;
    console.warn(
      `Ignoring page icon for ${this.ctx.pluginOwner?.id}/${page.id}: expected a data:image/ URL`,
    );
    return rest;
  }
}
