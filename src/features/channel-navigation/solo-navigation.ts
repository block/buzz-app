import { Service, type Context } from "@deepseek-ai/cordis";
import {
  createContributions,
  type Contribution,
} from "../../plugins/contributions";
import { readView, subscribeView, writeView } from "../../shared/view-state";
import type { RelayData } from "../relay/service";
import type { RelaySession } from "../relay/session";
import type {
  SoloEnhancement,
  SoloNavigation,
  SoloTaskRow,
  SoloViewOptions,
} from "./solo-navigation-contract";
import {
  acceptSoloRows,
  soloForest,
  soloViewOptions,
  SOLO_VIEW_DEFAULTS,
  type SoloForest,
} from "./solo-navigation-model";

export type SoloNavigationSnapshot = Readonly<{
  enhancement: Contribution<SoloEnhancement>;
  dataRevision: number;
  forest: SoloForest;
  options: SoloViewOptions;
  notice?: string | undefined;
}>;
export type SoloNavigationReader = {
  snapshot(): SoloNavigationSnapshot | undefined;
  subscribe(listener: () => void): () => void;
  setOptions(options: SoloViewOptions): void;
  create(): Promise<void>;
};
const readers = new WeakMap<RelaySession, SoloNavigationReader>();
export const soloNavigationFor = (session: RelaySession) =>
  readers.get(session);

/** Runs with the relay, including when the sidebar is absent. One accepted
 * metadata snapshot supplies rendering and every workspace assignment control. */
export class SoloNavigationService
  extends Service
  implements SoloNavigation, SoloNavigationReader
{
  readonly version = 1 as const;
  private readonly contributions;
  private readonly listeners = new Set<() => void>();
  private value: SoloNavigationSnapshot | undefined;
  private binding: { scope: string; viewer: string } | undefined;
  private session: RelaySession | undefined;
  private winner: Contribution<SoloEnhancement> | undefined;
  private sourceRevision: number | undefined;
  private rows: readonly SoloTaskRow[] | undefined;
  private options: SoloViewOptions = SOLO_VIEW_DEFAULTS;
  private notice: string | undefined;
  private stopSource: (() => void) | undefined;
  private stopSession: (() => void) | undefined;
  private stopView: (() => void) | undefined;
  constructor(
    ctx: Context,
    private readonly relay: RelayData,
  ) {
    super(ctx, "soloNavigation");
    this.contributions = createContributions<SoloEnhancement>(ctx);
    ctx.effect(() => this.contributions.subscribe(this.refresh));
    ctx.effect(() => relay.subscribe(this.bind));
    ctx.effect(() => {
      this.bind();
      return () => {
        this.stopSource?.();
        this.stopSession?.();
        this.stopView?.();
        if (this.session) readers.delete(this.session);
      };
    });
  }
  register(enhancement: SoloEnhancement) {
    if (
      !enhancement ||
      !/^[a-z0-9][a-z0-9._-]*$/.test(enhancement.id) ||
      !this.bounded(enhancement.title, 40) ||
      !this.bounded(enhancement.childNoun?.one, 24) ||
      !this.bounded(enhancement.childNoun?.other, 24) ||
      typeof enhancement.read !== "function" ||
      typeof enhancement.dataRevision !== "function" ||
      typeof enhancement.subscribe !== "function" ||
      (enhancement.create &&
        (!this.bounded(enhancement.create.label, 40) ||
          typeof enhancement.create.run !== "function"))
    )
      throw new Error("Invalid Solo navigation enhancement");
    this.contributions.register(this.ctx, enhancement);
  }
  private bounded(value: unknown, limit: number) {
    return typeof value === "string" && !!value.trim() && value.length <= limit;
  }
  snapshot = () => this.value;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish() {
    for (const listener of this.listeners) listener();
  }
  private bind = () => {
    const connection = this.relay.snapshot();
    if (
      connection.session !== this.session ||
      connection.scope !== this.binding?.scope ||
      connection.viewer !== this.binding?.viewer
    ) {
      this.stopSession?.();
      this.stopView?.();
      if (this.session) readers.delete(this.session);
      this.session = connection.session;
      readers.set(connection.session, this);
      this.binding =
        connection.scope && connection.viewer
          ? { scope: connection.scope, viewer: connection.viewer }
          : undefined;
      this.sourceRevision = undefined;
      this.rows = undefined;
      this.notice = undefined;
      this.stopSession = connection.session.channels.subscribeList(
        this.refresh,
      );
      this.stopView =
        this.binding && typeof window !== "undefined"
          ? subscribeView(this.binding.scope, () => {
              this.readOptions();
              this.refresh();
            })
          : undefined;
      this.readOptions();
    }
    this.refresh();
  };
  private readOptions() {
    this.options =
      this.binding && this.winner
        ? soloViewOptions(
            readView(this.binding.scope, `solo-view:${this.winner.key}`, null),
          )
        : SOLO_VIEW_DEFAULTS;
  }
  private refresh = () => {
    const order = (entry: SoloEnhancement) =>
      typeof entry.order === "number" && Number.isFinite(entry.order)
        ? entry.order
        : 0;
    const winner = [...this.contributions.snapshot()].sort(
      (a, b) => order(a) - order(b) || a.key.localeCompare(b.key),
    )[0];
    if (winner !== this.winner) {
      this.stopSource?.();
      this.stopSource = undefined;
      this.winner = winner;
      this.sourceRevision = undefined;
      this.rows = undefined;
      this.notice = undefined;
      this.readOptions();
      try {
        this.stopSource = winner?.subscribe(this.refresh);
      } catch {
        this.rows = undefined;
      }
    }
    let next: SoloNavigationSnapshot | undefined;
    if (winner && this.binding && this.session)
      try {
        const revision = winner.dataRevision();
        if (!Number.isSafeInteger(revision) || revision < 0)
          throw new Error("Invalid Solo revision");
        if (revision !== this.sourceRevision) {
          this.sourceRevision = revision;
          this.rows = undefined;
          this.rows = acceptSoloRows(winner.read(this.binding).rows);
        }
        if (this.rows)
          next = {
            enhancement: winner,
            dataRevision: revision,
            forest: soloForest(
              this.rows,
              this.session.channels.list().channels,
              this.binding.viewer,
            ),
            options: this.options,
            notice: this.notice,
          };
      } catch {
        /* A rejected snapshot restores the complete ordinary inventory. */
      }
    this.value = next;
    this.publish();
  };
  setOptions = (options: SoloViewOptions) => {
    this.options = soloViewOptions(options);
    if (
      this.binding &&
      this.winner &&
      !writeView(
        this.binding.scope,
        `solo-view:${this.winner.key}`,
        this.options,
      )
    )
      this.notice = "View changed for this window. It could not be saved.";
    this.refresh();
  };
  create = async () => {
    this.refresh();
    const value = this.value;
    const binding = this.binding;
    if (!value || !binding || !value.enhancement.create) return;
    try {
      await value.enhancement.create.run(binding);
    } catch {
      if (this.binding === binding && this.winner === value.enhancement) {
        this.notice = "The task could not open. Try again.";
        this.refresh();
      }
    }
  };
}

/** Read immediately before each write, including dialog submission. */
export function soloMovePolicy(session: RelaySession, id: string) {
  const forest = soloNavigationFor(session)?.snapshot()?.forest;
  const root = forest?.roots.get(id);
  return root && root !== id
    ? {
        root,
        title:
          session.channels
            .list()
            .channels.find((channel) => channel.id === root)?.name ?? root,
      }
    : undefined;
}
export function prepareSoloMove(session: RelaySession, id: string) {
  const follows = soloMovePolicy(session, id);
  if (follows) return `Workspace follows ${follows.title}`;
  const reader = soloNavigationFor(session);
  const snapshot = reader?.snapshot();
  if (snapshot && snapshot.options.group !== "workspace")
    reader?.setOptions({ ...snapshot.options, group: "workspace" });
  return undefined;
}
