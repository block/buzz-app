// A model route in an agent's synced settings (NIP-AP `buzz.agent.settings`).
// The route sits beside `settings`, as `modelRoute: "<id>"`, and
// `settings.model` stays empty. A version of Buzz without routes reads only
// `settings`, so it runs the harness's default instead of handing a route to
// its harness as a model. That version keeps `modelRoute` when it saves
// (NIP-AP "Editing"), so the route holds only while `settings.model` is
// empty: a model picked there takes the agent off its route. In a config the
// route stays the model, `route:<id>`.
import { routeModel, routeOf } from "./model-routes";

const ID = /^[a-z0-9._-]+$/;

/** The settings a config publishes, with its route moved beside them. */
export function publishedRoute(settings: Readonly<Record<string, string>>): {
  settings: Record<string, string>;
  modelRoute: string | undefined;
} {
  const id = routeOf(settings.model);
  return id
    ? { settings: { ...settings, model: "" }, modelRoute: id }
    : { settings: { ...settings }, modelRoute: undefined };
}

/** A body's synced settings with its route as their model, while no model
 * was picked in `settings` since. */
export function routedSettings(
  body: Readonly<{ modelRoute?: unknown }>,
  settings: Readonly<Record<string, string>>,
): Record<string, string> {
  const id = body.modelRoute;
  const model: unknown = settings.model;
  const picked = typeof model === "string" ? model.trim() : model;
  return typeof id === "string" && ID.test(id) && !picked
    ? { ...settings, model: routeModel(id) }
    : { ...settings };
}
