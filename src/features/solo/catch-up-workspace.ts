export const CATCH_UP_WORKSPACE_ID = "bestie-catch-ups";
export const CATCH_UP_WORKSPACE_NAME = "Catch me up";
export const LEGACY_CATCH_UP_WORKSPACE_NAME = "Catch-ups";

const workspaceName = (name: string) => name.trim().toLocaleLowerCase();

export function isCatchUpWorkspace(workspace: { id: string; name: string }) {
  const name = workspaceName(workspace.name);
  return (
    workspace.id === CATCH_UP_WORKSPACE_ID ||
    name === workspaceName(CATCH_UP_WORKSPACE_NAME) ||
    name === workspaceName(LEGACY_CATCH_UP_WORKSPACE_NAME)
  );
}

export function catchUpWorkspaceDisplayName(name: string) {
  return workspaceName(name) === workspaceName(LEGACY_CATCH_UP_WORKSPACE_NAME)
    ? CATCH_UP_WORKSPACE_NAME
    : name;
}
