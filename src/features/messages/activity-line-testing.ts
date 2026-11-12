import { screen } from "@testing-library/react";

/** The elements whose whole text is `text`, outermost first: an activity line
 * renders its excerpt as Markdown, so the text spans several elements. */
const reading = (text: string) =>
  screen.getAllByText((_, element) => element?.textContent === text);

/** The innermost element reading `text` in full. */
export const activityLine = (text: string) => reading(text).at(-1);

/** Whether the activity line reading `text` shows the live-work sheen. */
export const shimmers = (text: string) =>
  reading(text).some((element) => element.hasAttribute("data-active"));
