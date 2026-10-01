import { describe, expect, it } from "vitest";
import type { FileAstSummary } from "../../src/consistency/ast";
import { findNamingDeviations } from "../../src/consistency/naming";

function fileWith(identifiers: FileAstSummary["identifiers"]): FileAstSummary {
  return { identifiers, catchClauses: [] };
}

function ident(
  name: string,
  kind: "function" | "variable" | "exportedSymbol",
  namingCase: "camelCase" | "PascalCase" | "snake_case" | "CONSTANT_CASE" | "other"
) {
  return { name, kind, namingCase };
}

describe("findNamingDeviations", () => {
  it("flags a diff identifier that deviates from a clear dominant convention", () => {
    // 5 camelCase variables in the baseline — clears both BR-3 gates.
    const baseline = [
      fileWith([
        ident("fooBar", "variable", "camelCase"),
        ident("bazQux", "variable", "camelCase"),
        ident("oneVal", "variable", "camelCase"),
        ident("twoVal", "variable", "camelCase"),
        ident("threeVal", "variable", "camelCase"),
      ]),
    ];
    const diffFile = fileWith([ident("snake_named", "variable", "snake_case")]);

    const findings = findNamingDeviations(baseline, diffFile, "src/foo.ts");

    expect(findings).toEqual([
      {
        file: "src/foo.ts",
        identifierName: "snake_named",
        identifierKind: "variable",
        expectedConvention: "camelCase",
      },
    ]);
  });

  it("does not flag a diff identifier matching the dominant convention", () => {
    const baseline = [
      fileWith(
        Array.from({ length: 5 }, (_, i) => ident(`camel${i}`, "variable", "camelCase" as const))
      ),
    ];
    const diffFile = fileWith([ident("anotherCamel", "variable", "camelCase")]);

    expect(findNamingDeviations(baseline, diffFile, "src/foo.ts")).toEqual([]);
  });

  it("does not flag anything below the minimum-sample-size gate (fewer than 5)", () => {
    const baseline = [
      fileWith([
        ident("a", "variable", "camelCase"),
        ident("b", "variable", "camelCase"),
        ident("c", "variable", "camelCase"),
        ident("d", "variable", "camelCase"),
      ]),
    ];
    const diffFile = fileWith([ident("snake_case_name", "variable", "snake_case")]);

    expect(findNamingDeviations(baseline, diffFile, "src/foo.ts")).toEqual([]);
  });

  it("does not flag anything below the 80% agreement gate (a near-even split)", () => {
    // 3 camelCase, 2 snake_case out of 5 = 60% — below the 80% threshold.
    const baseline = [
      fileWith([
        ident("a", "variable", "camelCase"),
        ident("b", "variable", "camelCase"),
        ident("c", "variable", "camelCase"),
        ident("d_e", "variable", "snake_case"),
        ident("f_g", "variable", "snake_case"),
      ]),
    ];
    const diffFile = fileWith([ident("h_i", "variable", "snake_case")]);

    expect(findNamingDeviations(baseline, diffFile, "src/foo.ts")).toEqual([]);
  });

  it("evaluates each identifier kind independently", () => {
    // 5 camelCase variables (dominant) + only 2 PascalCase exportedSymbols
    // (below the sample-size gate) — a PascalCase-deviating exportedSymbol
    // in the diff must not be flagged, but a variable deviation still is.
    const baseline = [
      fileWith([
        ident("a", "variable", "camelCase"),
        ident("b", "variable", "camelCase"),
        ident("c", "variable", "camelCase"),
        ident("d", "variable", "camelCase"),
        ident("e", "variable", "camelCase"),
        ident("Foo", "exportedSymbol", "PascalCase"),
        ident("Bar", "exportedSymbol", "PascalCase"),
      ]),
    ];
    const diffFile = fileWith([
      ident("snake_var", "variable", "snake_case"),
      ident("snake_type", "exportedSymbol", "snake_case"),
    ]);

    const findings = findNamingDeviations(baseline, diffFile, "src/foo.ts");

    expect(findings).toHaveLength(1);
    expect(findings[0].identifierName).toBe("snake_var");
  });

  it("never flags a diff identifier classified as other", () => {
    const baseline = [
      fileWith(Array.from({ length: 5 }, (_, i) => ident(`camel${i}`, "variable", "camelCase" as const))),
    ];
    const diffFile = fileWith([ident("_weird", "variable", "other")]);

    expect(findNamingDeviations(baseline, diffFile, "src/foo.ts")).toEqual([]);
  });

  it("excludes other-classified baseline identifiers from the sample/agreement counts", () => {
    // 5 camelCase + 3 "other" in baseline — "other" entries must not count
    // toward the denominator, so the 5 camelCase are still 100% agreement.
    const baseline = [
      fileWith([
        ...Array.from({ length: 5 }, (_, i) => ident(`camel${i}`, "variable", "camelCase" as const)),
        ident("_a", "variable", "other"),
        ident("_b", "variable", "other"),
        ident("_c", "variable", "other"),
      ]),
    ];
    const diffFile = fileWith([ident("snake_named", "variable", "snake_case")]);

    const findings = findNamingDeviations(baseline, diffFile, "src/foo.ts");
    expect(findings).toHaveLength(1);
  });
});
