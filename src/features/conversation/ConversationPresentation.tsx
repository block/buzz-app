import { createContext, useContext } from "react";

/** Presentation only: retained readers/editors keep their data and effects. */
export const ConversationPresentation = createContext(true);
export const useConversationPresentation = () =>
  useContext(ConversationPresentation);
