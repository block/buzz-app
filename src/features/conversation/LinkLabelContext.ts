import { createContext, type ReactNode } from "react";

/** Optional host-resolved display label; presentation never resolves a destination. */
export const LinkLabelContext = createContext<string | undefined>(undefined);

/** Authored Markdown formatting stays inside the host anchor. */
export const LinkContentContext = createContext<ReactNode>(undefined);

/** Host-resolved visibility for channel links rendered by a shared link renderer. */
export const LinkChannelPrivateContext = createContext(false);
