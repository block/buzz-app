import type { PluginModule } from "../../plugins/api";
import {
  createNotesWorkspace,
  type NotesWorkspace,
} from "../../features/notes/workspace";
import { noteTools } from "../../features/notes/tools";
import { parseNoteUrl } from "../../features/notes/model";
import type { RelaySession } from "../../features/relay/session";
import { WorkingNotePanel, WorkingNotesPage } from "./WorkingNotesPage";
import { workingRoute } from "./working-route";

export const inject = ["pages", "relay", "navigation", "panels", "agents"];
export const apply: PluginModule["apply"] = (ctx) => {
  const relay = ctx.relay;
  const workspaces = new Map<RelaySession, NotesWorkspace>();
  const getWorkspace = (session: RelaySession) => {
    let workspace = workspaces.get(session);
    if (!workspace) {
      workspace = createNotesWorkspace(session);
      workspaces.set(session, workspace);
    }
    return workspace;
  };
  ctx.effect(() => {
    const stop = relay.subscribe(() => {
      const active = relay.snapshot().session;
      for (const [session, workspace] of workspaces)
        if (session !== active) {
          workspace.dispose();
          workspaces.delete(session);
        }
    });
    return () => {
      stop();
      for (const workspace of workspaces.values()) workspace.dispose();
      workspaces.clear();
    };
  });
  for (const tool of noteTools((client) => {
    const connection =
      ctx.agents.relay(client.key)?.snapshot() ?? relay.snapshot();
    return connection.status === "ready"
      ? getWorkspace(connection.session)
      : undefined;
  }))
    ctx.agents.addTool(tool);
  ctx.panels.register({
    id: "note",
    title: "Page",
    keepOpen: true,
    channelPlacement: "tab",
    matches: (target) => !!parseNoteUrl(target),
    component: (props) => (
      <WorkingNotePanel
        key={props.target}
        {...props}
        relay={relay}
        getWorkspace={getWorkspace}
        navigator={ctx.navigation}
      />
    ),
  });
  ctx.pages.register({
    id: "notes",
    title: "Pages",
    layout: "workspace",
    primary: true,
    placement: "topbar",
    route: {
      version: 1,
      validate: (params) => !!workingRoute(params),
    },
    component: (props) => (
      <WorkingNotesPage
        {...props}
        relay={relay}
        getWorkspace={getWorkspace}
        navigator={ctx.navigation}
      />
    ),
  });
};
