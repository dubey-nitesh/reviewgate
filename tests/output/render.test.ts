import { describe, expect, it } from "vitest";
import { composeCheckRunBody } from "../../src/output/render";

describe("composeCheckRunBody", () => {
  it("returns an empty string when all blocks are empty", () => {
    expect(composeCheckRunBody([{ body: "" }, { body: "" }])).toBe("");
  });

  it("returns a single block's body verbatim when only one is non-empty", () => {
    expect(composeCheckRunBody([{ body: "**Authorship**: AI-authored" }, { body: "" }])).toBe(
      "**Authorship**: AI-authored"
    );
  });

  it("joins multiple non-empty blocks with a horizontal-rule separator, preserving order", () => {
    const result = composeCheckRunBody([
      { body: "**Authorship**: AI-authored" },
      { body: "**Consistency**:\n- finding" },
      { body: "**Gate Policy**:\n- finding" },
    ]);
    expect(result).toBe("**Authorship**: AI-authored\n\n---\n\n**Consistency**:\n- finding\n\n---\n\n**Gate Policy**:\n- finding");
  });

  it("omits empty blocks entirely, including from the middle of the list", () => {
    const result = composeCheckRunBody([
      { body: "**Authorship**: AI-authored" },
      { body: "" },
      { body: "**Gate Policy**:\n- finding" },
    ]);
    expect(result).toBe("**Authorship**: AI-authored\n\n---\n\n**Gate Policy**:\n- finding");
  });

  it("returns an empty string for an empty blocks array", () => {
    expect(composeCheckRunBody([])).toBe("");
  });
});
