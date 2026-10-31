// FOUNDATION: Startup of the page that runs agents. It has no screens. It
// reads agent storage once the screens' page has loaded it.
import { createAgentsHost } from "./app/agents-host";

const host = createAgentsHost();
if (import.meta.hot)
  import.meta.hot.dispose(() => {
    void host.dispose().catch(console.error);
  });
