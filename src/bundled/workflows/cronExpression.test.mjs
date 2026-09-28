import assert from "node:assert/strict";
import { test } from "vitest";

import {
  CRON_FIELD_DEFINITIONS,
  cronExpressionError,
  cronExpressionFromFields,
  cronFieldsFromExpression,
  cronFieldsFromPaste,
  normalizeCronExpression,
  validateCronField,
  validateCronFields,
} from "./cronExpression.ts";

test("accepts supported five-field cron syntax", () => {
  for (const expression of [
    "0 9 * * 1-5",
    "*/15 * * * *",
    "0 */2 1,15 JAN,MAR MON-FRI",
  ]) {
    const result = cronFieldsFromPaste(expression);
    assert.equal(result.ok, true);
    assert.deepEqual(validateCronFields(result.fields), [
      null,
      null,
      null,
      null,
      null,
    ]);
    assert.equal(cronExpressionFromFields(result.fields), expression);
    assert.equal(cronExpressionError(expression), null);
  }
});

test("validates cron field ranges and structure locally", () => {
  assert.equal(
    validateCronField("60", CRON_FIELD_DEFINITIONS[0]),
    "Minute must be between 0 and 59.",
  );
  assert.equal(
    validateCronField("5-2", CRON_FIELD_DEFINITIONS[2]),
    "Day range must go from lower to higher.",
  );
  assert.equal(
    validateCronField("*/0", CRON_FIELD_DEFINITIONS[1]),
    "Hour step must be a positive whole number.",
  );
  assert.equal(
    validateCronField("", CRON_FIELD_DEFINITIONS[0]),
    "Minute is required.",
  );
  assert.equal(
    validateCronField("1,,5", CRON_FIELD_DEFINITIONS[4]),
    "Weekday has an empty list item.",
  );
  assert.equal(
    validateCronField("1-2-3", CRON_FIELD_DEFINITIONS[2]),
    "Day has an invalid range.",
  );
  assert.equal(
    validateCronField("*/5/2", CRON_FIELD_DEFINITIONS[0]),
    "Minute has an invalid step.",
  );
  assert.equal(
    validateCronField("mon", CRON_FIELD_DEFINITIONS[4]),
    null,
    "aliases are case-insensitive",
  );
  assert.equal(
    validateCronField("MON", CRON_FIELD_DEFINITIONS[3]),
    "Month contains “MON”, which is not a supported value.",
  );
});

test("whole-expression validation requires exactly five fields", () => {
  assert.deepEqual(cronFieldsFromPaste("0 9 * *"), {
    error: "Paste a 5-field cron expression. Found 4 fields.",
    ok: false,
  });
  assert.match(cronExpressionError("not-a-cron"), /Found 1 field\./);
  // The relay accepts seconds and year fields; Form mode leaves them to YAML.
  assert.match(cronExpressionError("0 0 9 * * 1-5"), /Found 6 fields\./);
  assert.equal(
    cronExpressionError("0 9 * * 8"),
    "Weekday must be between 1 and 7.",
  );
});

test("splits and normalizes expressions without inventing fields", () => {
  assert.deepEqual(cronFieldsFromExpression("  0   9 *  * 1-5 "), [
    "0",
    "9",
    "*",
    "*",
    "1-5",
  ]);
  assert.deepEqual(cronFieldsFromExpression(""), ["", "", "", "", ""]);
  assert.deepEqual(cronFieldsFromExpression("0 9"), ["0", "9", "", "", ""]);
  assert.equal(normalizeCronExpression("  0   9 *  * 1-5 "), "0 9 * * 1-5");
});

test("matches the relay weekday bounds, including ranges and lists", () => {
  for (const weekday of ["0", "0-6", "1,0", "8"])
    assert.equal(
      cronExpressionError(`0 9 * * ${weekday}`),
      "Weekday must be between 1 and 7.",
    );
  for (const weekday of ["1", "2", "7", "1-7", "SUN", "MON", "SAT"])
    assert.equal(cronExpressionError(`0 9 * * ${weekday}`), null);
});
