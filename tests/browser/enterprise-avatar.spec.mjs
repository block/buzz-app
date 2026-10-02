import { test, expect } from "./source-fixture.mjs";
import { readFile } from "node:fs/promises";

test("enterprise avatar expiry closes its popup, preserves the draft, and keeps the prompt usable", async ({
  page,
}) => {
  const artwork = await readFile(
    new URL("../fixtures/design-system/assets/avatar.png", import.meta.url),
  );
  await page.goto("/tests/fixtures/enterprise-avatar.html");
  await page.getByRole("button", { name: "Edit avatar", exact: true }).click();
  const picture = page.getByRole("textbox", {
    name: "Picture URL (optional)",
    exact: true,
  });
  await picture.fill("https://images.example/keep-this-draft.png");
  await page.getByLabel("Upload an image", { exact: true }).setInputFiles({
    name: "gate.png",
    mimeType: "image/png",
    buffer: artwork,
  });

  const prompt = page.getByRole("dialog", {
    name: "Sign in to this community",
    exact: true,
  });
  await expect(prompt).toBeVisible();
  await expect(
    page.getByRole("dialog", { name: "Edit avatar", exact: true }),
  ).toHaveCount(0);
  await expect(prompt.getByRole("button", { name: "Not now" })).toBeFocused();
  await expect(prompt.getByRole("button", { name: "Sign in" })).toBeVisible();
  await prompt.getByRole("button", { name: "Not now" }).click();
  await expect(prompt).toHaveCount(0);

  await page.getByRole("button", { name: "Edit avatar", exact: true }).click();
  await expect(
    page.getByRole("textbox", {
      name: "Picture URL (optional)",
      exact: true,
    }),
  ).toHaveValue("https://images.example/keep-this-draft.png");
});
