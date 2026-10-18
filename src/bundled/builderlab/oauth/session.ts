import {
  createOAuthSession as createSharedOAuthSession,
  type OAuthSession as SharedOAuthSession,
} from "../../../shared/oauth/session";
import type { Credential } from "./browser";

export type { LoginSnapshot } from "../../../shared/oauth/session";

/** Builderlab's plugin-lifetime session over the shared OAuth session store. */
export const createOAuthSession = (
  acquire: (signal: AbortSignal) => Promise<Credential>,
) => createSharedOAuthSession("Builderlab", acquire);
export type OAuthSession = SharedOAuthSession<Credential>;
