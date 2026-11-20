// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { createComposerHandle, overlayHost } from "./composer-overlay";
import { setThreadPlacementPreference } from "./thread-preferences";

afterEach(() => document.body.replaceChildren());

it("opens beside its scope's composer, even inside a sheet, once it attaches", () => {
  const handle = createComposerHandle("channel:C");
  const reader = document.createElement("section");
  reader.dataset.composerHost = "";
  const composer = document.createElement("form");
  reader.append(composer);
  // React can mount the editor before its portal attaches.
  const release = handle.attach(composer);
  try {
    expect(overlayHost(handle)).toBeNull();
    const layer = document.createElement("div");
    layer.dataset.detailsSheet = "";
    const sheet = document.createElement("div");
    sheet.append(reader);
    layer.append(sheet);
    document.body.append(layer);
    const nested = overlayHost(handle);
    expect(nested?.container).toBe(reader);
    expect(nested?.composer).toBe(composer);
    expect(nested?.pane).toBe(reader);
  } finally {
    release();
  }
  expect(overlayHost(handle)).toBeNull();
});

it("opens nothing over a composer unless threads and details open inline", () => {
  const handle = createComposerHandle("channel:C");
  const reader = document.createElement("section");
  reader.dataset.composerHost = "";
  const composer = document.createElement("form");
  reader.append(composer);
  document.body.append(reader);
  const release = handle.attach(composer);
  try {
    expect(overlayHost(handle)?.composer).toBe(composer);
    setThreadPlacementPreference("side");
    expect(overlayHost(handle)).toBeNull();
  } finally {
    release();
    localStorage.clear();
  }
});

it("keeps each scope's composer apart, even under one name", () => {
  const first = createComposerHandle("channel:C");
  const second = createComposerHandle("channel:C");
  const form = document.createElement("form");
  document.body.append(form);
  const release = first.attach(form);
  expect(first.form()).toBe(form);
  expect(second.form()).toBeNull();
  release();
  expect(first.form()).toBeNull();
});
