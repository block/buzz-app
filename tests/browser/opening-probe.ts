import type { BundledPlugin } from "../../src/plugins/manager";
import type { RelayProfiler } from "../../src/features/relay/profiling";

// Test-build only. Read supported snapshots, never ensure/prepare a window or
// subscribe rendering to timing samples. No rows or session mutators escape.
declare global {
  interface Window {
    openingProbe?: {
      window(channel: string): {
        status: string;
        freshness: string | undefined;
        rows: number;
      };
      timings(): ReturnType<RelayProfiler["snapshot"]>;
    };
  }
}
export const openingProbe: BundledPlugin = {
  manifest: {
    id: "fixture.opening-probe",
    name: "Opening probe",
    apiVersion: 1,
  },
  module: {
    inject: ["relay"],
    apply(ctx) {
      const relay = ctx.relay;
      window.openingProbe = {
        window(channel) {
          const state = relay.snapshot().session.channels.window(channel);
          return {
            status: state.status,
            freshness: state.freshness,
            rows: state.rows.length,
          };
        },
        timings: () => relay.snapshot().session.profiling.snapshot(),
      };
      ctx.on("dispose", () => {
        delete window.openingProbe;
      });
    },
  },
};
