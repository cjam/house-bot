import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type SessionStore = {
  load(): Promise<void>;
  get(chatId: number): string | undefined;
  set(chatId: number, sessionId: string): Promise<void>;
  clear(chatId: number): Promise<void>;
};

export function createSessionStore(filePath: string): SessionStore {
  const sessions = new Map<number, string>();

  async function persist(): Promise<void> {
    const dir = dirname(filePath);
    await mkdir(dir, { recursive: true });
    const data: Record<string, string> = {};
    for (const [chatId, sessionId] of sessions) {
      data[String(chatId)] = sessionId;
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
      const data = JSON.parse(raw) as Record<string, string>;
      for (const [chatId, sessionId] of Object.entries(data)) {
        sessions.set(Number(chatId), sessionId);
      }
    },

    get(chatId) {
      return sessions.get(chatId);
    },

    async set(chatId, sessionId) {
      if (sessions.get(chatId) === sessionId) return;
      sessions.set(chatId, sessionId);
      await persist();
    },

    async clear(chatId) {
      if (!sessions.has(chatId)) return;
      sessions.delete(chatId);
      await persist();
    },
  };
}
