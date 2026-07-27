import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ModelMessage } from "ai";

export type SessionStore = {
  load(): Promise<void>;
  /** Returns the chat's message history, or undefined if unknown or idle-expired. */
  get(chatId: number, now?: number): ModelMessage[] | undefined;
  set(chatId: number, messages: ModelMessage[], now?: number): Promise<void>;
  clear(chatId: number): Promise<void>;
};

type SessionRecord = { messages: ModelMessage[]; lastMessageAt: number };

/**
 * Persists chat_id -> conversation history (the AI SDK is stateless, so we own
 * the message array), and starts a new session for a chat once `idleMs` has
 * passed since its last message — an old conversation resuming out of the blue
 * is usually more confusing than a fresh start.
 */
export function createSessionStore(filePath: string, idleMs: number): SessionStore {
  const sessions = new Map<number, SessionRecord>();

  async function persist(): Promise<void> {
    const dir = dirname(filePath);
    await mkdir(dir, { recursive: true });
    const data: Record<string, SessionRecord> = {};
    for (const [chatId, record] of sessions) {
      data[String(chatId)] = record;
    }
    const tmpPath = `${filePath}.tmp`;
    await writeFile(tmpPath, JSON.stringify(data, null, 2));
    await rename(tmpPath, filePath);
  }

  return {
    async load() {
      let raw: string;
      try {
        raw = await readFile(filePath, "utf8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
        throw err;
      }
      const data = JSON.parse(raw) as Record<string, unknown>;
      for (const [chatId, value] of Object.entries(data)) {
        // Only load records in the current message-history format. The old
        // Claude-SDK format stored a session id (a bare string, or a record
        // with `sessionId`) that can't be translated to messages — skip those,
        // starting those chats fresh on their next message.
        if (
          typeof value === "object" &&
          value !== null &&
          Array.isArray((value as SessionRecord).messages)
        ) {
          sessions.set(Number(chatId), value as SessionRecord);
        }
      }
    },

    get(chatId, now = Date.now()) {
      const record = sessions.get(chatId);
      if (!record) return undefined;
      if (now - record.lastMessageAt > idleMs) return undefined;
      return record.messages;
    },

    async set(chatId, messages, now = Date.now()) {
      sessions.set(chatId, { messages, lastMessageAt: now });
      await persist();
    },

    async clear(chatId) {
      if (!sessions.has(chatId)) return;
      sessions.delete(chatId);
      await persist();
    },
  };
}
