import { tool, type LanguageModel, type ToolSet } from "ai";
import { z } from "zod";
import type { AskParams, AskResult } from "./agent";
import type { AgentDefinition } from "./agents";

/** Steps the recipe sub-agent gets to find/import/create one recipe. */
const RECIPE_MAX_STEPS = 8;

type RecipeToolDeps = {
  /** The same agent turn runner the main loop uses. */
  ask: (params: AskParams) => Promise<AskResult>;
  /** Resolve the sub-agent's model (its own override, or the default). */
  modelFor: (slug?: string) => LanguageModel;
  /** The recipe sub-agent's scoped MCP tools. */
  tools: ToolSet;
  agent: AgentDefinition;
};

/**
 * Exposes the recipe sub-agent to the planner as a single `find_or_create_recipe`
 * tool. Each call runs a fresh, isolated agent turn with only the recipe tools
 * and a recipe-focused persona — so the planner's meal-planning thread stays
 * clean (it sees one tool call and a short result, not the find/create back-and-
 * forth), and the sub-agent can't wander into meal plans or shopping lists.
 */
export function createRecipeTool(deps: RecipeToolDeps): ToolSet {
  return {
    find_or_create_recipe: tool({
      description:
        "Find a Mealie recipe by name, or create/import it if it doesn't exist yet. Runs a " +
        "focused recipe sub-agent (it searches first, then imports from a URL or creates one) " +
        "and returns the resulting recipe's title and slug. Use this while planning whenever a " +
        "dish might not have a recipe yet — prefer it over adding a plain note.",
      inputSchema: z.object({
        name: z.string().describe("The dish/recipe name to find or create."),
        importUrl: z.string().optional().describe("A URL to import the recipe from, if one was given."),
        notes: z
          .string()
          .optional()
          .describe("Ingredients, steps, or other details to use if the recipe must be created."),
      }),
      execute: async ({ name, importUrl, notes }) => {
        const parts = [`Find or create a Mealie recipe for: "${name}".`];
        if (importUrl) parts.push(`Import from this URL if useful: ${importUrl}.`);
        if (notes) parts.push(`Details to use if creating: ${notes}`);
        const result = await deps.ask({
          messages: [],
          prompt: parts.join(" "),
          systemPrompt: deps.agent.systemPrompt,
          model: deps.modelFor(deps.agent.model),
          tools: deps.tools,
          maxSteps: RECIPE_MAX_STEPS,
        });
        return { result: result.text };
      },
    }),
  };
}
