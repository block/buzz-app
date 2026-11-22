import type { ReactNode } from "react";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { GitHubBody } from "./GitHubBody";
import type { Comment } from "./pr-comments";
import styles from "./InlineComments.module.css";

export function GitHubComment({
  comment,
  children,
}: {
  comment: Comment;
  children?: ReactNode;
}) {
  return (
    <article className={styles.commentRow}>
      <Avatar
        src={comment.avatarUrl}
        alt=""
        fallback={comment.author}
        size="small"
      />
      <div className={styles.commentContent}>
        <a
          className="text-link"
          href={comment.url}
          target="_blank"
          rel="noreferrer"
        >
          {comment.author}
        </a>
        <GitHubBody body={comment.body} url={comment.url} />
        {children}
      </div>
    </article>
  );
}
