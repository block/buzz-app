import { createContext } from "react";

/** How plugin images in message content load. The virtualized timeline
 * provides "eager": its buffer already bounds which rows mount, and WebKit's
 * native lazy margin (about one viewport) sits inside that buffer, too late
 * for a fast-scrolled image. Unbounded lists keep native lazy loading. */
export const MediaLoadingContext = createContext<"eager" | "lazy">("lazy");
