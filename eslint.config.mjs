// ESLint flat config (ESLint 9+).
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ["dist/**", "node_modules/**", "graphify-out/**", "verify.js"],
  },
  {
    rules: {
      // Detector/store modules intentionally use `unknown`/narrow casts at
      // GitHub-API/Postgres boundaries (see config.ts's OctokitLike) rather
      // than importing the full SDK types — not a style violation here.
      "@typescript-eslint/no-explicit-any": "warn",
    },
  }
);
