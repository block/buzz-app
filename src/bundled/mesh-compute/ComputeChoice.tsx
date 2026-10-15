import { Tooltip } from "../../shared/design-system/ui/Tooltip";
import { SparklesIcon, BuzzIcon } from "../../shared/design-system/icons";
import { Field } from "../../shared/design-system/ui/Field";
import { Radio, RadioGroup } from "../../shared/design-system/ui/RadioGroup";
import styles from "./Compute.module.css";

/** The same compute choice in onboarding and settings; each caller owns persistence. */
export function ComputeChoice({
  label = "How will your agent run?",
  value,
  onChange,
  disabled,
  canHost,
  belowMinimum,
  memoryDisplay,
  contributors,
}: {
  label?: string;
  value: string;
  onChange(value: string): void;
  disabled: boolean;
  canHost: boolean;
  belowMinimum: boolean;
  memoryDisplay?: string | undefined;
  contributors: number | null;
}) {
  return (
    <Field
      label={<span className="block text-center">{label}</span>}
      nativeLabel={false}
    >
      <RadioGroup
        variant="segmented"
        value={value}
        onValueChange={onChange}
        disabled={disabled}
      >
        <Tooltip
          content={
            <span className="block text-center">
              Share up to 25% of your computer’s memory to power community
              agents for free. The more people contribute, the more agents your
              community can support.
            </span>
          }
        >
          <Radio
            value="share"
            disabled={!canHost}
            label={
              <span className={styles.choiceLabel}>
                <span>Share this computer</span>
                {(canHost || belowMinimum) && (
                  <span
                    className={`text-caption ${styles.recommended}`}
                    data-requirement={belowMinimum || undefined}
                  >
                    {belowMinimum ? "16 GB required" : "Recommended"}
                  </span>
                )}
              </span>
            }
            description={
              belowMinimum
                ? `Your computer has ${memoryDisplay} of memory. You can still use compute shared by your community.`
                : "Help power agents for your Buzz community. Free to share."
            }
            icon={<SparklesIcon size={18} />}
          />
        </Tooltip>
        <Tooltip
          content={
            <span className="block text-center">
              Run your agents for free on computers shared by your community.
              Nothing to download, and no model runs on your computer.
            </span>
          }
        >
          <Radio
            value="use"
            label="Use community compute"
            description={
              contributors === null
                ? "Checking community compute…"
                : contributors === 0
                  ? "No one is sharing compute yet, so your agent won’t run."
                  : contributors === 1
                    ? "Powered by 1 person in your Buzz community. Free to use."
                    : `Powered by ${contributors.toLocaleString()} people in your Buzz community. Free to use.`
            }
            icon={<BuzzIcon size={18} />}
          />
        </Tooltip>
      </RadioGroup>
    </Field>
  );
}
