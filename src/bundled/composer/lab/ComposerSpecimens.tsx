import type { ReactNode } from "react";
import { MessageComposer } from "../../../features/messages/MessageComposer";
import { useComposerFixture } from "./fixture";
import { ComposerStateGallery } from "./ComposerStateGallery";

function Page({
  title,
  intro,
  children,
}: {
  title: string;
  intro: string;
  children: ReactNode;
}) {
  return (
    <div className="product-page">
      <header className="product-page-header">
        <h1 className="text-title text-primary">{title}</h1>
        <p className="text-body-lg text-secondary">{intro}</p>
      </header>
      {children}
    </div>
  );
}

function Playground() {
  const props = useComposerFixture();
  return <MessageComposer {...props} />;
}

export function ComposerSpecimens({ section }: { section?: string } = {}) {
  if (!section)
    return (
      <Page
        title="Composer"
        intro="The production composer and its consequential states, using controlled session fixtures."
      >
        <ComposerStateGallery />
      </Page>
    );
  const title =
    section === "formatting"
      ? "Text formatting"
      : section === "expressions"
        ? "Emoji and expressions"
        : "Inline chips";
  return (
    <Page
      title={title}
      intro="This is the same composer used in channels and threads; preview data never reaches a conversation."
    >
      <section className="product-section" aria-label="Playground">
        <Playground />
      </section>
    </Page>
  );
}
