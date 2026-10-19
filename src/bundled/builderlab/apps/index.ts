// Builderlab Apps for local agents: tools that create, deploy and share a
// static web app with the plugin's Builderlab sign-in, and a side panel that
// shows a deployed app in Buzz's browser view.
import { createElement } from "react";
import type { PluginModule } from "../../../plugins/api";
import type { PanelProps } from "../../../features/panels/service";
import type { OAuthSession } from "../oauth/session";
import { createAppsClient } from "./client";
import { appName, controlPlane, isAppUrl } from "./environment";

type Ctx = Parameters<PluginModule["apply"]>[0];
/** How long `apps_deploy` waits for the new version to serve. */
const READY_WAIT_MS = 90_000;
const READY_POLL_MS = 3_000;

const string = (args: Record<string, unknown>, name: string) => {
  const value = args[name];
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${name} is required`);
  return value.trim();
};
/** The compatibility date a live static deploy has used; a newer one may be
 * rejected. */
const COMPATIBILITY_DATE = "2026-08-14";

const DEPLOY_RECIPE = `Deploy a static web app: plain HTML, CSS and JavaScript, or a framework's exported build. Steps:
1. apps_create once per app, which returns its app_id and URL.
2. In a build directory, put the site under public/ (public/index.html is the entry) and write hotpod.manifest.json beside it:
{"schema":"hotpod.manifest.v1","app":{"app_id":"<app_id>"},"version":{"version_id":null,"compatibility_date":"${COMPATIBILITY_DATE}"},"runtime":{"profile":"static","root":"public","not_found_handling":"404"}}
3. Package it with the manifest at the archive root: tar -C <build-dir> -czf <build-dir>/../artifact.tar.gz .
4. Call this with the archive's absolute path; it must be in your owner's home directory.
It returns once the new version serves, or says it is not ready yet. Redeploy the same app_id after changes; a validation error names what to fix in the archive.`;

export function applyApps(ctx: Ctx, session: OAuthSession) {
  ctx.panels.register({
    id: "app",
    title: "App",
    // Each app keeps its own tab while the conversation moves on.
    keepOpen: true,
    matches: (target) => ctx.browser.available && isAppUrl(target),
    component: ({ target }: PanelProps) =>
      // One storage for every app keeps the apps sign-in, which covers all
      // of a tenant's app hosts, between opens and restarts.
      createElement(ctx.browser.View, {
        url: target,
        storage: "builderlab-apps",
        label: appName(target),
      }),
  });
  const base = controlPlane();
  if (!base) return;
  const apps = createAppsClient(ctx.host, session, base);
  const reply = (value: unknown) => JSON.stringify(value, null, 2);
  ctx.agents.addTool({
    name: "apps_create",
    description:
      "Create a new Builderlab app: a static web app your owner's Builderlab workspace can view. Returns its app_id, URL and the hotpod.manifest.json to deploy it with; then follow apps_deploy. Create once per app, not per deploy.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "A short display name." },
      },
      required: ["name"],
      additionalProperties: false,
    },
    async call(_client, _context, args) {
      const created = await apps.create(string(args, "name"));
      return reply({
        ...created,
        manifest: {
          schema: "hotpod.manifest.v1",
          app: { app_id: created.app_id },
          version: { version_id: null, compatibility_date: COMPATIBILITY_DATE },
          runtime: {
            profile: "static",
            root: "public",
            not_found_handling: "404",
          },
        },
      });
    },
  });
  ctx.agents.addTool({
    name: "apps_deploy",
    description: DEPLOY_RECIPE,
    inputSchema: {
      type: "object",
      properties: {
        app_id: { type: "string" },
        artifact: {
          type: "string",
          description: "The absolute path of artifact.tar.gz.",
        },
      },
      required: ["app_id", "artifact"],
      additionalProperties: false,
    },
    async call(_client, _context, args) {
      const id = string(args, "app_id");
      const deployed = await apps.deploy(id, string(args, "artifact"));
      const version =
        typeof deployed.version_id === "string" ? deployed.version_id : "";
      const result = {
        app_id: id,
        version_id: version,
        external_url: deployed.external_url,
      };
      if (!version) return reply({ ...result, ready: false, deployed });
      const until = Date.now() + READY_WAIT_MS;
      for (;;) {
        const ready = await apps.ready(id, version);
        if (ready.ready === true) return reply({ ...result, ready: true });
        if (Date.now() >= until)
          return reply({
            ...result,
            ready: false,
            note: "Deployed but not serving yet. Wait a minute before opening it; do not redeploy for this.",
            readiness: ready,
          });
        await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS));
      }
    },
  });
  ctx.agents.addTool({
    name: "apps_list",
    description: "List the Builderlab apps your owner owns, with their URLs.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    call: async () => reply(await apps.list()),
  });
  ctx.agents.addTool({
    name: "apps_share",
    description:
      "Let the members of a Builderlab workspace view an app. Only when asked to share it.",
    inputSchema: {
      type: "object",
      properties: {
        app_id: { type: "string" },
        workspace_id: {
          type: "string",
          description: "The Builderlab workspace's identifier.",
        },
      },
      required: ["app_id", "workspace_id"],
      additionalProperties: false,
    },
    call: async (_client, _context, args) =>
      reply(
        await apps.share(string(args, "app_id"), string(args, "workspace_id")),
      ),
  });
  ctx.agents.addTool({
    name: "apps_open",
    description:
      "Open a deployed app beside this conversation in your owner's Buzz, when they are viewing it. Use it after a deploy is ready, and still post the URL in your reply.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The app's external URL." },
      },
      required: ["url"],
      additionalProperties: false,
    },
    async call(_client, context, args) {
      const url = string(args, "url");
      if (!isAppUrl(url)) throw new Error("That is not a Builderlab app URL");
      if (!context.channel)
        throw new Error("There is no conversation to open it beside");
      const opened = ctx.panels.requestOpen({
        target: url,
        channelId: context.channel,
        ...(context.root ? { rootId: context.root } : {}),
      });
      return opened
        ? "Opened beside the conversation."
        : "Not opened: your owner is not viewing this conversation in the desktop app now. Post the URL; clicking it opens the app beside the conversation.";
    },
  });
}
