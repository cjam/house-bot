import { tool, type LanguageModel, type ToolSet } from "ai";
import { z } from "zod";
import type { AskParams, AskResult } from "./agent";
import type { AgentDefinition } from "./agents";

/** Steps the librarian gets for a library-upkeep task — more than the recipe
 * sub-agent, since tidying can span several recipes in one go. */
const LIBRARIAN_MAX_STEPS = 20;

type LibrarianToolDeps = {
  /** The same agent turn runner the main loop uses. */
  ask: (params: AskParams) => Promise<AskResult>;
  /** Resolve the sub-agent's model (its own override, or the default). */
  modelFor: (slug?: string) => LanguageModel;
  /** The librarian sub-agent's scoped MCP tools. */
  tools: ToolSet;
  agent: AgentDefinition;
};

/**
 * Exposes the librarian sub-agent to the planner as a single `tidy_recipe_library`
 * tool. Each call runs a fresh, isolated agent turn with only the library-upkeep
 * tools and a librarian persona — so the planner's meal-planning thread stays
 * clean (it sees one tool call and a short summary), and the librarian can't
 * wander into meal plans or shopping lists.
 */
export function createLibrarianTool(deps: LibrarianToolDeps): ToolSet {
  return {
    tidy_recipe_library: tool({
      description:
        "Hand a recipe-library maintenance task to the librarian sub-agent: cleaning up messy " +
        "recipes, fixing parsed ingredients, linking/normalizing steps, enriching sparse recipes, " +
        "importing or creating recipes, or reporting what needs attention. Runs a focused sub-agent " +
        "and returns a summary of what it did. Use it for library upkeep — not for meal planning or " +
        "shopping lists. Pass the user's request through as the task.",
      inputSchema: z.object({
        task: z.string().describe("The library maintenance task, in plain language."),
      }),
      execute: async ({ task }) => {
        const result = await deps.ask({
          messages: [],
          prompt: task,
          systemPrompt: deps.agent.systemPrompt,
          model: deps.modelFor(deps.agent.model),
          tools: deps.tools,
          maxSteps: LIBRARIAN_MAX_STEPS,
        });
        return { result: result.text };
      },
    }),
  };
}
