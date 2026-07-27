// Function/tool names are capped at 64 characters across the major providers
// (they must match ^[a-zA-Z0-9_-]{1,64}$). MCP servers like Mealie auto-name
// tools from long FastAPI operation IDs, so once we namespace them per server
// (`<server>_<tool>`) they routinely exceed the limit and get the whole request
// rejected. These pure helpers shorten a name to fit while staying unique.

export const MAX_TOOL_NAME_LENGTH = 64;
const HASH_LENGTH = 6;

/** djb2 string hash, rendered in base36 — short, portable, deterministic. */
function djb2(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash + input.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36);
}

/**
 * Return a tool name that fits within `budget` characters and is unique among
 * `taken`. Names that already fit pass through unchanged; longer ones are
 * truncated and suffixed with a short deterministic hash of the *original*
 * name, so two different originals never collapse to the same short name.
 * `taken` is mutated to record the returned name.
 */
export function shortenToolName(original: string, budget: number, taken: Set<string>): string {
  if (original.length <= budget && !taken.has(original)) {
    taken.add(original);
    return original;
  }

  const hash = djb2(original).slice(0, HASH_LENGTH);
  const truncate = (extra: number) =>
    `${original.slice(0, Math.max(1, budget - hash.length - 1 - extra))}_${hash}${
      extra > 0 ? (extra - 1).toString(36) : ""
    }`;

  let name = truncate(0);
  // Truncation collisions are extremely unlikely given the per-original hash,
  // but disambiguate deterministically if one occurs anyway.
  for (let salt = 1; taken.has(name); salt++) {
    name = truncate(salt);
  }
  taken.add(name);
  return name;
}
