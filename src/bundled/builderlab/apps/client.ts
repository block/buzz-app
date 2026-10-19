// The Apps Platform control plane, called with the plugin's Builderlab
// sign-in as `bl apps` calls it (block/builderlab-cli `src/bl/apps.rs`): the
// session goes as `Authorization: BBIdentity <session>`, and the gateway
// exchanges it for the control plane's own token.
import type { Host, HostResponse } from "../../../features/host/service";
import type { OAuthSession } from "../oauth/session";

/** The Apps protocol `bl` speaks, which the control plane checks. */
const PROTOCOL = "0.2.0";
export const SIGN_IN =
  "Ask your owner to sign in to Builderlab at Settings → Integrations → Builderlab, then try again.";

type Json = Record<string, unknown>;
const object = (value: unknown): Json =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : {};
const text = (value: unknown) =>
  typeof value === "string" && value ? value : undefined;

export type AppsClient = ReturnType<typeof createAppsClient>;

export function createAppsClient(
  host: Host,
  session: OAuthSession,
  base: string,
) {
  const credential = () => {
    if (session.snapshot().status !== "signed-in")
      throw new Error(`Builderlab is not signed in. ${SIGN_IN}`);
    return session.credential().value;
  };
  const headers = (secret: string) => ({
    Accept: "application/json",
    Authorization: `BBIdentity ${secret}`,
    "X-Hotpod-Agent-Client-Version": PROTOCOL,
  });
  /** The JSON object a call answered, or the error the agent can act on. */
  const answer = (secret: string, response: HostResponse, what: string) => {
    let body: Json = {};
    try {
      body = object(JSON.parse(response.body));
    } catch {
      // A failure without JSON still reports its status.
    }
    if (response.status === 401 || response.status === 403)
      throw new Error(
        `Builderlab refused the sign-in for ${what} (HTTP ${response.status}). ${SIGN_IN}`,
      );
    if (response.status < 200 || response.status >= 300) {
      const error = object(body.error);
      const detail = [
        text(error.code),
        text(error.message) ?? text(body.message),
        text(body.next_action) && `next_action: ${body.next_action}`,
      ]
        .filter(Boolean)
        .join(": ");
      // Never hand the session on, even if a server echoed it.
      throw new Error(
        `${what} failed (HTTP ${response.status})${detail ? `: ${detail}` : ""}`.replaceAll(
          secret,
          "[redacted]",
        ),
      );
    }
    return JSON.parse(JSON.stringify(body).replaceAll(secret, "[redacted]"));
  };
  const call = async (
    method: "GET" | "POST",
    path: string,
    what: string,
    body?: Json,
  ): Promise<Json> => {
    const secret = credential();
    const response = await host.request({
      url: `${base}${path}`,
      method,
      headers: {
        ...headers(secret),
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return answer(secret, response, what);
  };
  const app = (id: string, resource = "") =>
    `/v1/agent/apps/${encodeURIComponent(id)}${resource && `/${resource}`}`;

  return {
    list: () => call("GET", "/v1/agent/apps?scope=owned", "Listing apps"),
    /** Plans and reserves a new static app, as `bl apps create` does. */
    async create(name: string) {
      const plan = await call("POST", "/v1/agent/apps/plan", "Planning", {
        name,
        runtime_profile: "static",
        client_version: PROTOCOL,
      });
      const id = text(plan.app_id);
      if (!id) throw new Error("Apps Platform planned no app_id");
      // The reservation repeats what the plan settled.
      const request: Json = {};
      for (const field of ["environment", "persistence", "runtime_class"])
        if (text(plan[field])) request[field] = plan[field];
      if (text(plan.display_name)) request.name = plan.display_name;
      const reserved = await call(
        "POST",
        app(id, "reserve"),
        "Reserving",
        request,
      );
      if (reserved.app_id !== id)
        throw new Error(
          `Apps Platform reserved ${String(reserved.app_id)}, not the planned ${id}`,
        );
      const initialize = object(plan.initialize);
      const initialized =
        initialize.required === true || initialize.recommended === true
          ? await call("POST", app(id, "initialize"), "Initializing", request)
          : undefined;
      return {
        app_id: id,
        external_url:
          text(initialized?.external_url) ??
          text(reserved.external_url) ??
          text(plan.external_url),
      };
    },
    /** Uploads `artifact` as the app's next version. */
    async deploy(id: string, artifact: string) {
      if (!host.upload) throw new Error("Deploying needs the Buzz desktop app");
      const secret = credential();
      const response = await host.upload({
        url: `${base}${app(id, "deploy")}`,
        headers: headers(secret),
        file: {
          field: "artifact",
          path: artifact,
          name: "artifact.tar.gz",
          contentType: "application/gzip",
        },
      });
      return answer(secret, response, "Deploying") as Json;
    },
    ready: (id: string, version: string) =>
      call(
        "GET",
        `${app(id, "ready")}?version_id=${encodeURIComponent(version)}`,
        "Checking readiness",
      ),
    /** Lets a Builderlab workspace's members view the app, as `bl apps share
     * grant` does. */
    async share(id: string, workspace: string) {
      const access = await call("GET", app(id, "access"), "Reading access");
      if (access.visibility !== "restricted")
        throw new Error(
          `Sharing with a workspace needs restricted visibility; this app is ${String(access.visibility)}`,
        );
      const lifecycle = text(access.lifecycle_id);
      const revision = access.workspace_grant_revision;
      if (!lifecycle || typeof revision !== "number")
        throw new Error("This app has no active sharing to change");
      return call(
        "POST",
        app(id, `sharing/workspaces/${encodeURIComponent(workspace)}`),
        "Sharing",
        { lifecycle_id: lifecycle, expected_revision: revision },
      );
    },
  };
}
