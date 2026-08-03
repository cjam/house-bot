import type { ToolSet } from "ai";
import { DEFAULT_SYSTEM_PROMPT } from "./system-prompt";

/**
 * A named agent: its persona, an optional model override, and the set of MCP
 * tools it's scoped to. Scoping matters — the Mealie server exposes ~130 tools,
 * and handing all of them to every turn makes tool selection worse (near-
 * duplicate names, irrelevant surface). Each agent gets only what its task needs.
 */
export type AgentDefinition = {
  name: string;
  /** Base persona/instructions (the main agent's is overridable per chat). */
  systemPrompt: string;
  /** Model slug override; undefined uses the deployment default. */
  model?: string;
  /** Resolved MCP tool keys this agent may use (e.g. "mealie_get_mealplans"). */
  mcpTools: string[];
};

/**
 * The Mealie tools the meal-planning agent needs: read/write the week's plan,
 * find and inspect recipes, and manage the shopping list. Recipe *creation/import*
 * is delegated to the recipe sub-agent (find_or_create_recipe), and recipe-library
 * *upkeep* (cleanup, enrich, import queue) to the librarian sub-agent
 * (tidy_recipe_library) — both deliberately absent here to keep the planner's tool
 * surface small. Keys are the resolved (namespaced) tool names; any not present on
 * the connected server are skipped with a log line, so a Mealie version mismatch
 * degrades gracefully.
 */
export const PLANNER_MCP_TOOLS = [
  // Meal plan
  "mealie_get_mealplans",
  "mealie_replace_week_meal_plan",
  "mealie_get_todays_meals_api_households_mealplans_today_get",
  // Recipes — find & inspect (creation/import is the sub-agent's job)
  "mealie_get_all_recipes",
  "mealie_get_all_api_recipes_get",
  "mealie_get_recipes_detail",
  "mealie_suggest_recipes_by_name",
  // Shopping list
  "mealie_get_shopping_list_items",
  "mealie_replace_shopping_list_from_recipes",
  "mealie_normalize_shopping_list",
  "mealie_adjust_shopping_list_items",
  "mealie_add_recipe_ingredients_to_list_api_households_shopping_l",
];

/** The main household meal-planning agent. */
export const plannerAgent: AgentDefinition = {
  name: "planner",
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  mcpTools: PLANNER_MCP_TOOLS,
};

/** Focused persona for the recipe sub-agent (find-or-create one recipe). */
const RECIPE_AGENT_PROMPT = `You find or create exactly ONE Mealie recipe, then report back concisely. Steps:
1. SEARCH the library by name first (search is fuzzy — try the name and a variant or two). Never create a recipe that already exists.
2. If a matching recipe exists, you're done — return its exact title and slug.
3. If it doesn't exist and an import URL was given, import it (import_and_cleanup_recipe).
4. Otherwise create it (create_recipe) with sensible ingredients and steps from the name and any notes; you may flesh it out with set_recipe_ingredients / set_recipe_steps.
Do not touch meal plans or shopping lists. End your reply with the final recipe's exact title and slug.`;

/**
 * The Mealie tools the recipe sub-agent needs: find, create, import, and flesh
 * out a single recipe. No meal-plan or shopping-list tools — that keeps its
 * context (and its blast radius) tight.
 */
export const RECIPE_MCP_TOOLS = [
  "mealie_get_all_recipes",
  "mealie_get_all_api_recipes_get",
  "mealie_get_recipes_detail",
  "mealie_create_recipe",
  "mealie_import_and_cleanup_recipe",
  "mealie_enrich_recipe",
  "mealie_set_recipe_ingredients",
  "mealie_set_recipe_steps",
];

/** The recipe find-or-create sub-agent, invoked by the planner as a tool. */
export const recipeAgent: AgentDefinition = {
  name: "recipe",
  systemPrompt: RECIPE_AGENT_PROMPT,
  mcpTools: RECIPE_MCP_TOOLS,
};

/** Focused persona for the librarian sub-agent (recipe-library upkeep). */
const LIBRARIAN_AGENT_PROMPT = `You are the recipe librarian for a household Mealie library. You keep the recipe collection tidy and correct. You can:
- find recipes that need attention (get_recipes_needing_cleanup) and clean them up (cleanup_recipe, fix_ingredient, link_recipe_steps),
- enrich sparse recipes and repair their ingredients/steps (enrich_recipe, set_recipe_ingredients, set_recipe_steps),
- create or import recipes on request (create_recipe, import_and_cleanup_recipe), and work the import queue (get_import_queue_report, apply_import_queue).
Work methodically: find what needs attention, inspect a recipe, make focused edits, then report concisely what you changed. Search before creating so you never duplicate an existing recipe. Confirm before bulk or destructive changes you weren't explicitly asked for. Never touch meal plans or shopping lists — those aren't your job.`;

/**
 * The Mealie tools the librarian sub-agent needs: inspect the library, run the
 * cleanup workflow, edit/enrich recipes, and create/import (including the import
 * queue). No meal-plan or shopping-list tools — that keeps its scope, and its
 * blast radius, on the recipe library alone. Missing tools degrade gracefully
 * (skipped with a log line), so this can list more than a given server exposes.
 */
export const LIBRARIAN_MCP_TOOLS = [
  // Inspect the library
  "mealie_get_all_recipes",
  "mealie_get_all_api_recipes_get",
  "mealie_get_recipes_detail",
  "mealie_suggest_recipes_by_name",
  // Cleanup workflow
  "mealie_get_recipes_needing_cleanup",
  "mealie_cleanup_recipe",
  "mealie_fix_ingredient",
  "mealie_link_recipe_steps",
  // Edit / enrich
  "mealie_enrich_recipe",
  "mealie_set_recipe_ingredients",
  "mealie_set_recipe_steps",
  // Create / import
  "mealie_create_recipe",
  "mealie_import_and_cleanup_recipe",
  "mealie_get_import_queue_report",
  "mealie_apply_import_queue",
];

/** The recipe-library upkeep sub-agent, invoked by the planner as a tool. */
export const librarianAgent: AgentDefinition = {
  name: "librarian",
  systemPrompt: LIBRARIAN_AGENT_PROMPT,
  mcpTools: LIBRARIAN_MCP_TOOLS,
};

/** Select the named tools from a set; reports any that weren't found. */
export function pickTools(all: ToolSet, keys: string[]): { tools: ToolSet; missing: string[] } {
  const tools: ToolSet = {};
  const missing: string[] = [];
  for (const key of keys) {
    if (all[key]) tools[key] = all[key];
    else missing.push(key);
  }
  return { tools, missing };
}
