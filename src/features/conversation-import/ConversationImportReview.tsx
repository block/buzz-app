import { useSyncExternalStore } from "react";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { fingerprint } from "./protocol";
import type { ImportReview, ImportReviews, ReviewMember } from "./reviews";
import styles from "./ConversationImport.module.css";

export function ImportMembers({
  members,
}: {
  members: readonly ReviewMember[];
}) {
  return (
    <ul className={styles.members}>
      {members.map((member) => (
        <li key={member.pubkey} className={styles.member}>
          {member.verified ? (
            <>
              <span className={styles.memberName}>
                {member.verified.displayName}
              </span>
              <span className={styles.memberMeta}>
                @{member.verified.username}
                {member.note ? ` · ${member.note}` : ""}
              </span>
            </>
          ) : (
            <>
              <span className={`${styles.memberName} ${styles.unverified}`}>
                No verified identity
              </span>
              {member.note && (
                <span className={styles.memberMeta}>{member.note}</span>
              )}
            </>
          )}
          <span className={styles.fingerprint}>
            {member.verified?.fingerprint ?? fingerprint(member.pubkey)}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function ImportReviewDialog({
  review,
  onApprove,
  onDismiss,
}: {
  review: ImportReview;
  onApprove(): void;
  onDismiss(): void;
}) {
  return (
    <Dialog
      open
      title={review.title}
      description={review.description}
      size="default"
      height="content"
      chromeSpacing="padded"
      dismissOnOutsideClick={false}
      onOpenChange={(open) => {
        if (!open) onDismiss();
      }}
      actions={
        <>
          <Button variant="subtle" onClick={onDismiss}>
            {review.refusal ? "Close" : "Cancel"}
          </Button>
          {!review.refusal && (
            <Button
              variant={review.destructive ? "destructive" : "primary"}
              onClick={(event) => {
                // Only a person can approve: a scripted click is not trusted.
                if (event.nativeEvent.isTrusted) onApprove();
              }}
            >
              {review.confirmLabel}
            </Button>
          )}
        </>
      }
    >
      <div className={styles.body}>
        {review.refusal && (
          <p className={styles.refusal} role="alert">
            {review.refusal}
          </p>
        )}
        <dl className={styles.facts}>
          {review.facts.map((fact) => (
            <div key={fact.label} className={styles.fact}>
              <dt>{fact.label}</dt>
              <dd>{fact.value}</dd>
            </div>
          ))}
        </dl>
        <section>
          <h3 className={styles.sectionTitle}>People</h3>
          <ImportMembers members={review.members} />
        </section>
        {review.statement && (
          <p className={styles.statement}>{review.statement}</p>
        )}
      </div>
    </Dialog>
  );
}

/** Mounted once by the app shell. Shows the oldest pending import request. */
export function ConversationImportReview({
  reviews,
}: {
  reviews: ImportReviews;
}) {
  const pending = useSyncExternalStore(reviews.subscribe, reviews.snapshot);
  const review = pending[0];
  if (!review) return null;
  return (
    <ImportReviewDialog
      key={review.id}
      review={review}
      onApprove={() => reviews.approve(review.id)}
      onDismiss={() => reviews.dismiss(review.id)}
    />
  );
}
