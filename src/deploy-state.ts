import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Tiny persisted marker for the last release version the bot announced. Lives in
 * the data volume (which survives container restarts/redeploys), so on startup
 * the bot can tell a version bump from an ordinary restart. Same atomic-write,
 * load-on-boot shape as the other stores.
 */
export type DeployStore = {
  load(): Promise<void>;
  /** The last version we announced, or undefined if we never have. */
  get(): string | undefined;
  set(version: string): Promise<void>;
};

export function createDeployStore(filePath: string): DeployStore {
  let version: string | undefined;

  return {
    async load() {
      let raw: string;
      try {
        raw = await readFile(filePath, "utf8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
        throw err;
      }
      try {
        const data = JSON.parse(raw) as { version?: unknown };
        if (typeof data.version === "string") version = data.version;
      } catch {
        // A corrupt marker just means "announce as if fresh"; don't crash boot.
      }
    },

    get() {
      return version;
    },

    async set(v) {
      version = v;
      await mkdir(dirname(filePath), { recursive: true });
      const tmpPath = `${filePath}.tmp`;
      await writeFile(tmpPath, JSON.stringify({ version: v }, null, 2));
      await rename(tmpPath, filePath);
    },
  };
}
