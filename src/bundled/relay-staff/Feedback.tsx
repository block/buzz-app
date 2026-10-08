import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { MediaViewer } from "../../features/messages/MediaAttachment";
import viewer from "../../features/messages/Messages.module.css";
import { Button } from "../../shared/design-system/ui/Button";
import { useToastNotification } from "../../shared/design-system/ui/Toast";
import { ArrowLeftIcon } from "../../shared/design-system/icons";
import type {
  AttachmentRef,
  FeedbackDto,
  FeedbackStatus,
  StaffFailure,
} from "../../features/relay-staff/contract";
import { describe, useRead, useSession } from "./session";
import {
  CommunityBadge,
  Failure,
  GroupedList,
  listButton,
  Loaded,
  Loading,
  Row,
  time,
} from "./ui";

const MAX_ATTACHMENTS = 5;
const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
const STATUSES: FeedbackStatus[] = ["new", "reviewed", "archived"];

type Attachment = Omit<AttachmentRef, "feedbackId">;

/** `imeta` tags with a lowercase SHA-256 (`x`), a type (`m`) and a positive size. */
export function parseAttachments(tags: unknown): Attachment[] {
  if (!Array.isArray(tags)) return [];
  return tags.flatMap((tag): Attachment[] => {
    if (!Array.isArray(tag) || tag[0] !== "imeta") return [];
    const values = new Map<string, string>();
    for (const entry of tag.slice(1)) {
      const split = typeof entry === "string" ? entry.indexOf(" ") : -1;
      if (split > 0) values.set(entry.slice(0, split), entry.slice(split + 1));
    }
    const sha256 = values.get("x") ?? "";
    const mime = values.get("m") ?? "";
    const size = Number(values.get("size"));
    return /^[0-9a-f]{64}$/.test(sha256) && mime && size > 0
      ? [{ sha256, mime, size }]
      : [];
  });
}

/** At most five attachments and 50 MiB in total, in order. */
export function attachmentBudget(attachments: Attachment[]) {
  const shown: Attachment[] = [];
  let bytes = 0;
  for (const attachment of attachments) {
    if (shown.length >= MAX_ATTACHMENTS) break;
    if (bytes + attachment.size > MAX_ATTACHMENT_BYTES) break;
    shown.push(attachment);
    bytes += attachment.size;
  }
  return { shown, hidden: attachments.length - shown.length };
}

export function Feedback() {
  const { context } = useSession();
  const [selected, setSelected] = useState<string | null>(null);
  const [list, reload] = useRead({ route: "listFeedback" }, [context]);
  if (selected)
    return (
      <FeedbackDetail
        id={selected}
        onBack={() => setSelected(null)}
        onChanged={reload}
      />
    );
  return (
    <Loaded read={list}>
      {(items) =>
        items.length === 0 ? (
          <p className="text-body-sm text-secondary">No feedback found.</p>
        ) : (
          <GroupedList
            items={items}
            render={(item) => (
              <li key={item.id}>
                <button
                  type="button"
                  className={listButton}
                  onClick={() => setSelected(item.id)}
                >
                  <span className="flex items-center gap-2">
                    <span className="line-clamp-2 font-medium">
                      {item.bodySummary.slice(0, 120)}
                    </span>
                    {item.status !== "new" && (
                      <span className="text-caption text-secondary">
                        {item.status}
                      </span>
                    )}
                  </span>
                  <span className="text-caption text-secondary">
                    {time(item.receivedAt)}
                  </span>
                </button>
              </li>
            )}
          />
        )
      }
    </Loaded>
  );
}

function FeedbackDetail({
  id,
  onBack,
  onChanged,
}: {
  id: string;
  onBack(): void;
  onChanged(): void;
}) {
  const { context } = useSession();
  const [detail] = useRead({ route: "getFeedback", id }, [context, id]);
  return (
    <div className="flex flex-col gap-4">
      <Button size="sm" variant="ghost" onClick={onBack}>
        <ArrowLeftIcon /> Back to feedback
      </Button>
      <Loaded read={detail}>
        {(feedback) => (
          <FeedbackBody feedback={feedback} onChanged={onChanged} />
        )}
      </Loaded>
    </div>
  );
}

function FeedbackBody({
  feedback,
  onChanged,
}: {
  feedback: FeedbackDto;
  onChanged(): void;
}) {
  const { canMutate, request } = useSession();
  const notify = useToastNotification();
  const [status, setStatus] = useState(feedback.status);
  const [busy, setBusy] = useState(false);
  const { shown, hidden } = attachmentBudget(parseAttachments(feedback.tags));
  const change = async (next: FeedbackStatus) => {
    if (next === status) return;
    setBusy(true);
    const outcome = await request({
      route: "setFeedbackStatus",
      id: feedback.id,
      status: next,
    });
    setBusy(false);
    if (!outcome.ok) return notify(describe(outcome.failure), "error");
    setStatus(outcome.value.status);
    notify(`Feedback marked ${outcome.value.status}`, "success");
    onChanged();
  };
  return (
    <>
      <div className="flex flex-col gap-1.5 rounded-md border px-3 py-2.5">
        <Row label="Community">
          <CommunityBadge
            id={feedback.communityId}
            host={feedback.communityHost}
          />
        </Row>
        <Row label="Submitter" mono>
          {feedback.submitterPubkey}
        </Row>
        <Row label="Category">{feedback.category}</Row>
        <Row label="Event ID" mono>
          {feedback.eventId}
        </Row>
        <Row label="Sent">{time(feedback.eventCreatedAt)}</Row>
        <Row label="Received">{time(feedback.receivedAt)}</Row>
        <p className="mt-2 whitespace-pre-wrap break-words text-body-sm">
          {feedback.body}
        </p>
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-caption font-medium text-secondary">Status</span>
        {canMutate ? (
          <div className="flex gap-1.5">
            {STATUSES.map((option) => (
              <Button
                key={option}
                size="sm"
                aria-pressed={status === option}
                variant={status === option ? "prominent" : "outline"}
                disabled={busy}
                onClick={() => void change(option)}
              >
                {option}
              </Button>
            ))}
          </div>
        ) : (
          <span className="text-body-sm">{status}</span>
        )}
      </div>
      {shown.length > 0 && (
        <div className="flex flex-col gap-3">
          <h4 className="text-body-sm font-medium">Attachments</h4>
          {shown.map((attachment) => (
            <AttachmentView
              key={attachment.sha256}
              attachment={{ ...attachment, feedbackId: feedback.id }}
            />
          ))}
          {hidden > 0 && (
            <p className="text-caption text-secondary">
              {hidden} attachment{hidden === 1 ? "" : "s"} not shown (display
              limit reached).
            </p>
          )}
        </div>
      )}
    </>
  );
}

/** Images preview inline; every attachment can be saved. */
function AttachmentView({ attachment }: { attachment: AttachmentRef }) {
  const session = useSession();
  const notify = useToastNotification();
  const image = attachment.mime.startsWith("image/");
  const [preview, setPreview] = useState<
    { url: string } | { failure: StaffFailure } | null
  >(null);
  const [saving, setSaving] = useState(false);
  const [viewing, setViewing] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed by the attachment's identity, not its object
  useEffect(() => {
    if (!image) return;
    let url: string | null = null;
    let current = true;
    void session.attachment(attachment).then((outcome) => {
      if (!current) return;
      if (!outcome.ok) return setPreview({ failure: outcome.failure });
      url = URL.createObjectURL(
        new Blob([outcome.value as BlobPart], { type: attachment.mime }),
      );
      setPreview({ url });
    });
    // The object URL is released when the attachment closes or unmounts.
    return () => {
      current = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [session, attachment.feedbackId, attachment.sha256, image]);

  const save = async () => {
    setSaving(true);
    const result = await session.saveAttachment(attachment);
    setSaving(false);
    if (result.state === "saved") notify("Attachment saved", "success");
    if (result.state === "failed") notify(describe(result.failure), "error");
  };

  return (
    <div className="flex flex-col gap-2 text-caption">
      {image &&
        (!preview ? (
          <Loading />
        ) : "url" in preview ? (
          <>
            <button
              type="button"
              aria-label="Open image"
              className="w-fit cursor-zoom-in"
              onClick={() => setViewing(true)}
            >
              <img
                src={preview.url}
                alt="Feedback attachment"
                className="max-h-80 max-w-full rounded-md border object-contain"
              />
            </button>
            {viewing &&
              createPortal(
                <MediaViewer
                  title="Image attachment"
                  close={() => setViewing(false)}
                >
                  <img
                    className={viewer.mediaViewerImage}
                    src={preview.url}
                    alt="Feedback attachment, full size"
                  />
                </MediaViewer>,
                document.body,
              )}
          </>
        ) : (
          <Failure failure={preview.failure} />
        ))}
      <span className="flex items-center gap-2 text-secondary">
        {attachment.mime} · {Math.ceil(attachment.size / 1024)} KiB
        <Button size="sm" loading={saving} onClick={() => void save()}>
          Save
        </Button>
      </span>
    </div>
  );
}
