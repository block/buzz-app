import { createContext } from "react";
import type { ChannelMessage } from "../relay/contracts";

/** Already-loaded rows from this thread host. No additional reads or lifecycle. */
export const LoadedThreadMessages = createContext<readonly ChannelMessage[]>(
  [],
);
