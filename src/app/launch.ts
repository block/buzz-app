// Build-time launch switch. Home stays available for a later release.
export const homeEnabled = import.meta.env.VITE_BUZZ_HOME_ENABLED === "1";
