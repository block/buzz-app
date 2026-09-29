import type {
  ChannelMessage,
  Profile,
} from "../../../src/features/relay/contracts";
import type { TimelineRow } from "../../../src/features/messages/membership-rows";
import video from "./assets/sample.mp4";
import avatar from "../design-system/assets/avatar.png";

export const reader = "a".repeat(64);
export const teammate = "b".repeat(64);
export const agent = "c".repeat(64);
export const profiles = new Map<string, Profile>([
  [reader, { name: "Alex Morgan", picture: "https://fixture.test/avatar" }],
  [teammate, { name: "Sam Rivera" }],
  [agent, { name: "Studio assistant", isAgent: true }],
]);
export const artwork = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="#e9e8e4"/><circle cx="460" cy="100" r="48" fill="#cda97c"/><path d="M0 360L180 120L390 360M210 360L425 180L640 360" fill="#859e89"/></svg>')}`;
export const media = (url: string) => {
  if (url.endsWith("/video")) return video;
  if (url.endsWith("/avatar")) return avatar;
  if (url.endsWith("/landscape") || url.endsWith("/poster")) return artwork;
  if (url.endsWith("/notes")) return "https://example.com/design-notes.txt";
  return undefined;
};
export function message(
  id: string,
  content: string,
  patch: Partial<ChannelMessage> = {},
): ChannelMessage {
  return {
    id,
    channelId: "studio",
    authorId: reader,
    createdAt: 1_790_078_400,
    content,
    mentions: [],
    attachments: [],
    reactions: [],
    replyCount: 0,
    participants: [],
    ...patch,
  };
}
export type Example = {
  id: string;
  title: string;
  description: string;
  rows: TimelineRow[];
  day?: boolean;
  timecode?: boolean;
};
export type Group = {
  id: string;
  title: string;
  description: string;
  examples: Example[];
};
const single = (
  id: string,
  title: string,
  description: string,
  content: string,
  patch: Partial<ChannelMessage> = {},
): Example => ({ id, title, description, rows: [message(id, content, patch)] });
export const groups: Group[] = [
  {
    id: "mixed",
    title: "Mixed conversation",
    description:
      "You are Sam Rivera. Your darker bubbles and everyone else’s softer bubbles stay left aligned.",
    examples: [
      {
        id: "mixed-conversation",
        title: "You and Alex",
        description:
          "Compare both senders, consecutive messages, rich text, reactions, and media in one conversation. Try Narrow preview or the dark theme.",
        rows: [
          message("mixed-1", "Hey Sam, the new designs are ready."),
          message("mixed-2", "I tightened up the spacing. What do you think?", {
            createdAt: 1_790_078_430,
          }),
          message("mixed-3", "These look good!", {
            authorId: teammate,
            createdAt: 1_790_078_460,
          }),
          message(
            "mixed-4",
            "I’d keep **this direction**. The [reference](https://example.com) has the same quieter feel.",
            { authorId: teammate, createdAt: 1_790_078_490 },
          ),
          message("mixed-5", "Here’s the updated image.", {
            createdAt: 1_790_078_520,
            attachments: [
              {
                kind: "image",
                url: "https://fixture.test/landscape",
                dimensions: { width: 640, height: 360 },
              },
            ],
          }),
          message("mixed-6", "And my notes, for comparison.", {
            authorId: teammate,
            createdAt: 1_790_078_550,
            attachments: [
              {
                kind: "file",
                url: "https://fixture.test/notes",
                name: "design-review.txt",
                size: 13312,
              },
            ],
          }),
          message("mixed-7", "Perfect, I’ll make those changes.", {
            createdAt: 1_790_078_580,
            reactions: [
              {
                content: "👍",
                events: [{ id: "mixed-reaction", authorId: teammate }],
              },
            ],
          }),
          message("mixed-8", "", {
            authorId: teammate,
            createdAt: 1_790_078_610,
            attachments: [
              {
                kind: "image",
                url: "https://fixture.test/poster",
                dimensions: { width: 640, height: 360 },
              },
            ],
          }),
          message("mixed-9", "One more option from me ☝️", {
            authorId: teammate,
            createdAt: 1_790_078_640,
          }),
        ],
      },
    ],
  },
  {
    id: "content",
    title: "Content and identity",
    description:
      "Human and agent messages use the same row layout, with different identity shapes.",
    examples: [
      single(
        "own-plain",
        "Your message · plain text",
        "Your messages use the darker fill, regardless of formatting.",
        "The latest designs are ready. Let me know what you think.",
        { authorId: teammate },
      ),
      single(
        "own-rich",
        "Your message · Markdown",
        "The same own-message fill as plain text above.",
        "Here is **my update** with [a link](https://example.com), `inline code`, and a quote:\n\n> Ready for review.",
        { authorId: teammate },
      ),
      single(
        "text",
        "Received message · plain text",
        "Received messages use the softer fill, regardless of formatting.",
        "The latest designs are ready. Let me know what you think.",
      ),
      single(
        "received-rich",
        "Received message · Markdown",
        "The same received-message fill as plain text above.",
        "Here is **my update** with [a link](https://example.com), `inline code`, and a quote:\n\n> Ready for review.",
      ),
      single(
        "agent",
        "Agent response",
        "An agent envelope uses a squircle avatar and the same Markdown renderer.",
        "I reviewed the changes. **Two details** still need attention:\n\n- Align the labels.\n- Check the narrow layout.",
        { authorId: agent, agentEnvelope: true },
      ),
      single(
        "fallback",
        "Unknown author",
        "Missing profile data falls back to a shortened public key and initials.",
        "I’ll take a look this afternoon.",
        { authorId: "d".repeat(64) },
      ),
      single(
        "long",
        "Long message",
        "Multiple paragraphs and long tokens wrap within the message column.",
        "A longer update helps us inspect line length and vertical rhythm. The same row should remain readable when the panel becomes narrow.\n\nPlease check the spacing around the author, the timestamp, and the body before we move on.\n\n" +
          "long-unbroken-reference-".repeat(8),
      ),
      single(
        "markdown",
        "Rich text",
        "Headings, emphasis, quotes, lists, links, and inline code.",
        "### Review notes\n**Ready to review**, with *a few questions* and ~~one resolved item~~.\n\n> Keep the conversation easy to read.\n\n1. Check the default state.\n2. Review the error state.\n\n- [x] Layout\n- [ ] Keyboard behavior\n\nUse `message.id` in the [reference](https://example.com).",
      ),
      single(
        "code",
        "Code and tables",
        "Wide code and tables retain their own scrolling area.",
        "```ts\nconst message = { author: 'Studio assistant', status: 'ready', content: 'A long example for checking horizontal overflow in a narrow panel' };\n```\n\n| State | Meaning | Action |\n| --- | --- | --- |\n| Sent | Confirmed in history | None |\n| Failed | Publication rejected | Retry |",
      ),
      single(
        "emoji",
        "Emoji only",
        "Emoji-only content uses the current enlarged presentation.",
        "🎉 🚀",
      ),
      single(
        "custom-emoji",
        "Custom emoji",
        "An event-local emoji mapping uses the production CustomEmoji renderer.",
        "A little :landscape: inspiration.",
        {
          emoji: [
            { shortcode: "landscape", url: "https://fixture.test/landscape" },
          ],
        },
      ),
      single(
        "custom-emoji-missing",
        "Unavailable custom emoji",
        "The shortcode remains readable when the image cannot resolve.",
        "Thanks :missing:!",
        {
          emoji: [
            { shortcode: "missing", url: "https://fixture.test/missing-emoji" },
          ],
        },
      ),
      single(
        "mentions",
        "Person mention",
        "An explicit recipient plus a matching profile binds the name to its identity.",
        "@Sam Rivera could you review the spacing?",
        { mentions: [teammate] },
      ),
      single(
        "edited",
        "Edited content",
        "The current renderer shows the replacement body without a separate edited badge.",
        "Updated: the review is now at 3 pm.",
        { edited: true },
      ),
    ],
  },
  {
    id: "conversation",
    title: "Conversation context",
    description: "Date separators, reactions, thread summaries, and replies.",
    examples: [
      {
        id: "day",
        title: "Date separator and consecutive messages",
        description:
          "The same row composition is used for successive messages, including repeated authors.",
        day: true,
        rows: [
          message("day-a", "Good morning!"),
          message("day-middle", "A quick update from me.", {
            createdAt: 1_790_078_430,
          }),
          message("day-b", "I’ve posted the update above.", {
            createdAt: 1_790_078_460,
          }),
        ],
      },
      single(
        "reactions",
        "Reactions",
        "Reaction tokens below the body, as currently rendered.",
        "This is ready to ship.",
        {
          reactions: ["🎉", "👍", "❤️"].map((content, index) => ({
            content,
            events: [{ id: `sample-reaction-${index}`, authorId: teammate }],
          })),
        },
      ),
      single(
        "thread",
        "Thread summary",
        "Reply count and participant avatars; click to reveal sample replies.",
        "Let’s discuss the empty state here.",
        {
          replyCount: 4,
          participants: [reader, teammate, agent, "e".repeat(64)],
        },
      ),
      single(
        "reply",
        "Thread reply",
        "A reply uses the same row, within its thread context.",
        "The shorter label reads much better.",
        { authorId: teammate, threadRootId: "thread" },
      ),
      {
        ...single(
          "timecode",
          "Media-time reply",
          "A video timestamp anchors feedback to a moment in the clip.",
          "⏱ 0:12 — This transition needs a little more time.",
        ),
        timecode: true,
      },
    ],
  },
  {
    id: "attachments",
    title: "Attachments",
    description:
      "This first gallery pass covers images, video, and files. Audio and voice-note specimens are a follow-up.",
    examples: [
      single(
        "image-only",
        "Image only",
        "Standalone media sits directly on the page.",
        "",
        {
          attachments: [
            {
              url: "https://fixture.test/landscape",
              kind: "image",
              dimensions: { width: 640, height: 360 },
            },
          ],
        },
      ),
      single(
        "video-only",
        "Video only",
        "Standalone video shares the bubble radius without a surrounding fill.",
        "",
        {
          attachments: [
            {
              url: "https://fixture.test/video",
              kind: "video",
              dimensions: { width: 640, height: 360 },
            },
          ],
        },
      ),
      single(
        "image",
        "Image attachment",
        "A local illustration renders through the real attachment component.",
        "Here’s the first direction.",
        {
          attachments: [
            {
              url: "https://fixture.test/landscape",
              kind: "image",
              dimensions: { width: 640, height: 360 },
            },
          ],
        },
      ),
      single(
        "images",
        "Multiple images",
        "Each image follows the current stacked attachment layout.",
        "Comparing two options.",
        {
          attachments: [
            {
              url: "https://fixture.test/landscape",
              kind: "image",
              dimensions: { width: 640, height: 360 },
            },
            {
              url: "https://fixture.test/poster",
              kind: "image",
              dimensions: { width: 640, height: 360 },
            },
          ],
        },
      ),
      single(
        "image-unavailable",
        "Unavailable image",
        "No media source is available.",
        "The original image can’t be loaded.",
        {
          attachments: [{ url: "https://fixture.test/missing", kind: "image" }],
        },
      ),
      single(
        "video",
        "Video attachment",
        "The clip uses a locally generated sample and the real play/fullscreen controls.",
        "A quick walkthrough.",
        {
          attachments: [
            {
              url: "https://fixture.test/video",
              kind: "video",
              previewUrl: "https://fixture.test/poster",
              dimensions: { width: 640, height: 360 },
            },
          ],
        },
      ),
      single(
        "video-unavailable",
        "Unavailable video",
        "The same row when video media cannot be resolved.",
        "The recording is unavailable.",
        {
          attachments: [
            { url: "https://fixture.test/missing-video", kind: "video" },
          ],
        },
      ),
      single(
        "file",
        "File attachment",
        "Filename and sender-provided size with an open action.",
        "Notes from our review.",
        {
          attachments: [
            {
              url: "https://fixture.test/notes",
              kind: "file",
              name: "design-review-notes.txt",
              mime: "text/plain",
              size: 12800,
            },
          ],
        },
      ),
      single(
        "file-unavailable",
        "Unavailable file",
        "Filename remains visible when the source is missing.",
        "The attachment needs to be uploaded again.",
        {
          attachments: [
            {
              url: "https://fixture.test/missing-file",
              kind: "file",
              name: "design-review.pdf",
              mime: "application/pdf",
            },
          ],
        },
      ),
    ],
  },
  {
    id: "delivery",
    title: "Delivery states",
    description:
      "Feedback appears after the existing 10-second grace period. Accepted is not the same as confirmed in history; several pending states intentionally share the same copy.",
    examples: [
      ...(["sending", "accepted", "unknown", "failed", "seen"] as const).map(
        (delivery) =>
          single(
            `delivery-${delivery}`,
            delivery === "seen"
              ? "Confirmed in history"
              : delivery.charAt(0).toUpperCase() + delivery.slice(1),
            delivery === "seen"
              ? "Confirmed messages have no delivery notice."
              : delivery === "failed" || delivery === "unknown"
                ? "Retry is available. The demo retries locally and resets with the gallery."
                : "Shown after the grace period with confirmation still outstanding.",
            "I’ve sent the updated mockups.",
            { delivery },
          ),
      ),
      single(
        "delivery-detail",
        "Unconfirmed with details",
        "Additional delivery context appears beside the retry action.",
        "Please review when you have a moment.",
        {
          delivery: "unknown",
          deliveryError:
            "Connection interrupted. Reconnect to confirm delivery.",
        },
      ),
    ],
  },
  {
    id: "activity",
    title: "Membership activity",
    description:
      "System activity has a quieter layout than conversational messages.",
    examples: [
      ...(["member_joined", "member_left", "member_removed"] as const).map(
        (type) =>
          single(
            type,
            type === "member_joined"
              ? "Member joined"
              : type === "member_left"
                ? "Member left"
                : "Member removed",
            "Rendered by MembershipRow, not a regular message bubble.",
            "",
            {
              membership: {
                type,
                actor: type === "member_removed" ? reader : teammate,
                target: teammate,
              },
            },
          ),
      ),
      {
        id: "grouped-members",
        title: "Grouped joins",
        description:
          "Adjacent membership activity collapses into a single row with multiple identities.",
        rows: [
          {
            ...message("grouped", "", {
              membership: {
                type: "member_joined",
                actor: reader,
                target: reader,
              },
            }),
            membershipRows: [reader, teammate, agent].map((id, index) =>
              message(`join-${index}`, "", {
                membership: { type: "member_joined", actor: id, target: id },
              }),
            ),
          },
        ],
      },
    ],
  },
];
