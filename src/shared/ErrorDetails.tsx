import { Accordion } from "./design-system/ui/Accordion";

/** The raw failure text behind a plain-language message (`userCopy`'s
 * `details`), collapsed so support can read it without it becoming the
 * message. Renders nothing when there is no raw text. */
export function ErrorDetails({ details }: { details?: string | undefined }) {
  if (!details) return null;
  return (
    <Accordion
      items={[
        {
          value: "details",
          title: "Details",
          content: (
            <p className="m-0 break-words text-body-sm text-muted">{details}</p>
          ),
        },
      ]}
    />
  );
}
