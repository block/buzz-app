import { createContext, type ReactNode } from "react";

/** A reader opened as a tab: `id` names what it reads, such as a message, so
 * opening the same one again shows its tab. */
export type DetailTab = {
  id: string;
  title: string;
  content: ReactNode;
};
/** Reader tabs the conversation workspace owns. */
export type DetailTabs = Readonly<{
  /** Opens a reader in a tab. The tab mounts its own copy of the content, so
   * it doesn't depend on the row that opened it. */
  open(tab: DetailTab): void;
  /** Whether `id` already has a tab, which shows instead of a new reader. */
  has(id: string): boolean;
}>;
export const DetailTabContext = createContext<DetailTabs | undefined>(
  undefined,
);
