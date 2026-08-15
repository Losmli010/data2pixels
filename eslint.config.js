import js from "@eslint/js";
import pluginVue from "eslint-plugin-vue";
import tseslint from "typescript-eslint";
import prettierConfig from "eslint-config-prettier";
import globals from "globals";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "src-tauri/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...pluginVue.configs["flat/recommended"],
  {
    files: ["**/*.vue"],
    languageOptions: {
      parserOptions: { parser: tseslint.parser },
    },
  },
  {
    languageOptions: {
      globals: { ...globals.browser },
    },
    rules: {
      // prettier 负责格式，这里关闭与其冲突的风格规则
      ...prettierConfig.rules,
      "@typescript-eslint/no-explicit-any": "warn",
      "vue/multi-word-component-names": "off",
    },
  },
  {
    // Vue 官方脚手架的 SFC 类型垫片，{} / any 是规范写法
    files: ["src/vite-env.d.ts"],
    rules: {
      "@typescript-eslint/no-empty-object-type": "off",
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
);
