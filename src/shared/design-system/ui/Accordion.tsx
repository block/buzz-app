import { Accordion as BaseAccordion } from "@base-ui/react/accordion";
import { CaretDownIcon } from "../icons/index";
import type { ReactNode } from "react";

/** Accessible disclosure groups. Base UI owns expansion and keyboard behavior. */
export function Accordion({
  items,
  defaultValue = [],
  value,
  onValueChange,
  variant = "default",
  headingLevel = 3,
  keepMounted = false,
}: {
  items: readonly {
    value: string;
    title: ReactNode;
    content: ReactNode;
    /** Static row content beside the trigger in the Settings composition. */
    summary?: ReactNode;
  }[];
  defaultValue?: string[];
  value?: string[];
  onValueChange?: (value: string[]) => void;
  variant?: "default" | "form" | "navigation" | "activity" | "settings";
  headingLevel?: 2 | 3;
  /** Preserve local form state while its panel is collapsed. */
  keepMounted?: boolean;
}) {
  return (
    <BaseAccordion.Root
      data-buzz-ui=""
      className="buzz-accordion"
      data-variant={variant}
      defaultValue={defaultValue}
      value={value}
      onValueChange={onValueChange}
      multiple
      keepMounted={keepMounted}
    >
      {items.map((item) => (
        <BaseAccordion.Item key={item.value} value={item.value}>
          {variant === "settings" ? (
            <div className="buzz-accordion-settings-row">
              <div className="buzz-accordion-settings-summary">
                {item.summary}
              </div>
              <BaseAccordion.Header
                className="buzz-accordion-heading"
                render={(props) =>
                  headingLevel === 2 ? (
                    <h2 {...props}>{props.children}</h2>
                  ) : (
                    <h3 {...props}>{props.children}</h3>
                  )
                }
              >
                <BaseAccordion.Trigger
                  className="buzz-button buzz-accordion-settings-trigger"
                  data-buzz-ui=""
                  data-variant="prominent"
                  data-size="sm"
                  data-button-shape="control"
                  data-highlight-expanded="false"
                >
                  <span className="buzz-button-label">{item.title}</span>
                </BaseAccordion.Trigger>
              </BaseAccordion.Header>
            </div>
          ) : (
            <BaseAccordion.Header
              className="buzz-accordion-heading"
              render={(props) =>
                headingLevel === 2 ? (
                  <h2 {...props}>{props.children}</h2>
                ) : (
                  <h3 {...props}>{props.children}</h3>
                )
              }
            >
              <BaseAccordion.Trigger className="buzz-accordion-trigger text-body">
                <span>{item.title}</span>
                <CaretDownIcon size={14} aria-hidden="true" />
              </BaseAccordion.Trigger>
            </BaseAccordion.Header>
          )}
          <BaseAccordion.Panel className="buzz-accordion-panel">
            {item.content}
          </BaseAccordion.Panel>
        </BaseAccordion.Item>
      ))}
    </BaseAccordion.Root>
  );
}
