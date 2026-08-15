import js from "@eslint/js";
import globals from "globals";

export default [
  { ignores: ["node_modules/**"] },
  {
    files: ["**/*.mjs"],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.nodeBuiltin,
        WebSocket: "readonly",
      },
    },
    rules: {
      // Empty catches are used for best-effort shutdown and compatibility probes.
      "no-empty": "off",
      // Windows paths and protocol regexes intentionally contain these escapes.
      "no-useless-escape": "off",
      "no-control-regex": "off",
    },
  },
];
