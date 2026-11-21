import type { PluginModule } from "../../plugins/api";
import { createNotesWorkspace, type NotesWorkspace } from "./workspace";
import { noteTools } from "./tools";
import { parseNoteUrl } from "./model";
import type { RelaySession } from "../../features/relay/session";
import { WorkingNotePanel, WorkingNotesPage } from "./WorkingNotesPage";
import { PagesUiProvider } from "./ui";
import { workingRoute } from "./working-route";

export const inject = [
  "pages",
  "relay",
  "navigation",
  "panels",
  "agents",
  "conversation",
];
export const apply: PluginModule["apply"] = (ctx) => {
  const relay = ctx.relay;
  const ui = { conversation: ctx.conversation.ui, panels: ctx.panels };
  ctx.agents.addInstructions({
    id: "pages",
    text: "For document deliverables, prefer a live Doc to a .md attachment unless the person requests a file. Call page_help for the create/verify/link/update workflow. Update the same Doc on follow-ups; never broaden sharing automatically. Docs, Canvas and published notes use separate tools.",
  });
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
    id: "page",
    addressable: true,
    title: "Doc",
    keepOpen: true,
    channelPlacement: "tab",
    matches: (target) => !!parseNoteUrl(target),
    component: (props) => (
      <PagesUiProvider value={ui}>
        <WorkingNotePanel
          key={props.target}
          {...props}
          relay={relay}
          getWorkspace={getWorkspace}
          navigator={ctx.navigation}
        />
      </PagesUiProvider>
    ),
  });
  ctx.pages.register({
    id: "pages",
    title: "Docs",
    layout: "workspace",
    primary: true,
    placement: "dock",
    route: {
      version: 1,
      validate: (params) => !!workingRoute(params),
    },
    component: (props) => (
      <PagesUiProvider value={ui}>
        <WorkingNotesPage
          {...props}
          relay={relay}
          getWorkspace={getWorkspace}
          navigator={ctx.navigation}
        />
      </PagesUiProvider>
    ),
  });
};
