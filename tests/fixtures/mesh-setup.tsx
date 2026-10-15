import avatar from "./design-system/assets/avatar.png";
import { createRoot } from "react-dom/client";
import { useState, type ComponentType } from "react";
import { AgentCreateDialog } from "../../src/bundled/agents/AgentCreateDialog";
import { apply } from "../../src/bundled/mesh-compute/index";
import type {
  Agents,
  RegisteredAgentType,
} from "../../src/features/agents/service";
import type { PluginModule } from "../../src/plugins/api";
import { Switch } from "../../src/shared/design-system/ui/Switch";
import { Button } from "../../src/shared/design-system/ui/Button";
import "../../src/shared/styles/globals.css";

// Offline UI preview only. All native calls and community identities are synthetic.
const params = new URLSearchParams(location.search);
const memory = Number(params.get("memory") ?? 32);
const peers = params.get("peers") !== "0";
const people = Math.min(10000, Math.max(0, Number(params.get("people") ?? 3)));
const model =
  memory < 32
    ? "unsloth/gemma-3-4b-it-GGUF:Q4_K_M"
    : "unsloth/gemma-4-E4B-it-GGUF:Q4_K_M";
const downloadBytes = memory < 32 ? 2490000000 : 4980000000;
const settingsPreview = params.has("settings");
let Settings!: ComponentType<{ community: { id: string; name: string } }>;
let sharing: string | null =
  params.get("state") === "download" || params.get("state") === "sharing"
    ? model
    : null;
let stage = params.get("state") === "sharing" ? 3 : 0.7;
let mesh!: RegisteredAgentType;
const profiles = new Map([
  ["alex", { name: "Alex" }],
  ["sam", { name: "Sam" }],
  ["robin", { name: "Robin" }],
]);
for (let i = profiles.size; i < people; i++)
  profiles.set(`member-${i}`, { name: `Member ${i + 1}` });
(profiles as Map<string, { name: string; picture?: string }>).set("preview", {
  name: "You",
  picture: avatar,
});
const snapshot = {
  status: "ready",
  viewer: "preview",
  scope: "https://fixture.example:preview",
  origin: "https://fixture.example",
  session: {
    media: (url: string) => url,
    profiles: {
      snapshot: () => profiles,
      subscribe: () => () => {},
      ensure: async () => {},
    },
  },
};
Object.assign(window, {
  isTauri: true,
  __TAURI_INTERNALS__: {
    invoke: async (command: string, args?: { model?: string | null }) => {
      switch (command) {
        case "mesh_compute_select":
          return "preview-lease";
        case "mesh_compute_status":
          if (sharing && !settingsPreview) stage = Math.min(stage + 0.25, 3);
          return {
            available: true,
            activity:
              sharing && stage === 3
                ? {
                    otherNodes: people,
                    sharingNodes: peers ? people : 0,
                    outputTokens: 12480,
                    completedRequests: 36,
                    finishedRequests: 36,
                    retries: 0,
                    activeRequests: 1,
                    tokensPerSecond: 42.6,
                  }
                : null,
            boundCommunity: "https://fixture.example",
            sharing,
            lifecycle: { state: sharing ? "ready" : "stopped" },
            modelReady: !!sharing && stage === 3,
            download:
              sharing && stage < 2
                ? {
                    label: "Gemma 4 E4B",
                    file: null,
                    downloadedBytes: (stage / 2) * downloadBytes,
                    totalBytes: downloadBytes,
                    done: false,
                  }
                : null,
          };
        case "mesh_compute_catalog":
          return {
            gpuName: "Preview computer",
            vramDisplay: `${memory} GB`,
            hosting: {
              memoryDisplay: `${memory} GB`,
              maxVramGb: memory / 4,
              model: memory >= 16 ? model : null,
            },
            entries: [
              {
                model,
                name: "Gemma 4 E4B",
                size: `${(downloadBytes / 1e9).toFixed(2)} GB`,
                installed: false,
              },
            ],
          };
        case "mesh_compute_inventory":
          return {
            unavailable: null,
            entries: peers
              ? [...profiles.keys()].slice(0, people).map((memberPubkey) => ({
                  memberPubkey,
                  modelId: model,
                }))
              : [],
          };
        case "mesh_compute_share":
          sharing = args?.model ?? null;
          stage = 0;
          return;
        case "mesh_compute_widget_open":
        case "mesh_compute_widget_close":
        case "mesh_compute_release":
          return;
        default:
          throw new Error(`Unexpected preview command: ${command}`);
      }
    },
  },
});
const previewAgents = { status: "ready", agents: [] };
apply({
  relay: { snapshot: () => snapshot, subscribe: () => () => {} },
  communityReader: {
    snapshot: () => ({ viewer: "preview" }),
    subscribe: () => () => {},
  },
  host: {
    spawn: async () => {
      throw new Error("Preview does not run agents");
    },
  },
  agents: {
    snapshot: () => previewAgents,
    subscribe: () => () => {},
    types: () => [mesh],
    register: (type: RegisteredAgentType) => {
      mesh = {
        ...type,
        key: "mesh/mesh",
        pluginId: "mesh",
        revision: "preview",
      };
    },
  },
  settingsCards: {
    register: (card: { component: typeof Settings }) => {
      Settings = card.component;
    },
  },
  effect: () => {},
} as unknown as Parameters<PluginModule["apply"]>[0]);
function resetSetup() {
  localStorage.removeItem(
    `buzz.mesh.setup:${JSON.stringify([snapshot.viewer, "https://fixture.example"])}`,
  );
}

function Preview() {
  const [open, setOpen] = useState(!settingsPreview);
  const [created, setCreated] = useState(false);
  return (
    <main className="p-4 text-body">
      <p>
        <a href="?settings&memory=32&people=3">Settings</a> ·{" "}
        <a href="?settings&state=download&memory=32&people=3">Download</a> ·{" "}
        <a href="?settings&state=sharing&memory=32&people=3000">
          3,000 sharing
        </a>{" "}
        · <a href="?settings&memory=8&peers=0">8 GB / empty</a>
      </p>
      <p>Mesh setup preview · simulated hardware, community and downloads</p>
      <p>
        <a href="?memory=32&people=3">3 people</a> ·{" "}
        <a href="?memory=32&people=30">30 people</a> ·{" "}
        <a href="?memory=32&people=3000">3,000 people</a> ·{" "}
        <a href="?memory=32&peers=0">First contributor</a> ·{" "}
        <a href="?memory=8&peers=0">8 GB / no compute</a>
      </p>
      <div className="flex flex-wrap items-center gap-4">
        <Switch
          label="8 GB computer"
          checked={memory === 8}
          onCheckedChange={(checked) => {
            resetSetup();
            const next = new URL(location.href);
            next.searchParams.set("memory", checked ? "8" : "32");
            location.href = next.href;
          }}
        />
        <Switch
          label="Community compute available"
          checked={peers}
          onCheckedChange={(checked) => {
            resetSetup();
            const next = new URL(location.href);
            next.searchParams.set("peers", checked ? "1" : "0");
            location.href = next.href;
          }}
        />
        <Button
          onClick={() => {
            resetSetup();
            location.reload();
          }}
        >
          Reset setup
        </Button>
      </div>
      <Button onClick={() => setOpen(true)}>Open setup</Button>
      <Button
        onClick={() => {
          stage = Math.min(stage + 1, 3);
        }}
      >
        Advance download
      </Button>
      <Button
        onClick={() => {
          document.documentElement.classList.toggle("dark");
        }}
      >
        Toggle theme
      </Button>
      {settingsPreview && (
        <div className="mx-auto max-w-3xl py-6">
          <Settings
            community={{
              id: "https://fixture.example",
              name: "Buzz community",
            }}
          />
        </div>
      )}
      {created && <p>Preview agent created. No data was saved.</p>}
      {open && (
        <AgentCreateDialog
          types={[mesh]}
          agents={
            {
              create: async () => ({ name: "Preview agent" }),
            } as unknown as Agents
          }
          onClose={() => setOpen(false)}
          onCreated={() => {
            setOpen(false);
            setCreated(true);
          }}
        />
      )}
    </main>
  );
}
const root = document.getElementById("root");
if (root) createRoot(root).render(<Preview />);
