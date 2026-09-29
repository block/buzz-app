import { createContext } from "react";

/** Loaded message identities only. Activity must prove an explicit trigger match;
 * being in the same channel does not establish membership in this thread. */
export const ThreadActivityContext = createContext<readonly string[]>([]);
