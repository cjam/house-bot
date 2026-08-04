import {
  generateText,
  stepCountIs,
  type LanguageModel,
  type ModelMessage,
  type ToolSet,
  type UserContent,
} from "ai";

export type AskParams = {
  /** Prior conversation for this chat (empty for a fresh session). */
  messages: ModelMessage[];
  /** The new user message to answer. */
  prompt: string;
  systemPrompt: string;
  model: LanguageModel;
  tools: ToolSet;
  /** Max steps in the agentic tool loop before the run stops. */
  maxSteps: number;
  /**
   * Optional image attachments for a vision turn (e.g. a photo of a recipe).
   * Sent to the model alongside the prompt; requires a vision-capable model.
   * Not kept verbatim in history — see the note on persistence below.
   */
  images?: { data: Uint8Array; mediaType: string }[];
};

export type AskResult = {
  /** Full updated history to persist (prior + this user turn + the model's reply). */
  messages: ModelMessage[];
  /** The assistant's text reply. */
  text: string;
  /**
   * True when the tool loop stopped at the `maxSteps` cap with the model still
   * mid-tool-use (finishReason "tool-calls") — i.e. the turn was cut off before a
   * final answer. The caller can surface this instead of sending an empty reply.
   */
  truncated?: boolean;
  /** Token usage for the turn, passed through from the SDK (shape is provider-defined). */
  usage?: unknown;
  /** How many steps the tool loop took. */
  steps?: number;
  /** Every tool the model called this turn, in order. */
  toolCalls?: { name: string; args: unknown }[];
};

/**
 * One agentic turn on the Vercel AI SDK. The SDK is stateless, so we thread the
 * conversation through explicitly: append the user message, run the tool loop,
 * and return the full message array for the caller to persist — plus usage and
 * tool-call telemetry for the transcript log.
 */
export async function ask(params: AskParams): Promise<AskResult> {
  const hasImages = !!params.images?.length;
  // A vision turn sends the prompt text plus each image as content parts; a plain
  // turn is just the string.
  const userContent: UserContent = hasImages
    ? [
        ...(params.prompt ? [{ type: "text" as const, text: params.prompt }] : []),
        // A "file" part with an image/* mediaType is the current form; the older
        // "image" part is deprecated in the AI SDK.
        ...params.images!.map((img) => ({ type: "file" as const, data: img.data, mediaType: img.mediaType })),
      ]
    : params.prompt;
  const sent: ModelMessage[] = [...params.messages, { role: "user", content: userContent }];

  const result = await generateText({
    model: params.model,
    system: params.systemPrompt,
    messages: sent,
    tools: params.tools,
    stopWhen: stepCountIs(params.maxSteps),
  });

  const steps = (result.steps ?? []) as any[];
  const toolCalls = steps.flatMap((step) =>
    (step.toolCalls ?? []).map((tc: any) => ({ name: tc.toolName, args: tc.input ?? tc.args })),
  );

  // finishReason "tool-calls" out of generateText means the loop stopped while the
  // model still wanted to call tools — only possible when our stepCountIs cap cut
  // it off. On a truncated turn keep the (possibly empty) partial text so the
  // caller can add its own notice; otherwise fall back to the placeholder.
  const truncated = result.finishReason === "tool-calls";

  // Persist a text-only version of a vision turn: raw image bytes don't round-trip
  // through the JSON session store and would bloat every later turn. The model's
  // reply already captured what the image contained, so a short note is enough.
  const persistedUser: ModelMessage = {
    role: "user",
    content: hasImages
      ? [params.prompt, `[${params.images!.length} photo(s) attached]`].filter(Boolean).join(" ")
      : params.prompt,
  };

  return {
    messages: [...params.messages, persistedUser, ...result.response.messages],
    text: result.text || (truncated ? "" : "(no response)"),
    truncated,
    usage: result.usage,
    steps: steps.length || 1,
    toolCalls,
  };
}
