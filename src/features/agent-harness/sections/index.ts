// The base prompt's sections, in prompt order. Each is one topic with a
// stable id and its text in a file beside this one: `<id>.md`, and
// `<id>.<variant>.md` for each other text the host can pick.
import autonomy from "./autonomy.md?raw";
import callbacks from "./callbacks.md?raw";
import engineering from "./engineering.md?raw";
import general from "./general.md?raw";
import intro from "./intro.md?raw";
import memory from "./memory.md?raw";
import mentions from "./mentions.md?raw";
import repoConventions from "./repo-conventions.md?raw";
import threading from "./threading.md?raw";
import tools from "./tools.md?raw";
import turnContract from "./turn-contract.md?raw";
import workspaceLayout from "./workspace-layout.md?raw";
import workspaceLayoutOwnFolder from "./workspace-layout.own-folder.md?raw";

/** What the host knows of a session when it starts, which picks the text of
 * a host variant section. */
export type Facts = Readonly<{
  /** The agent's workspace, absolute, when the conversation works in a folder
   * of its own instead. */
  ownFolder?: string;
}>;

export type Section = Readonly<{
  id: string;
  /** The section's text. A function is a host variant section: the facts
   * pick a complete text. A string is locked: nothing replaces or removes
   * it. */
  text: string | ((facts: Facts) => string);
}>;

export const SECTIONS: readonly Section[] = [
  { id: "intro", text: intro },
  { id: "turn-contract", text: turnContract },
  { id: "tools", text: tools },
  { id: "mentions", text: mentions },
  { id: "callbacks", text: callbacks },
  { id: "threading", text: threading },
  { id: "general", text: general },
  {
    id: "workspace-layout",
    text: ({ ownFolder }) =>
      ownFolder
        ? workspaceLayoutOwnFolder.replace("{workspace}", () => ownFolder)
        : workspaceLayout,
  },
  { id: "memory", text: memory },
  { id: "engineering", text: engineering },
  { id: "repo-conventions", text: repoConventions },
  { id: "autonomy", text: autonomy },
];
