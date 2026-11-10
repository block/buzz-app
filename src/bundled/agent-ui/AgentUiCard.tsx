import { createContext, useContext, useId, useState } from "react";
import { defineCatalog, type Spec } from "@json-render/core";
import {
  defineRegistry,
  JSONUIProvider,
  Renderer,
  useBoundProp,
  useStateStore,
} from "@json-render/react";
import { schema } from "@json-render/react/schema";
import { Button } from "../../shared/design-system/ui/Button";
import { Field } from "../../shared/design-system/ui/Field";
import { InlineHeader } from "../../shared/design-system/ui/Header";
import { Input } from "../../shared/design-system/ui/Input";
import { Textarea } from "../../shared/design-system/ui/Textarea";
import { useToastNotification } from "../../shared/design-system/ui/Toast";
import { writeClipboardText } from "../../shared/clipboard";
import { agentUiDraft, agentUiProps } from "./spec";
import styles from "./AgentUi.module.css";

const catalog = defineCatalog(schema, {
  components: {
    Card: { props: agentUiProps.Card, slots: ["default"] },
    Text: { props: agentUiProps.Text },
    Table: { props: agentUiProps.Table },
    TextInput: { props: agentUiProps.TextInput },
    Button: { props: agentUiProps.Button },
  },
  actions: {},
});
const SpecContext = createContext<Spec | null>(null);

const { registry } = defineRegistry(catalog, {
  components: {
    Card: ({ props, children }) => (
      <section
        aria-label={props.title}
        className={`${styles.card} text-body`}
        data-agent-ui-card=""
      >
        <InlineHeader title={props.title} />
        {children}
      </section>
    ),
    Text: ({ props }) => <div className={styles.text}>{props.text}</div>,
    Table: ({ props }) => (
      <table>
        <thead>
          <tr>
            {props.columns.map((column, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: positional table columns
              <th key={index} scope="col">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {props.rows.map((row, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: positional table rows
            <tr key={index}>
              {row.map((cell, cellIndex) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: positional table cells
                <td key={cellIndex}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    ),
    TextInput: function DraftField({ props, bindings }) {
      const id = useId();
      const [value, setValue] = useBoundProp<string>(
        props.value as unknown as string,
        bindings?.value,
      );
      return (
        <Field label={props.label} controlId={id}>
          {props.multiline ? (
            <Textarea
              id={id}
              value={value ?? ""}
              maxLength={4000}
              rows={4}
              onChange={(event) => setValue(event.target.value)}
            />
          ) : (
            <Input
              id={id}
              value={value ?? ""}
              maxLength={4000}
              onValueChange={setValue}
            />
          )}
        </Field>
      );
    },
    Button: function CopyDraft({ props }) {
      const spec = useContext(SpecContext);
      const notify = useToastNotification();
      const { getSnapshot, state } = useStateStore();
      const [copiedState, setCopiedState] = useState<Record<
        string,
        unknown
      > | null>(null);
      const [busy, setBusy] = useState(false);
      return (
        <div className={styles.actions}>
          <Button
            size="sm"
            style={{ maxInlineSize: "100%" }}
            loading={busy}
            onClick={async (event) => {
              event.stopPropagation();
              if (!spec || busy) return;
              setBusy(true);
              try {
                const snapshot = getSnapshot();
                await writeClipboardText(agentUiDraft(spec, snapshot));
                setCopiedState(snapshot);
                notify("Draft copied", "success");
              } catch {
                notify("Could not copy the draft", "error");
              } finally {
                setBusy(false);
              }
            }}
          >
            <span className={styles.buttonLabel}>
              {copiedState === state ? "Copied" : props.label}
            </span>
          </Button>
        </div>
      );
    },
  },
});

/** Fields belong to this mount; editing or remounting the message resets them. */
export default function AgentUiCard({ spec }: { spec: Spec }) {
  return (
    <SpecContext value={spec}>
      <JSONUIProvider registry={registry} initialState={spec.state ?? {}}>
        <Renderer spec={spec} registry={registry} />
      </JSONUIProvider>
    </SpecContext>
  );
}
