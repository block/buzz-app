import { createContext } from "react";
import type { ProfileProviders } from "./providers";
export const ProfileProvidersContext = createContext<
  ProfileProviders | undefined
>(undefined);
