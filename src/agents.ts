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
 * find and inspect recipes, run the recipe-cleanup workflow, import recipes, and
 * manage the shopping list. Recipe *creation/import* stays here for now; once the
 * recipe sub-agent lands it moves there and this list tightens. Keys are the
 * resolved (namespaced) tool names; any not present on the connected server are
 * skipped with a log line, so a Mealie version mismatch degrades gracefully.
 */
export const PLANNER_MCP_TOOLS = [
  // Meal plan
  "mealie_get_mealplans",
  "mealie_replace_week_meal_plan",
  "mealie_get_todays_meals_api_households_mealplans_today_get",
  // Recipes — find & inspect
  "mealie_get_all_recipes",
  "mealie_get_all_api_recipes_get",
  "mealie_get_recipes_detail",
  "mealie_suggest_recipes_by_name",
  // Recipes — create & import
  "mealie_create_recipe",
  "mealie_import_and_cleanup_recipe",
  "mealie_enrich_recipe",
  "mealie_get_import_queue_report",
  "mealie_apply_import_queue",
  // Recipes — cleanup workflow
  "mealie_get_recipes_needing_cleanup",
  "mealie_cleanup_recipe",
  "mealie_fix_ingredient",
  "mealie_link_recipe_steps",
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
