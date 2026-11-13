import { useEffect, useState } from "react";
import type { LinkPreviewProps } from "../../features/conversation/contracts";
import type { Loader, Page } from "./loader";
import { domainOf } from "./safety";
import styles from "./LinkPreview.module.css";

function Media({
  loader,
  image,
  alt,
}: {
  loader: Loader;
  image: string;
  alt: string;
}) {
  const [src, setSrc] = useState(() => loader.peekImage(image) ?? null);
  const [broken, setBroken] = useState(false);
  useEffect(() => {
    let live = true;
    setBroken(false);
    const lease = loader.image(image);
    void lease.src.then((blob) => live && setSrc(blob));
    return () => {
      live = false;
      lease.release();
    };
  }, [loader, image]);
  return (
    <span className={styles.media}>
      {src && !broken && (
        <img
          src={src}
          alt={alt}
          decoding="async"
          onError={() => setBroken(true)}
        />
      )}
    </span>
  );
}

/** Every card has the same height from its first frame, whether its page
 * is loading, read, or unreadable, so a preview never moves the reader. */
export function LinkPreview({
  url,
  open,
  loader,
}: LinkPreviewProps & { loader: Loader }) {
  const [page, setPage] = useState<Page | null | undefined>(() =>
    loader.peek(url),
  );
  useEffect(() => {
    let live = true;
    setPage(loader.peek(url));
    const lease = loader.page(url);
    void lease.value.then((found) => live && setPage(found));
    return () => {
      live = false;
      lease.release();
    };
  }, [loader, url]);
  const domain = domainOf(url);
  const site =
    page?.siteName && page.siteName.toLowerCase() !== domain.toLowerCase()
      ? `${page.siteName} · ${domain}`
      : domain;
  return (
    <a
      className={styles.card}
      href={url}
      aria-busy={page === undefined || undefined}
      onClick={(event) => {
        event.preventDefault();
        open();
      }}
    >
      <span className={styles.body}>
        <span className={styles.site}>{site}</span>
        <span className={styles.title}>{page?.title ?? bareUrl(url)}</span>
        {page?.description && (
          <span className={styles.description}>{page.description}</span>
        )}
      </span>
      {page?.image && (
        <Media loader={loader} image={page.image} alt={page.imageAlt ?? ""} />
      )}
    </a>
  );
}

const bareUrl = (url: string) => url.replace(/^https:\/\//i, "");
