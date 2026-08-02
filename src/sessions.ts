import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { ModelMessage } from "ai";

export type SessionStore = {
  load(): Promise<void>;
  /** Returns the chat's message history, or undefined if unknown or idle-expired. */
  get(chatId: number, now?: number): ModelMessage[] | undefined;
  /** The live session's id, or undefined if none or idle-expired. */
  sessionId(chatId: number, now?: number): string | undefined;
  /** Persists the turn; returns the session id it belongs to (new after an idle gap). */
  set(chatId: number, messages: ModelMessage[], now?: number): Promise<string>;
  clear(chatId: number): Promise<void>;
};

/**
 * A session id that embeds its UTC start time (for readable transcript filenames
 * like `20260802-183000-a1b2.jsonl`) plus a short random suffix for uniqueness.
 */
export function newSessionId(now: number = Date.now()): string {
  const d = new Date(now);
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp =
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
  return `${stamp}-${randomUUID().slice(0, 4)}`;
}

type SessionRecord = { sessionId: string; messages: ModelMessage[]; lastMessageAt: number };

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
          const record = value as SessionRecord;
          // Backfill an id for records written before sessions were ided.
          if (typeof record.sessionId !== "string") {
            record.sessionId = newSessionId(record.lastMessageAt);
          }
          sessions.set(Number(chatId), record);
        }
      }
    },

    get(chatId, now = Date.now()) {
      const record = sessions.get(chatId);
      if (!record) return undefined;
      if (now - record.lastMessageAt > idleMs) return undefined;
      return record.messages;
    },

    sessionId(chatId, now = Date.now()) {
      const record = sessions.get(chatId);
      if (!record) return undefined;
      if (now - record.lastMessageAt > idleMs) return undefined;
      return record.sessionId;
    },

    async set(chatId, messages, now = Date.now()) {
      // Keep the current session id while the chat is active; mint a new one when
      // the previous turn was over idleMs ago (a fresh session) or there is none.
      const existing = sessions.get(chatId);
      const continuing = existing !== undefined && now - existing.lastMessageAt <= idleMs;
      const sessionId = continuing ? existing.sessionId : newSessionId(now);
      sessions.set(chatId, { sessionId, messages, lastMessageAt: now });
      await persist();
      return sessionId;
    },

    async clear(chatId) {
      if (!sessions.has(chatId)) return;
      sessions.delete(chatId);
      await persist();
    },
  };
}
