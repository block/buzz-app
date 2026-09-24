// Demo-only host boundary. Real control service and production UI; no processes or saved user data.
import { createAgentControl } from "../../../src/features/agents/control";
export function createNativeAgentControl() {
  return createAgentControl(
    new URL(location.href).searchParams.has("library")
      ? null
      : {
          snapshot: async () => (await fetch("/demo/control")).json(),
          save: async () => {
            throw new Error("Demo is read-only");
          },
          action: async () => {
            throw new Error("Demo does not launch agents");
          },
          previewImport: async () => {
            throw new Error("Demo has no imports");
          },
          commitImport: async () => {
            throw new Error("Demo has no imports");
          },
        },
  );
}
