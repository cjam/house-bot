import { generateText, stepCountIs, type LanguageModel, type ModelMessage, type ToolSet } from "ai";

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
};

export type AskResult = {
  /** Full updated history to persist (prior + this user turn + the model's reply). */
  messages: ModelMessage[];
  /** The assistant's text reply. */
  text: string;
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
  const sent: ModelMessage[] = [...params.messages, { role: "user", content: params.prompt }];

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

  return {
    messages: [...sent, ...result.response.messages],
    text: result.text || "(no response)",
    usage: result.usage,
    steps: steps.length || 1,
    toolCalls,
  };
}
