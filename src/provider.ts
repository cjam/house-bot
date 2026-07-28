import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { LanguageModel, Tool } from "ai";
import type { Config, Provider } from "./config";

export type ResolvedProvider = {
  /**
   * Resolve a model by slug, reusing the provider instance. Called per turn so a
   * chat can override the model in its settings; `undefined` yields the
   * configured default (`config.model`).
   */
  modelFor: (slug?: string) => LanguageModel;
  /**
   * The provider's built-in web-search tool, when enabled and available.
   * This is the stand-in for the Claude Code `WebSearch` builtin we lost with
   * the Agent SDK — OpenRouter ships one; direct providers would each wire
   * their own. Undefined when `webSearch` is off or unsupported.
   */
  webSearchTool?: Tool;
};

/** npm package that provides each not-yet-wired direct provider. */
const DIRECT_PROVIDER_PACKAGE: Record<Exclude<Provider, "openrouter">, string> = {
  anthropic: "@ai-sdk/anthropic",
  openai: "@ai-sdk/openai",
  google: "@ai-sdk/google",
};

/**
 * Resolve the configured provider into a model (and optional web-search tool).
 * Defaults to OpenRouter — one key reaching every model family. The direct
 * branches are a deliberate seam: config is already plumbed, so enabling one is
 * just installing its package and returning `createX(...)(config.model)` here.
 */
export function resolveProvider(config: Config): ResolvedProvider {
  switch (config.provider) {
    case "openrouter": {
      const openrouter = createOpenRouter({ apiKey: config.apiKey });
      return {
        modelFor: (slug) => openrouter.chat(slug || config.model),
        webSearchTool: config.webSearch ? openrouter.tools.webSearch({}) : undefined,
      };
    }
    case "anthropic":
    case "openai":
    case "google":
      throw new Error(
        `PROVIDER="${config.provider}" is not wired yet. Install ` +
          `${DIRECT_PROVIDER_PACKAGE[config.provider]} and enable its branch in src/provider.ts.`,
      );
  }
}
