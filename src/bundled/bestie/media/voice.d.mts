export type Voice = {
  stop(graceful?: boolean): Promise<void>;
  interrupt(): Promise<void>;
  setMuted(muted: boolean): void;
  decide(kind: "allow_once" | "reject_once"): Promise<void>;
};
export type PermissionTool = {
  title?: string;
  rawInput?: unknown;
  kind?: string;
};
export type VoiceUI = {
  context?: string;
  evidence(events: unknown[]): void;
  status(text: string): void;
  analyzers(input: AnalyserNode | null, output: AnalyserNode | null): void;
  transcript(text: string): void;
  userTranscript(text: string, itemId: string): void;
  removeInput(itemId: string): void;
  permission(tool: PermissionTool | null, decide?: Voice["decide"]): void;
  ended(): void;
  event(type: string, data: Record<string, unknown>): void;
};
export function openVoice(
  token: string,
  ui: VoiceUI,
  options: {
    signal: AbortSignal;
    eventsUrl: string;
    rpcUrl: string;
    thinking?: string;
    created?(voice: Voice): void;
  },
): Promise<Voice>;
