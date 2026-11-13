import { useEffect, useState } from "react";
import type { LinkPreviewProps } from "../../features/conversation/contracts";
import type { Loader, Page } from "./loader";
import { domainOf } from "./safety";
import styles from "./LinkPreview.module.css";

/** The thumbnail box is always the same size, so the card never changes
 * height when its image arrives, fails or is evicted. */
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

export function LinkPreview({
  url,
  open,
  loader,
}: LinkPreviewProps & { loader: Loader }) {
  const [page, setPage] = useState<Page | null>(() => loader.peek(url) ?? null);
  useEffect(() => {
    let live = true;
    void loader.page(url).then((found) => live && setPage(found));
    return () => {
      live = false;
    };
  }, [loader, url]);
  if (!page) return null;
  const domain = domainOf(url);
  const site =
    page.siteName && page.siteName.toLowerCase() !== domain.toLowerCase()
      ? `${page.siteName} · ${domain}`
      : domain;
  return (
    <a
      className={styles.card}
      href={url}
      data-media={page.image ? "" : undefined}
      onClick={(event) => {
        event.preventDefault();
        open();
      }}
    >
      <span className={styles.body}>
        <span className={styles.site}>{site}</span>
        <span className={styles.title}>{page.title}</span>
        {page.description && (
          <span className={styles.description}>{page.description}</span>
        )}
      </span>
      {page.image && (
        <Media loader={loader} image={page.image} alt={page.imageAlt ?? ""} />
      )}
    </a>
  );
}
