// A Solo chat's Canvas, handed to its agent with every turn: the workspace's
// instructions and the folders it works in. Only the owner and their agents
// can write a Solo chat's Canvas, so it is handed over as the chat's standing
// instructions; agents never read it on their own initiative.
import { workspaceDirectories } from "../solo/workspace";

export type Project = Readonly<{
  /** The prompt section; empty when the Canvas is. */
  section: string;
  /** The folders the agent may work in, besides its own workspace. */
  directories: readonly string[];
}>;

export const NO_PROJECT: Project = Object.freeze({
  section: "",
  directories: [],
});

export function project(canvas: string | undefined): Project {
  if (!canvas?.trim()) return NO_PROJECT;
  const directories = workspaceDirectories(canvas);
  const folders = directories.length
    ? ` This chat's work happens in these folders, not your own workspace: ${directories.map((folder) => `\`${folder}\``).join(", ")}. \`cd\` into the one you need; your workspace keeps your notes.`
    : "";
  return {
    section: `<workspace-canvas>\nThis Solo chat's Canvas as of this message: its standing instructions for this chat, which the owner's messages override. It replaces any earlier workspace Canvas.${folders}\n\n${canvas.trim()}\n</workspace-canvas>`,
    directories,
  };
}

/** How long a turn waits for its chat's Canvas. */
export const CANVAS_TIMEOUT_MS = 4_000;

/** The chat's project from `read`, or undefined when it could not be read in
 * time: the caller keeps what it knew. */
export async function readProject(
  read: (() => Promise<string | undefined>) | undefined,
): Promise<Project | undefined> {
  if (!read) return NO_PROJECT;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return project(
      await Promise.race([
        read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Canvas read timed out")),
            CANVAS_TIMEOUT_MS,
          );
        }),
      ]),
    );
  } catch (error) {
    console.warn("Could not read the chat's Canvas", error);
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}
