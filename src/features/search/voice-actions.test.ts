import { assert, describe, expect, it, vi } from "vitest";
import type {
  DecisionRequest,
  DecisionResult,
  Decisions,
} from "../decisions/service";
import type { Navigation } from "../navigation/controller";
import type { Communities } from "../communities/service";
import type { ChannelMessage, ChannelSummary } from "../relay/contracts";
import type { RelaySession } from "../relay/session";
import {
  ACTION_NAVIGATE_OPTION,
  ACTION_NONE_OPTION,
  buildActionDecision,
  decideVoiceAction,
  extractFreeText,
  holdsActionLead,
  matchActionBindings,
  type VoiceActionSpec,
  type VoiceEntity,
  type VoiceSlotEntities,
} from "./voice-actions";
import {
  sessionVoiceEntities,
  type VoiceActionContext,
  type VoiceActionEnv,
} from "./voice-actions-app";
import { channelVoiceActions } from "./voice-actions-channel";
import { messageVoiceActions } from "./voice-actions-message";
import { VOICE_ACTIONS } from "./voice-actions-registry";
import type { VoiceThing } from "./voice-context";
import type { JumpPlace } from "./voice-jump";

const places: JumpPlace[] = [
  {
    key: "channel:sec",
    kind: "channel",
    channelId: "sec",
    name: "buzz-security",
    at: 200,
  },
  {
    key: "channel:design",
    kind: "channel",
    channelId: "design",
    name: "design",
    at: 100,
  },
];

const entities: VoiceSlotEntities = {
  channel: [
    {
      kind: "channel",
      id: "sec",
      label: "#buzz-security",
      detail: "stream",
      soundsLikeName: "buzz-security",
      meta: { channelType: "stream", name: "buzz-security" },
    },
    {
      kind: "channel",
      id: "design",
      label: "#design",
      detail: "stream",
      soundsLikeName: "design",
      meta: { channelType: "stream", name: "design" },
    },
  ],
  section: [
    {
      kind: "section",
      id: "group:work",
      label: "Work",
      soundsLikeName: "Work",
      meta: { sectionId: "work", name: "Work" },
    },
    {
      kind: "section",
      id: "group:personal",
      label: "Personal",
      soundsLikeName: "Personal",
      meta: { sectionId: "personal", name: "Personal" },
    },
  ],
  person: [
    {
      kind: "person",
      id: "a".repeat(64),
      label: "Alex",
      soundsLikeName: "Alex",
      meta: { pubkey: "a".repeat(64), name: "Alex", isAgent: true },
    },
    {
      kind: "person",
      id: "b".repeat(64),
      label: "Sam",
      soundsLikeName: "Sam",
      meta: { pubkey: "b".repeat(64), name: "Sam", isAgent: true },
    },
  ],
};

const hoveredChannel: VoiceThing = {
  kind: "channel",
  id: "sec",
  name: "buzz-security",
  channelType: "stream",
  starred: false,
  label: "#buzz-security",
};

const hoveredSection: VoiceThing = {
  kind: "section",
  id: "group:work",
  sectionId: "work",
  name: "Work",
  label: "section Work",
};

const hoveredMessage: VoiceThing = {
  kind: "message",
  id: "f".repeat(64),
  channelId: "sec",
  authorName: "Alice",
  preview: "Rotate the key",
  label: 'message from Alice: "Rotate the key"',
};

const m1Actions = [...channelVoiceActions, ...messageVoiceActions];

describe("matchActionBindings", () => {
  it("runs forward lookup on owner and reverse lookup on target", () => {
    const channelBindings = matchActionBindings(
      m1Actions,
      hoveredChannel,
      entities,
    );
    expect(channelBindings.map((b) => [b.action.id, b.hoveredRole])).toEqual([
      ["channel.star", "owner"],
      ["channel.unstar", "owner"],
      ["channel.move_to_section", "target"],
    ]);

    const sectionBindings = matchActionBindings(
      m1Actions,
      hoveredSection,
      entities,
    );
    expect(
      sectionBindings.map((b) => [b.action.id, b.hoveredRole, b.missingSlot]),
    ).toEqual([["channel.move_to_section", "owner", "channel"]]);
  });

  it("includes sidebar and people actions in the combined VOICE_ACTIONS registry", () => {
    const ids = VOICE_ACTIONS.map((a) => a.id);
    expect(ids).toContain("channel.star");
    expect(ids).toContain("channel.mute");
    expect(ids).toContain("person.message");
    expect(ids).toContain("message.forward_to_person");
  });

  it("emits both bindings for same-type ambiguity (owner === target)", () => {
    const sameType: VoiceActionSpec[] = [
      {
        id: "channel.move_next_to",
        owner: "channel",
        target: "channel",
        confirm: "none",
        describe: ({ hoveredRole, bound }) =>
          hoveredRole === "owner"
            ? `Move ${bound?.label} next to another channel`
            : `Move another channel next to ${bound?.label}`,
      },
    ];
    const bindings = matchActionBindings(sameType, hoveredChannel, entities);
    expect(bindings).toHaveLength(2);
    expect(bindings.map((b) => b.hoveredRole)).toEqual(["owner", "target"]);
    expect(bindings.map((b) => b.sentence)).toEqual([
      "Move #buzz-security next to another channel",
      "Move another channel next to #buzz-security",
    ]);
  });

  it("excludes bindings whose required entity slot is empty", () => {
    const bindings = matchActionBindings(VOICE_ACTIONS, hoveredChannel, {
      ...entities,
      section: [],
    });
    expect(bindings.map((b) => b.action.id)).not.toContain(
      "channel.move_to_section",
    );
  });
});

describe("extractFreeText", () => {
  it("extracts section names from natural phrasing", () => {
    expect(extractFreeText("add buzz community")).toBe("buzz community");
    expect(
      extractFreeText("create a new sidebar section called Work Stuff"),
    ).toBe("Work Stuff");
    expect(extractFreeText("make section Engineering.")).toBe("Engineering");
  });
});

describe("buildActionDecision & decideVoiceAction", () => {
  it("builds a single Decisions request with action, speculative slots, and place", async () => {
    const built = buildActionDecision({
      spoken: "move this to work",
      hovered: hoveredChannel,
      actions: channelVoiceActions.filter((_, i) => i === 0 || i === 2),
      entities,
      places,
      community: "https://relay.example.org",
    });

    expect(built.request).toBeDefined();
    expect(
      Object.keys(
        (() => {
          assert(built.request);
          return built.request;
        })().questions,
      ),
    ).toEqual(["action", "section", "place"]);
    const state = JSON.parse(
      (() => {
        assert(built.request);
        return built.request;
      })().state,
    );
    expect(state.hovered).toEqual({
      kind: "channel",
      label: "#buzz-security",
    });
    expect(state.section).toHaveLength(2);
    expect(state.places).toHaveLength(2);

    const resolved = built.resolve({
      action: {
        type: "choice",
        choice: "Move #buzz-security into a sidebar section",
        confidence: 0.94,
        probabilities: {
          "Move #buzz-security into a sidebar section": 0.94,
        },
      },
      section: {
        type: "choice",
        choice: "Work",
        confidence: 0.91,
        probabilities: { Work: 0.91 },
      },
      place: {
        type: "choice",
        choice: "none",
        confidence: 0.95,
        probabilities: { none: 0.95 },
      },
    });

    expect(resolved).toMatchObject({
      kind: "action",
      actionId: "channel.move_to_section",
      owner: { id: "group:work", label: "Work" },
      target: { id: "sec", label: "#buzz-security" },
    });
  });

  it("ignores hover and navigates when Jev chooses navigate (requires 0.7 or place >= 0.8 when actions offered)", () => {
    const built = buildActionDecision({
      spoken: "take me to design",
      hovered: hoveredChannel,
      actions: channelVoiceActions.slice(0, 1),
      entities,
      places,
    });
    const resolved = built.resolve({
      action: {
        type: "choice",
        choice: ACTION_NAVIGATE_OPTION,
        confidence: 0.95,
        probabilities: { [ACTION_NAVIGATE_OPTION]: 0.95 },
      },
      place: {
        type: "choice",
        choice: "#design",
        confidence: 0.92,
        probabilities: { "#design": 0.92 },
      },
    });
    expect(resolved).toMatchObject({
      kind: "navigate",
      place: { channelId: "design" },
      probability: 0.92,
    });

    // When actions were offered and navigate is 0.6 (< 0.7) with place 0.65 (< 0.8), show options instead.
    const uncertainNav = built.resolve({
      action: {
        type: "choice",
        choice: ACTION_NAVIGATE_OPTION,
        confidence: 0.6,
        probabilities: { [ACTION_NAVIGATE_OPTION]: 0.6, none: 0.4 },
      },
      place: {
        type: "choice",
        choice: "#design",
        confidence: 0.65,
        probabilities: { "#design": 0.65 },
      },
    });
    expect(uncertainNav.kind).toBe("none");
    expect(uncertainNav.placeCandidates).toHaveLength(1);
  });

  it("applies the 3-step auto-run rule: >=0.7 acts, navigate in top-2 with place >=0.8 navigates, else shows options", () => {
    const built = buildActionDecision({
      spoken: "jump to design",
      hovered: hoveredChannel,
      actions: channelVoiceActions.slice(0, 1),
      entities,
      places,
    });

    // Step 2: action 0.52 (< 0.7), navigate in top 2, place 0.92 (>= 0.8) -> navigate.
    const navResolved = built.resolve({
      action: {
        type: "choice",
        choice: "Star #buzz-security (pin to Starred / Favorites)",
        confidence: 0.52,
        probabilities: {
          "Star #buzz-security (pin to Starred / Favorites)": 0.52,
          [ACTION_NAVIGATE_OPTION]: 0.45,
        },
      },
      place: {
        type: "choice",
        choice: "#design",
        confidence: 0.92,
        probabilities: { "#design": 0.92 },
      },
    });
    expect(navResolved).toMatchObject({
      kind: "navigate",
      place: { channelId: "design" },
      probability: 0.92,
    });

    // Step 3: action 0.58 (< 0.7) even with big margin, place not >= 0.8 -> none with actionCandidates.
    const noneResolved = built.resolve({
      action: {
        type: "choice",
        choice: "Star #buzz-security (pin to Starred / Favorites)",
        confidence: 0.58,
        probabilities: {
          "Star #buzz-security (pin to Starred / Favorites)": 0.58,
          none: 0.42,
        },
      },
      place: {
        type: "choice",
        choice: "none",
        confidence: 0.6,
        probabilities: { none: 0.6 },
      },
    });
    expect(noneResolved.kind).toBe("none");
    expect(noneResolved.actionCandidates).toHaveLength(1);
    expect(noneResolved.actionCandidates[0]).toMatchObject({
      kind: "action",
      actionId: "channel.star",
    });
  });

  it("returns none when a free-text action has no extracted name", () => {
    const createSection: VoiceActionSpec = {
      id: "section.create",
      owner: null,
      target: "text",
      confirm: "confirm",
      describe: () => "Create a new sidebar section",
    };
    const built = buildActionDecision({
      spoken: "create a section",
      hovered: { kind: "nothing", label: "nothing" },
      actions: [createSection],
      entities,
      places,
    });
    const resolved = built.resolve({
      action: {
        type: "choice",
        choice: "Create a new sidebar section",
        confidence: 0.95,
        probabilities: { "Create a new sidebar section": 0.95 },
      },
    });
    expect(resolved.kind).toBe("none");
  });

  it("falls back to place match when channel slot answers none", () => {
    const built = buildActionDecision({
      spoken: "put design in here",
      hovered: hoveredSection,
      actions: channelVoiceActions.slice(2, 3),
      entities,
      places,
    });
    const resolved = built.resolve({
      action: {
        type: "choice",
        choice:
          "Put a channel in here, into section Work (move it to this section)",
        confidence: 0.92,
        probabilities: {
          "Put a channel in here, into section Work (move it to this section)": 0.92,
        },
      },
      channel: {
        type: "choice",
        choice: "none",
        confidence: 0.6,
        probabilities: { none: 0.6 },
      },
      place: {
        type: "choice",
        choice: "#design",
        confidence: 0.94,
        probabilities: { "#design": 0.94 },
      },
    });
    expect(resolved).toMatchObject({
      kind: "action",
      actionId: "channel.move_to_section",
      owner: { id: "group:work" },
      target: { id: "design", label: "#design" },
    });
  });

  it("fills an empty slot from the place only at the step-2 bar", () => {
    const built = buildActionDecision({
      spoken: "add buzz community",
      hovered: hoveredSection,
      actions: channelVoiceActions.slice(2, 3),
      entities,
      places,
    });
    const move =
      "Put a channel in here, into section Work (move it to this section)";
    const resolved = built.resolve({
      action: {
        type: "choice",
        choice: move,
        confidence: 0.77,
        probabilities: { [move]: 0.77 },
      },
      channel: {
        type: "choice",
        choice: "none",
        confidence: 0.79,
        probabilities: { none: 0.79 },
      },
      place: {
        type: "choice",
        choice: "#buzz-security",
        confidence: 0.52,
        probabilities: { "#buzz-security": 0.52 },
      },
    });
    expect(resolved.kind).toBe("none");
  });

  it("returns none when action or slot confidence is below threshold", () => {
    const built = buildActionDecision({
      spoken: "move this",
      hovered: hoveredChannel,
      actions: channelVoiceActions.slice(2, 2 + 1),
      entities,
      places,
    });
    const resolved = built.resolve({
      action: {
        type: "choice",
        choice: "Move #buzz-security into a sidebar section",
        confidence: 0.9,
        probabilities: {
          "Move #buzz-security into a sidebar section": 0.9,
        },
      },
      section: {
        type: "choice",
        choice: "Work",
        confidence: 0.35,
        probabilities: { Work: 0.35, Personal: 0.3 },
      },
    });
    expect(resolved.kind).toBe("none");
  });

  it("resolves free-text missingSlot actions deterministically", () => {
    const createSection: VoiceActionSpec = {
      id: "section.create",
      owner: null,
      target: "text",
      confirm: "none",
      describe: () => "Create a new sidebar section",
    };
    const built = buildActionDecision({
      spoken: "add buzz community",
      hovered: { kind: "nothing", label: "nothing" },
      actions: [createSection],
      entities,
      places,
    });
    expect(
      Object.keys(
        (() => {
          assert(built.request);
          return built.request;
        })().questions,
      ),
    ).toEqual(["action", "place"]);
    const resolved = built.resolve({
      action: {
        type: "choice",
        choice: "Create a new sidebar section",
        confidence: 0.9,
        probabilities: { "Create a new sidebar section": 0.9 },
      },
    });
    expect(resolved).toMatchObject({
      kind: "action",
      actionId: "section.create",
      text: "buzz community",
    });
  });

  it("adds phonetic sounds_like hints for slot entities", () => {
    const built = buildActionDecision({
      spoken: "move this to colonel",
      hovered: hoveredChannel,
      actions: channelVoiceActions.slice(2, 2 + 1),
      entities: {
        ...entities,
        section: [
          {
            kind: "section",
            id: "group:kernel",
            label: "kernel",
            detail: "Sidebar section",
            soundsLikeName: "kernel",
          },
        ],
      },
      places,
    });
    const state = JSON.parse(
      (() => {
        assert(built.request);
        return built.request;
      })().state,
    );
    expect(state.section).toEqual([
      {
        option: "kernel",
        detail: "Sidebar section",
        sounds_like: ["colonel"],
      },
    ]);
  });

  it("falls back to pure place decision when nothing is hovered and no global actions match", async () => {
    const decide = vi.fn(
      async (_req: DecisionRequest): Promise<DecisionResult> => ({
        outcome: "answered",
        backend: "test",
        model: "jev",
        answers: {
          place: {
            type: "choice",
            choice: "#design",
            confidence: 0.88,
            probabilities: { "#design": 0.88 },
          },
        },
      }),
    );
    const decisions = { decide } as unknown as Decisions;
    const outcome = await decideVoiceAction(decisions, {
      spoken: "design",
      hovered: { kind: "nothing", label: "nothing" },
      actions: m1Actions,
      entities,
      places,
    });
    expect(decide).toHaveBeenCalledOnce();
    expect(Object.keys(decide.mock.calls[0]?.[0]?.questions ?? {})).toEqual([
      "place",
    ]);
    expect(outcome).toMatchObject({
      kind: "navigate",
      place: { channelId: "design" },
    });
  });

  it("never fires confirm-gated actions on live partial speech, and holds extendable slot names", () => {
    const forwardAction = messageVoiceActions[0];
    assert(forwardAction);
    expect(
      holdsActionLead(
        undefined,
        {
          kind: "action",
          actionId: forwardAction.id,
          binding: {
            action: forwardAction,
            hoveredRole: "owner",
            bound: { kind: "message", id: "m1", label: "m1" },
            missingSlot: "person",
            sentence: "Forward",
          },
          probability: 0.99,
          owner: { kind: "message", id: "m1", label: "m1" },
          target: entities.person?.[0],
          actionCandidates: [],
          placeCandidates: [],
        },
        "send this to Alex",
        entities,
      ),
    ).toEqual({ fire: false, lead: undefined });

    const extendedEntities: VoiceSlotEntities = {
      section: [
        { kind: "section", id: "group:buzz", label: "Buzz" },
        { kind: "section", id: "group:buzz-sec", label: "Buzz Security" },
      ],
    };
    const moveAction = channelVoiceActions[2];
    assert(moveAction);
    const moveOutcome = {
      kind: "action" as const,
      actionId: moveAction.id,
      binding: {
        action: moveAction,
        hoveredRole: "target" as const,
        bound: { kind: "channel" as const, id: "c1", label: "#general" },
        missingSlot: "section" as const,
        sentence: "Move",
      },
      probability: 0.9,
      owner: extendedEntities.section?.[0],
      target: { kind: "channel" as const, id: "c1", label: "#general" },
      actionCandidates: [],
      placeCandidates: [],
    };
    const first = holdsActionLead(
      undefined,
      moveOutcome,
      "move to buzz",
      extendedEntities,
    );
    expect(first).toEqual({
      fire: false,
      lead: { key: "channel.move_to_section:group:buzz", words: 3 },
    });
    const second = holdsActionLead(
      first.lead,
      moveOutcome,
      "move to buzz please",
      extendedEntities,
    );
    expect(second.fire).toBe(true);
  });
});

describe("sessionVoiceEntities & M1 action execution", () => {
  function makeActionHarness() {
    const alexPk = "a".repeat(64);
    const alicePk = "d".repeat(64);
    const msgId = "e".repeat(64);
    const setStar = vi.fn(async () => ["sec"]);
    const assign = vi.fn(async () => ({ sections: [], assignments: {} }));
    const ensure = vi.fn(async () => {});
    const openDm = vi.fn(async () => "dm-alex");
    const forward = vi.fn(() => "sent-fwd-1");
    const delivered = vi.fn(async () => {});
    const acknowledge = vi.fn(async () => {});
    const openNav = vi.fn(async () => ({ status: "opened" as const }));
    const notify = vi.fn();

    const channels: ChannelSummary[] = [
      {
        id: "sec",
        name: "buzz-security",
        channelType: "stream",
        lastActivityAt: 200,
      } as ChannelSummary,
      {
        id: "general",
        name: "general",
        channelType: "stream",
        lastActivityAt: 150,
      } as ChannelSummary,
    ];
    const row: ChannelMessage = {
      id: msgId,
      channelId: "sec",
      authorId: alicePk,
      createdAt: 190,
      content: "Heads up on key rotation",
      mentions: [],
      attachments: [],
      reactions: [],
      replyCount: 0,
      participants: [],
    } as ChannelMessage;

    const session = {
      viewer: "f".repeat(64),
      channels: {
        list: () => ({ status: "ready", channels }),
        get: (id: string) => channels.find((c) => c.id === id),
        window: (id: string) => ({
          channelId: id,
          status: "ready",
          rows: id === "sec" ? [row] : [],
          hasMore: false,
          loadingOlder: false,
          error: undefined,
        }),
      },
      sidebarPreferences: {
        writable: true,
        starWritable: true,
        ensure,
        setStar,
        assign,
        snapshot: () => ({
          status: "ready",
          data: {
            sections: [{ id: "work", name: "Work", order: 0 }],
            assignments: {},
            starred: [],
            muted: [],
          },
        }),
      },
      profiles: {
        snapshot: () =>
          new Map([
            [alicePk, { name: "Alice" }],
            [alexPk, { name: "Alex", isAgent: true }],
          ]),
      },
      agentChoices: {
        snapshot: () => ({
          identities: [
            {
              pubkey: alexPk,
              name: "Alex",
              managed: true,
              messageable: true,
            },
          ],
        }),
      },
      directMessages: {
        available: true,
        open: openDm,
        delivered,
      },
      messages: {
        forwardProblem: () => undefined,
        forward,
      },
      outbox: {
        acknowledge,
      },
    } as unknown as RelaySession;

    const env: VoiceActionEnv = {
      navigation: { open: openNav } as unknown as Navigation,
      communities: {} as Communities,
      notify,
    };

    const makeCtx = (hovered: VoiceThing): VoiceActionContext => ({
      session,
      hovered,
      resolveName: (_pk, fallback) => fallback,
      community: "https://relay.example.org",
      scope: {
        viewer: "f".repeat(64),
        communityOrigin: "https://relay.example.org",
      },
    });

    return {
      session,
      env,
      makeCtx,
      setStar,
      assign,
      openDm,
      forward,
      delivered,
      acknowledge,
      openNav,
      notify,
      alexPk,
      msgId,
    };
  }

  it("omits Starred from section entities so star and move_to_section never collide", () => {
    const h = makeActionHarness();
    const collected = sessionVoiceEntities(h.session, (_pk, f) => f);
    const ids = (collected.section ?? []).map((s) => s.id);
    expect(ids).toContain("group:work");
    expect(ids).not.toContain("starred");
  });

  it("executes channel.star, channel.move_to_section, and message.forward_to_person / channel", async () => {
    const h = makeActionHarness();
    const starAction = channelVoiceActions.find((a) => a.id === "channel.star");
    assert(starAction);
    const moveAction = channelVoiceActions.find(
      (a) => a.id === "channel.move_to_section",
    );
    assert(moveAction);
    const fwdPerson = messageVoiceActions.find(
      (a) => a.id === "message.forward_to_person",
    );
    assert(fwdPerson);
    const fwdChannel = messageVoiceActions.find(
      (a) => a.id === "message.forward_to_channel",
    );
    assert(fwdChannel);

    await starAction.run(
      {
        ctx: h.makeCtx(hoveredChannel),
        owner: { kind: "channel", id: "sec", label: "#buzz-security" },
        spoken: "star this",
      },
      h.env,
    );
    expect(h.setStar).toHaveBeenCalledWith("sec", true);

    await moveAction.run(
      {
        ctx: h.makeCtx(hoveredChannel),
        owner: {
          kind: "section",
          id: "group:work",
          label: "Work",
          meta: { sectionId: "work" },
        },
        target: { kind: "channel", id: "sec", label: "#buzz-security" },
        spoken: "move this to work",
      },
      h.env,
    );
    expect(h.assign).toHaveBeenCalledWith("sec", "work");

    await fwdPerson.run(
      {
        ctx: h.makeCtx({ ...hoveredMessage, id: h.msgId }),
        owner: {
          kind: "message",
          id: h.msgId,
          label: "message from Alice",
          meta: { channelId: "sec" },
        },
        target: {
          kind: "person",
          id: h.alexPk,
          label: "Alex",
          meta: { isAgent: true },
        },
        spoken: "send this to Alex",
      },
      h.env,
    );
    expect(h.openDm).toHaveBeenCalledWith([h.alexPk], expect.any(AbortSignal));
    expect(h.forward).toHaveBeenCalledWith(
      "dm-alex",
      expect.objectContaining({ id: h.msgId }),
      "Alice",
      "",
      expect.objectContaining({ key: "message:forward" }),
    );
    expect(h.delivered).toHaveBeenCalledWith(
      "sent-fwd-1",
      "dm-alex",
      expect.any(AbortSignal),
    );
    expect(h.acknowledge).toHaveBeenCalledWith("sent-fwd-1");
    expect(h.notify).toHaveBeenCalledWith(
      "Message forwarded to Alex",
      "success",
      expect.objectContaining({ label: "Open Alex" }),
    );

    await fwdChannel.run(
      {
        ctx: h.makeCtx({ ...hoveredMessage, id: h.msgId }),
        owner: {
          kind: "message",
          id: h.msgId,
          label: "message from Alice",
          meta: { channelId: "sec" },
        },
        target: {
          kind: "channel",
          id: "general",
          label: "#general",
        },
        spoken: "forward this to general",
      },
      h.env,
    );
    expect(h.forward).toHaveBeenLastCalledWith(
      "general",
      expect.objectContaining({ id: h.msgId }),
      "Alice",
      "",
      expect.objectContaining({ key: "message:forward" }),
    );
  });

  it("also passes action sanity check for none option constant", () => {
    expect(ACTION_NONE_OPTION).toBe("None of these");
  });
});

describe("the place an action would act on", () => {
  const moveIntoSection = channelVoiceActions.filter(
    (action) => action.id === "channel.move_to_section",
  );
  const optionFor = (request: DecisionRequest | undefined, start: string) => {
    const question = request?.questions.action;
    const option =
      question?.type === "choice"
        ? Object.keys(question.options).find((key) => key.startsWith(start))
        : undefined;
    if (!option) throw new Error(`No option starting ${start}`);
    return option;
  };

  it("shows options instead of navigating to the channel a move would move", () => {
    const built = buildActionDecision({
      spoken: "put design in here",
      hovered: hoveredSection,
      actions: moveIntoSection,
      entities,
      places,
    });
    const move = optionFor(built.request, "Put a channel in here");
    const resolved = built.resolve({
      action: {
        type: "choice",
        choice: ACTION_NAVIGATE_OPTION,
        confidence: 0.74,
        probabilities: { [ACTION_NAVIGATE_OPTION]: 0.74, [move]: 0.21 },
      },
      channel: {
        type: "choice",
        choice: "#design",
        confidence: 1,
        probabilities: { "#design": 1 },
      },
      place: {
        type: "choice",
        choice: "#design",
        confidence: 1,
        probabilities: { "#design": 1 },
      },
    });
    expect(resolved.kind).toBe("none");
    expect(resolved.actionCandidates.map((c) => c.kind)).toEqual([
      "navigate",
      "action",
    ]);
  });

  it("still navigates to a place the rival action wouldn't act on", () => {
    const built = buildActionDecision({
      spoken: "jump to design",
      hovered: hoveredChannel,
      actions: channelVoiceActions.slice(0, 1),
      entities,
      places,
    });
    const star = optionFor(built.request, "Star");
    const resolved = built.resolve({
      action: {
        type: "choice",
        choice: star,
        confidence: 0.52,
        probabilities: { [star]: 0.52, [ACTION_NAVIGATE_OPTION]: 0.45 },
      },
      place: {
        type: "choice",
        choice: "#design",
        confidence: 0.92,
        probabilities: { "#design": 0.92 },
      },
    });
    expect(resolved).toMatchObject({
      kind: "navigate",
      place: { channelId: "design" },
    });
  });

  it("doesn't navigate through step 2 when navigate itself is a long shot", () => {
    const built = buildActionDecision({
      spoken: "bring design over next to this",
      hovered: hoveredChannel,
      actions: channelVoiceActions.slice(0, 1),
      entities,
      places,
    });
    const star = optionFor(built.request, "Star");
    const resolved = built.resolve({
      action: {
        type: "choice",
        choice: star,
        confidence: 0.67,
        probabilities: { [star]: 0.67, [ACTION_NAVIGATE_OPTION]: 0.13 },
      },
      place: {
        type: "choice",
        choice: "#design",
        confidence: 0.9,
        probabilities: { "#design": 0.9 },
      },
    });
    expect(resolved.kind).toBe("none");
  });

  it("never fills a slot with the hovered thing itself", () => {
    const nextTo: VoiceActionSpec = {
      id: "channel.move_next_to",
      owner: "channel",
      target: "channel",
      confirm: "none",
      describe: ({ hoveredRole }) =>
        hoveredRole === "owner"
          ? "Move #buzz-security next to another channel"
          : "Move another channel next to #buzz-security",
    };
    const built = buildActionDecision({
      spoken: "put this right after random",
      hovered: hoveredChannel,
      actions: [nextTo],
      entities,
      places,
    });
    const resolved = built.resolve({
      action: {
        type: "choice",
        choice: "Move #buzz-security next to another channel",
        confidence: 1,
        probabilities: { "Move #buzz-security next to another channel": 1 },
      },
      channel: {
        type: "choice",
        choice: "#buzz-security",
        confidence: 0.9,
        probabilities: { "#buzz-security": 0.9 },
      },
      place: {
        type: "choice",
        choice: "#buzz-security",
        confidence: 0.8,
        probabilities: { "#buzz-security": 0.8 },
      },
    });
    expect(resolved.kind).toBe("none");
  });
});

describe("filling a slot the same type as the hovered thing", () => {
  // A made-up same-type action whose filter rejects the direct pick, so the
  // fallback search over the other options runs.
  const moveNextTo: VoiceActionSpec = {
    id: "channel.move_next_to",
    owner: "channel",
    target: "channel",
    confirm: "none",
    filterSlot: (slot, entity) =>
      slot !== "channel" || entity.meta?.channelType !== "forum",
    describe: ({ bound }) => `Move ${bound?.label} next to another channel`,
  };
  const forum: VoiceEntity = {
    kind: "channel",
    id: "forum",
    label: "#help-forum",
    meta: { channelType: "forum", name: "help-forum" },
  };

  it("never fills the other slot with the hovered thing itself", () => {
    const sameType = {
      ...entities,
      channel: [...(entities.channel ?? []), forum],
    };
    const bindings = matchActionBindings(
      [moveNextTo],
      hoveredChannel,
      sameType,
    ).filter((binding) => binding.hoveredRole === "owner");
    const built = buildActionDecision({
      spoken: "move this next to the help forum",
      hovered: hoveredChannel,
      actions: [moveNextTo],
      entities: sameType,
      places: [],
      bindings,
    });
    const question = built.request?.questions.action;
    const option =
      question?.type === "choice"
        ? Object.keys(question.options).find((key) => key.startsWith("Move"))
        : undefined;
    if (!option) throw new Error("No move option");
    const resolved = built.resolve(
      {
        action: {
          type: "choice",
          choice: option,
          confidence: 0.95,
          probabilities: { [option]: 0.95 },
        },
        // The forum fails the filter; the hovered channel is the runner-up.
        channel: {
          type: "choice",
          choice: "#help-forum",
          confidence: 0.6,
          probabilities: { "#help-forum": 0.6, "#buzz-security": 0.35 },
        },
      },
      0.3,
    );
    expect(resolved.kind).toBe("none");
  });
});
