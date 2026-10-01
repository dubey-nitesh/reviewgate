import { describe, expect, it } from "vitest";
import { parseManualOverride } from "../../src/escapeLinkage/manualOverrideResolver";

describe("parseManualOverride", () => {
  it("parses an Escape-Source trailer", () => {
    expect(parseManualOverride("Broken since the last release.\n\nEscape-Source: #123")).toEqual({
      sourcePrId: 123,
    });
  });

  it("is case-insensitive", () => {
    expect(parseManualOverride("escape-source: #42")).toEqual({ sourcePrId: 42 });
  });

  it("tolerates whitespace around the #", () => {
    expect(parseManualOverride("Escape-Source:   #  42")).toEqual({ sourcePrId: 42 });
  });

  it("finds the trailer anywhere in the body, not just the last line", () => {
    expect(parseManualOverride("Escape-Source: #7\n\nMore details below.")).toEqual({ sourcePrId: 7 });
  });

  it("returns undefined when there is no trailer", () => {
    expect(parseManualOverride("Just a regular bug report, no trailer here.")).toBeUndefined();
  });

  it("returns undefined for null/undefined/empty body", () => {
    expect(parseManualOverride(null)).toBeUndefined();
    expect(parseManualOverride(undefined)).toBeUndefined();
    expect(parseManualOverride("")).toBeUndefined();
  });

  it("returns undefined when the referenced number isn't a safe integer", () => {
    expect(parseManualOverride(`Escape-Source: #${"9".repeat(300)}`)).toBeUndefined();
  });

  it("does not match a similar but incorrect prefix", () => {
    expect(parseManualOverride("Some-Other-Trailer: #123")).toBeUndefined();
  });
});
