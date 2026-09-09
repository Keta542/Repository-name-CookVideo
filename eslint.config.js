// Minimal flat ESLint config. Type-aware linting is deliberately left off for now
// (keeps this scaffold fast and dependency-light) — recommended JS + TS rules only.
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ["dist/", "node_modules/"],
  }
);
