import { SettingsGroup } from "../../shared/design-system/ui/SettingsGroup";
import { InlineHeader } from "../../shared/design-system/ui/Header";
import { Button } from "../../shared/design-system/ui/Button";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import { Select } from "../../shared/design-system/ui/Select";
import {
  ruleFields,
  ruleOperators,
  type LaneRule,
  type LaneRouting,
} from "./routing";

export function LaneRules({
  lane,
  value,
  disabled,
  onChange,
}: {
  lane: number;
  value: LaneRouting | undefined;
  disabled: boolean;
  onChange: (value: LaneRouting) => void;
}) {
  const routing = value ?? { mode: "all", rules: [] };
  const update = (index: number, rule: LaneRule) =>
    onChange({
      ...routing,
      rules: routing.rules.map((item, i) => (i === index ? rule : item)),
    });
  return (
    <>
      <InlineHeader
        title="Routing rules"
        subtitle="At least one rule is required. A PR can match several lanes."
      />
      <Select
        label="Match"
        variant="field"
        disabled={disabled}
        value={routing.mode}
        groups={[
          {
            label: "Match",
            options: [
              { value: "all", label: "Match all rules" },
              { value: "any", label: "Match any rule" },
            ],
          },
        ]}
        onValueChange={(mode) =>
          onChange({ ...routing, mode: mode as LaneRouting["mode"] })
        }
      />
      <SettingsGroup layout="cards">
        {routing.rules.map((rule, index) => (
          <section
            className="review-config-rule-card"
            aria-label={`Rule ${index + 1}`}
            key={rule.id}
          >
            <div className="review-config-rule-heading">
              <span className="text-body-sm">Rule {index + 1}</span>
              <Button
                size="sm"
                disabled={disabled || routing.rules.length === 1}
                aria-label={`Remove rule ${index + 1} from lane ${lane}`}
                onClick={() =>
                  onChange({
                    ...routing,
                    rules: routing.rules.filter((_, i) => i !== index),
                  })
                }
              >
                Remove
              </Button>
            </div>
            <div className="review-config-rule">
              <Select
                label="Field"
                variant="field"
                disabled={disabled}
                value={rule.field}
                groups={[{ label: "PR field", options: [...ruleFields] }]}
                onValueChange={(raw) => {
                  const field = raw as LaneRule["field"];
                  update(index, {
                    id: rule.id,
                    field,
                    operator: ruleOperators[field][0].value,
                    value: "",
                  });
                }}
              />
              <Select
                label="Comparison"
                variant="field"
                disabled={disabled}
                value={rule.operator}
                groups={[
                  {
                    label: "Comparison",
                    options: [...ruleOperators[rule.field]],
                  },
                ]}
                onValueChange={(operator) =>
                  update(index, {
                    ...rule,
                    operator: operator as LaneRule["operator"],
                  })
                }
              />
              <Field
                label="Value"
                description={
                  rule.field === "path"
                    ? "Case-sensitive paths: src/**, **/*.tsx. * matches within a directory; ** matches directories. Renames use the new path."
                    : rule.field === "label"
                      ? "Exact label name, ignoring case."
                      : rule.field === "title"
                        ? "Text to find in the title, ignoring case."
                        : "Whole number, including zero."
                }
              >
                <Input
                  required
                  maxLength={200}
                  disabled={disabled}
                  value={rule.value}
                  inputMode={rule.field === "files" ? "numeric" : "text"}
                  onValueChange={(text) =>
                    update(index, { ...rule, value: text })
                  }
                />
              </Field>
            </div>
          </section>
        ))}
      </SettingsGroup>
      <div>
        <Button
          disabled={disabled || routing.rules.length >= 12}
          onClick={() =>
            onChange({
              ...routing,
              rules: [
                ...routing.rules,
                {
                  id: crypto.randomUUID(),
                  field: "title",
                  operator: "contains",
                  value: "",
                },
              ],
            })
          }
        >
          Add rule
        </Button>
      </div>
    </>
  );
}

export function ruleDescription(rule: LaneRule) {
  return `${ruleFields.find((field) => field.value === rule.field)?.label} ${ruleOperators[rule.field].find((operator) => operator.value === rule.operator)?.label} “${rule.value}”`;
}
