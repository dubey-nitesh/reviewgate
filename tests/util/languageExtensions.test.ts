import { describe, expect, it } from "vitest";
import { isSameLanguageFamily, isSupportedFile, languageFamilyOf, SUPPORTED_EXTENSIONS } from "../../src/util/languageExtensions";

describe("languageFamilyOf", () => {
  it.each([
    ["src/foo.ts", "ts-js"],
    ["src/foo.tsx", "ts-js"],
    ["src/foo.js", "ts-js"],
    ["src/foo.jsx", "ts-js"],
    ["src/foo.py", "python"],
  ] as const)("resolves %s to %s", (filename, expected) => {
    expect(languageFamilyOf(filename)).toBe(expected);
  });

  it.each(["src/foo.md", "src/foo.json", "src/foo", "src/foo.rb", "src/foo.go"])(
    "resolves an unrecognized extension (%s) to undefined",
    (filename) => {
      expect(languageFamilyOf(filename)).toBeUndefined();
    }
  );
});

describe("isSupportedFile", () => {
  it("is true for every recognized extension", () => {
    for (const ext of SUPPORTED_EXTENSIONS) {
      expect(isSupportedFile(`src/foo${ext}`)).toBe(true);
    }
  });

  it("is false for an unrecognized extension", () => {
    expect(isSupportedFile("src/foo.md")).toBe(false);
  });
});

describe("isSameLanguageFamily", () => {
  it("is true for two TS/JS files", () => {
    expect(isSameLanguageFamily("src/a.ts", "src/b.jsx")).toBe(true);
  });

  it("is true for two Python files", () => {
    expect(isSameLanguageFamily("src/a.py", "src/b.py")).toBe(true);
  });

  it("is false across families — the G6 polyglot-repo guarantee", () => {
    expect(isSameLanguageFamily("src/a.py", "src/b.ts")).toBe(false);
    expect(isSameLanguageFamily("src/a.ts", "src/b.py")).toBe(false);
  });

  it("is false when either file is an unrecognized extension, even if both are unrecognized", () => {
    expect(isSameLanguageFamily("src/a.md", "src/b.ts")).toBe(false);
    expect(isSameLanguageFamily("src/a.md", "src/b.md")).toBe(false);
  });
});
