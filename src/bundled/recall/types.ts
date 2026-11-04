import type { MemoryListing } from "../../features/agents/reads";
// Host contracts come from their app owners; only recall's pipeline shapes live here.
import type { Turn } from "../../features/agents/turn-context";
import type {
  DecisionRequest,
  DecisionResult,
} from "../../features/decisions/service";
export type { Turn } from "../../features/agents/turn-context";
export type {
  TurnReads,
  AudienceFacts,
} from "../../features/agents/turn-reads";
export type { MemoryListing } from "../../features/agents/reads";
export type {
  EventData as Event,
  ReadFilter,
} from "../../features/relay/events";
export type {
  DecisionRequest,
  DecisionResult,
} from "../../features/decisions/service";

export type Memory = MemoryListing["entries"][number];

/** The owner's choices on this device. */
export type Settings = Readonly<{
  /** Where recall searches: this channel, or every channel the agent can read (audience-checked). */
  scope: "channel" | "relay";
  /** Recall memories in channels people other than the owner can read. */
  sharedMemories: boolean;
  /** Empty URL means lexical recall only. */
  embeddingUrl?: string;
  embeddingKey?: string;
  queryPrefix?: string;
  documentPrefix?: string;
}>;

export const DEFAULT_SETTINGS: Settings = {
  scope: "channel",
  sharedMemories: false,
};

/** Something recall might show: a past message or a memory line, with where it came from. */
export type Candidate = Readonly<{
  /** Event id, or `<slug>#<line>` for a memory line (slugs are `core` or `mem/…`). Unique within one recall. */
  id: string;
  kind: "message" | "memory";
  text: string;
  /** Unix seconds. */
  at: number;
  /** Message author pubkey. */
  author?: string;
  /** Message channel id. */
  channel?: string | undefined;
}>;

/** What the pipeline needs from outside the turn. */
export type Deps = Readonly<{
  settings(): Settings;
  decide(request: DecisionRequest): Promise<DecisionResult>;
  now(): number;
  /** Optional semantic search. `observe` reads in this turn's lease and returns a commit for copied values. */
  semantic?:
    | Readonly<{
        observe(turn: Turn): Promise<() => void>;
        neighbours(turn: Turn): Promise<readonly Candidate[]>;
      }>
    | undefined;
}>;
