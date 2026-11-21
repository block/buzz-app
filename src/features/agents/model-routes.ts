// Model routes: choices such as "Auto Balanced" that a bundled plugin adds to
// a harness's Model menu (`Agents.registerModelRouter`). An agent saves a
// route as its model, `route:<id>`. Each turn it starts while idle in that
// conversation asks the plugin's router which of the harness's own models and
// effort levels to run it on; a message that steers a running turn keeps that
// turn's choice, so the session's prompt cache stays warm. The choice reaches
// the harness as the turn's model and effort picks (`Delivery.model`,
// `Delivery.effort`), as a per-message pick does: no harness ever runs a
// route id, and launches its process on its own default (`launchModel`).
//
// - `routes(harness)` lists a harness's routes, the one new agents start on
//   (`initial`), the one agents on Automatic use (`automatic`), and whether
//   the menu shows only routes (`exclusive`).
// - `select(request)` answers with one of `request.models` and, optionally,
//   one of its efforts. A failure, a late answer or a model the harness
//   doesn't list runs the route's `fallback`, else the harness's default.
// - An owner's explicit model pick for a message wins over the route.
// - A saved route whose plugin is off runs on the harness's default.
import { useEffect, useRef, useSyncExternalStore } from "react";
import type { Model, Models } from "./service";

export const ROUTE_PREFIX = "route:";
/** The longest a turn waits for a router before it runs the fallback. */
export const ROUTE_TIMEOUT_MS = 30_000;

/** The model value an agent saves for route `id`. */
export const routeModel = (id: string) => `${ROUTE_PREFIX}${id}`;
/** The route id a saved model names, if it names one. */
export function routeOf(model: string | undefined) {
  const value = model?.trim();
  return value?.startsWith(ROUTE_PREFIX)
    ? value.slice(ROUTE_PREFIX.length) || undefined
    : undefined;
}
/** The model a harness starts its process on: each turn on a route runs
 * on its own pick, so the process starts on the harness's default. */
export const launchModel = (model: string) => (routeOf(model) ? "" : model);

export type ModelRoute = Readonly<{
  /** Lowercase letters, digits, `.`, `_` and `-`. */
  id: string;
  /** The menu's name for it, e.g. `Auto Balanced`. */
  label: string;
  /** A short line under the label, e.g. the models it chooses between. */
  description?: string;
  /** What a turn runs on when the router can't answer. */
  fallback?: Readonly<{ model: string; effort?: string }>;
}>;
export type HarnessRoutes = Readonly<{
  routes: readonly ModelRoute[];
  /** The route new agents of the harness start on. */
  initial?: string;
  /** The route agents on Automatic use, with the recommended model as the
   * fallback. */
  automatic?: string;
  /** The Model menu offers only routes (and an agent's current model). */
  exclusive?: boolean;
}>;
export type RouteMessage = Readonly<{
  pubkey: string;
  content: string;
  /** Unix seconds. */
  createdAt: number;
}>;
export type ModelRouteRequest = Readonly<{
  /** The agent type's id, e.g. `claude-code` or `codex`. */
  harness: string;
  route: string;
  agent: Readonly<{ pubkey: string; name: string }>;
  /** The text of the message or wake that starts the turn. */
  prompt: string;
  /** Earlier messages in the turn's thread, oldest first; read only when
   * asked, at most once. Empty outside a thread. */
  history(): Promise<readonly RouteMessage[]>;
  /** The harness's own models for the agent, each with its effort levels. */
  models: readonly Model[];
  signal: AbortSignal;
}>;
export type ModelRouteChoice = Readonly<{
  model: string;
  effort?: string;
  rationale?: string;
}>;
export type ModelRouter = Readonly<{
  id: string;
  routes(harness: string): HarnessRoutes | undefined;
  /** Tells `listener` when `routes` may answer differently. */
  subscribe?(listener: () => void): () => void;
  select(request: ModelRouteRequest): Promise<ModelRouteChoice | undefined>;
}>;

const ROUTE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const EMPTY: HarnessRoutes = Object.freeze({ routes: Object.freeze([]) });

// The active routers, kept here so every model menu can read them without a
// service in its props, as `recommended.ts` keeps this launch's setup.
let routers: readonly ModelRouter[] = [];
let stops: (() => void)[] = [];
let cache = new Map<
  string,
  Readonly<{ routes: HarnessRoutes; owners: ReadonlyMap<string, ModelRouter> }>
>();
const listeners = new Set<() => void>();
const changed = () => {
  cache = new Map();
  for (const listener of listeners) listener();
};

/** Replaces the active routers (AgentsService, as plugins start and stop). */
export function setModelRouters(next: readonly ModelRouter[]) {
  for (const stop of stops) stop();
  routers = next;
  stops = next.flatMap((router) => {
    try {
      return router.subscribe ? [router.subscribe(changed)] : [];
    } catch (error) {
      console.warn(`Model router ${router.id} could not subscribe`, error);
      return [];
    }
  });
  changed();
}

/** The routes for `harness`, checked: the first router to offer a route id
 * keeps it. The same object until the routers change. */
export function routesFor(harness: string): HarnessRoutes {
  return resolved(harness).routes;
}
function resolved(harness: string) {
  const cached = cache.get(harness);
  if (cached) return cached;
  const routes: ModelRoute[] = [];
  const owners = new Map<string, ModelRouter>();
  let initial: string | undefined;
  let automatic: string | undefined;
  let exclusive = false;
  for (const router of routers) {
    let offered: HarnessRoutes | undefined;
    try {
      offered = router.routes(harness);
    } catch (error) {
      console.warn(`Model router ${router.id} could not list routes`, error);
    }
    for (const route of offered?.routes ?? []) {
      if (
        !ROUTE_ID.test(route?.id ?? "") ||
        typeof route.label !== "string" ||
        !route.label.trim() ||
        owners.has(route.id)
      )
        continue;
      owners.set(route.id, router);
      routes.push(
        Object.freeze({
          id: route.id,
          label: route.label.trim(),
          ...(route.description?.trim() && {
            description: route.description.trim(),
          }),
          ...(route.fallback?.model && {
            fallback: Object.freeze({ ...route.fallback }),
          }),
        }),
      );
    }
    const mine = (id: string | undefined) =>
      id && owners.get(id) === router ? id : undefined;
    initial ??= mine(offered?.initial);
    automatic ??= mine(offered?.automatic);
    exclusive ||= routes.length > 0 && offered?.exclusive === true;
  }
  const result: HarnessRoutes = routes.length
    ? Object.freeze({
        routes: Object.freeze(routes),
        ...(initial && { initial }),
        ...(automatic && { automatic }),
        ...(exclusive && { exclusive }),
      })
    : EMPTY;
  const entry = Object.freeze({ routes: result, owners });
  cache.set(harness, entry);
  return entry;
}
export function subscribeRoutes(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
/** The routes for `harness`, rendering again when they change. */
export function useModelRoutes(harness: string) {
  return useSyncExternalStore(
    subscribeRoutes,
    () => routesFor(harness),
    () => routesFor(harness),
  );
}
/** The model a new agent of `harness` starts on: its initial route, or "". */
export const initialModel = (harness: string) => {
  const { initial } = routesFor(harness);
  return initial ? routeModel(initial) : "";
};
/** Starts a new agent's blank model on the harness's initial route, once:
 * a later choice of Default stays. `active` is false for an existing agent
 * or one on Automatic. */
export function useInitialRoute(
  harness: string,
  active: boolean,
  model: string,
  apply: (model: string) => void,
) {
  const { initial } = useModelRoutes(harness);
  const done = useRef(false);
  useEffect(() => {
    if (done.current || !active || !initial) return;
    done.current = true;
    if (!model.trim()) apply(routeModel(initial));
  }, [active, apply, initial, model]);
}
/** The route a saved model names, while a router offers it. */
export const routeFor = (harness: string, model: string | undefined) => {
  const id = routeOf(model);
  return id
    ? routesFor(harness).routes.find((route) => route.id === id)
    : undefined;
};
/** A display name for a saved model that names a route. */
export const routeLabel = (harness: string, model: string | undefined) =>
  routeOf(model)
    ? (routeFor(harness, model)?.label ?? "Unavailable route")
    : undefined;
/** The route an agent runs on, if any: on Automatic, the harness's
 * Automatic route; otherwise the route its saved model names. */
export const activeRoute = (
  harness: string,
  model: string | undefined,
  automatic: boolean,
) => {
  if (!automatic) return routeFor(harness, model);
  const { automatic: id, routes } = routesFor(harness);
  return id ? routes.find((route) => route.id === id) : undefined;
};

/** `models` with the harness's routes first, for pickers such as the
 * composer's; the harness's own rows for a route are replaced, and an
 * exclusive harness's other own models are left out. */
export function withRoutes(harness: string, models: Models): Models {
  const { routes, exclusive } = routesFor(harness);
  // An exclusive menu keeps only the agent's current own model, if any.
  const own = models.models.filter(
    (model) =>
      !routeOf(model.id) && (!exclusive || model.id === models.current),
  );
  if (!routes.length && own.length === models.models.length) return models;
  return {
    ...models,
    models: [
      ...routes.map((route) => ({
        id: routeModel(route.id),
        label: route.label,
        efforts: [],
      })),
      ...own,
    ],
  };
}

export type TurnPick = Readonly<{ model?: string; effort?: string }>;
export type RoutedPick = TurnPick &
  Readonly<{
    /** What chose the pick, for the turn's activity. */
    routed?: Readonly<{
      route: ModelRoute;
      rationale?: string;
      /** The router didn't answer usably. */
      fallback?: true;
      /** A steer kept the running turn's pick. */
      kept?: true;
    }>;
  }>;

/** A pick of one of `models`, with an effort that model lists. */
function listed(
  models: readonly Model[],
  choice: TurnPick | undefined,
): TurnPick | undefined {
  const model = models.find((item) => item.id === choice?.model);
  if (!model) return undefined;
  return {
    model: model.id,
    ...(choice?.effort &&
      model.efforts.some((level) => level.id === choice.effort) && {
        effort: choice.effort,
      }),
  };
}

/** The pick a turn runs on: `pick`, the owner's for this message, unless
 * the agent runs on a route (saved, picked for this message, or Automatic's),
 * in which case the route's router chooses, or the running turn's pick is
 * kept when the turn will steer (`busy`). */
export async function routeTurn(
  input: Readonly<{
    harness: string;
    pick: TurnPick;
    /** The model the agent runs on without a pick (`Models.current`). */
    current: string;
    automatic: boolean;
    models: readonly Model[];
    /** The conversation has a turn running, which this one steers into. */
    busy: boolean;
    /** The pick of the conversation's latest routed turn. */
    last?: TurnPick | undefined;
    request: Omit<ModelRouteRequest, "route" | "models" | "harness" | "signal">;
    signal: AbortSignal;
  }>,
): Promise<RoutedPick> {
  const { harness, pick } = input;
  if (pick.model && !routeOf(pick.model)) return pick;
  const { routes, owners } = resolved(harness);
  const id =
    routeOf(pick.model) ??
    (input.automatic ? routes.automatic : routeOf(input.current));
  if (!id) return pick;
  const route = routes.routes.find((item) => item.id === id);
  const router = owners.get(id);
  // The route's plugin is off, or no longer offers it.
  if (!route || !router) return {};
  if (input.busy) return { ...input.last, routed: { route, kept: true } };
  const own = input.models.filter((model) => !routeOf(model.id));
  const late = new AbortController();
  const timer = setTimeout(
    () => late.abort(new Error("The model router took too long")),
    ROUTE_TIMEOUT_MS,
  );
  const signal = AbortSignal.any([input.signal, late.signal]);
  let choice: ModelRouteChoice | undefined;
  try {
    // A router that ignores the signal still can't hold the turn past it.
    choice = await new Promise<ModelRouteChoice | undefined>(
      (resolve, reject) => {
        signal.throwIfAborted();
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
        router
          .select({ ...input.request, harness, route: id, models: own, signal })
          .then(resolve, reject);
      },
    );
  } catch (error) {
    input.signal.throwIfAborted();
    console.warn(`Model route ${id} could not choose a model`, error);
  } finally {
    clearTimeout(timer);
  }
  input.signal.throwIfAborted();
  const chosen = listed(own, choice);
  if (chosen)
    return {
      ...chosen,
      routed: {
        route,
        ...(choice?.rationale && { rationale: choice.rationale }),
      },
    };
  if (choice)
    console.warn(`Model route ${id} chose a model this harness doesn't list`);
  // Automatic's recommended model runs without a pick.
  const fallback = input.automatic ? undefined : listed(own, route.fallback);
  return { ...fallback, routed: { route, fallback: true } };
}

/** Clears the routers between tests. */
export function resetModelRoutesForTests() {
  setModelRouters([]);
}
