import { MODEL_UNAVAILABLE_TAG } from "../relay/contracts";

/** How much of a provider's own words a failed turn's reply quotes: as much
 * as a report keeps of any failure. */
const QUOTED = 500;

/** A failed turn's reply once `explanation` (Markdown, such as a sentence
 * that links Settings) explains it: the explanation first, then, after a
 * blank line, what `who` said, quoted on the lines right under it, so the
 * thread keeps the provider's words rather than only the Activity tab. Words
 * cut short end in "…"; with no words, the explanation stands alone. */
export function withProviderWords(
  explanation: string,
  who: string,
  words: string,
) {
  const said = words.trim();
  if (!said) return explanation;
  const kept =
    said.length > QUOTED ? `${said.slice(0, QUOTED).trimEnd()}…` : said;
  const quote = kept
    .split(/\r\n?|\n/)
    .map((line) => `> ${line}`.trimEnd())
    .join("\n");
  return `${explanation}\n\n${who} said:\n${quote}`;
}

/** A model ID, as providers quote it. */
const ID = "[^\\s`'\"()]{1,200}";
/** How providers say they do not have a model: goose's "Resource not found
 * (404)" with Databricks' "'<id>' does not exist", OpenAI's "The model `<id>`
 * does not exist", Anthropic's not_found_error "model: <id>", and Claude
 * Code's "issue with the selected model (<id>)". Each captures the ID. A
 * reply offers a pick only while its agent still runs on that ID. */
const UNAVAILABLE = [
  new RegExp(`Resource not found \\(404\\)[^\\n]*?'(${ID})' does not exist`),
  new RegExp(`\\bmodel ['\`"](${ID})['\`"] does not exist`, "i"),
  new RegExp(`not_found_error[^\\n]*?"message"\\s*:\\s*"model: (${ID})"`),
  new RegExp(`issue with the selected model \\((${ID})\\)`, "i"),
];

/** The model a failed turn's error says its provider does not have, if any. */
export function unavailableModel(error: string): string | undefined {
  for (const pattern of UNAVAILABLE) {
    const model = pattern.exec(error)?.[1];
    if (model) return model;
  }
  return undefined;
}

/** The tag a failed turn's reply carries when its error names a model its
 * provider does not have, so its owner can pick another from the reply. */
export function failureTags(error: string): string[][] {
  const model = unavailableModel(error);
  return model ? [[MODEL_UNAVAILABLE_TAG, model]] : [];
}
