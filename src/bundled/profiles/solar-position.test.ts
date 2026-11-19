import { describe, expect, it } from "vitest";
import { solarElevation } from "./solar-position";

describe("solar position", () => {
  it("matches NREL SPA reference example (2003-10-17 12:30:30 MST)", () => {
    // NREL SPA reference zenith 50.11162 degrees (includes refraction).
    // https://midcdmz.nrel.gov/spa/
    expect(
      solarElevation(new Date("2003-10-17T19:30:30Z"), 39.742476, -105.1786),
    ).toBeCloseTo(39.89, 1);
  });
  it("keeps the sun above/below the horizon during polar summer/winter", () => {
    expect(
      solarElevation(new Date("2026-06-21T00:00:00Z"), 80, 0),
    ).toBeGreaterThan(0);
    expect(
      solarElevation(new Date("2026-12-21T12:00:00Z"), 80, 0),
    ).toBeLessThan(0);
  });
});
