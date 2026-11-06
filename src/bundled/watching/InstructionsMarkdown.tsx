import Markdown, { type Components } from "react-markdown";

const components: Components = {
  h1: ({ children }) => <h1 className="text-label text-primary">{children}</h1>,
  h2: ({ children }) => (
    <h2 className="text-label-sm text-primary">{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 className="text-label-sm text-primary">{children}</h3>
  ),
  h4: ({ children }) => (
    <h4 className="text-label-sm text-primary">{children}</h4>
  ),
  h5: ({ children }) => (
    <h5 className="text-label-sm text-primary">{children}</h5>
  ),
  h6: ({ children }) => (
    <h6 className="text-label-sm text-primary">{children}</h6>
  ),
  a: ({ href, children }) =>
    href ? (
      <a href={href} target="_blank" rel="noreferrer">
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),
  img: ({ alt }) => alt ?? "",
};

export function InstructionsMarkdown({ text }: { text: string }) {
  return (
    <div className="attention-markdown text-body-sm text-secondary">
      <Markdown
        components={components}
        urlTransform={(url) =>
          /^(https?:|mailto:|buzz:|nostr:|#)/i.test(url) ? url : ""
        }
      >
        {text}
      </Markdown>
    </div>
  );
}
