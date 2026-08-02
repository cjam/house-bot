import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDeployStore } from "./deploy-state";

function tempPath(name = "deploy.json"): string {
  return join(mkdtempSync(join(tmpdir(), "house-bot-deploy-")), name);
}

describe("createDeployStore", () => {
  test("get is undefined before anything is stored", async () => {
    const store = createDeployStore(tempPath());
    await store.load();
    expect(store.get()).toBeUndefined();
  });

  test("set then get returns the version, and it survives a reload", async () => {
    const path = tempPath();
    const store = createDeployStore(path);
    await store.load();
    await store.set("0.2.0");
    expect(store.get()).toBe("0.2.0");

    const reloaded = createDeployStore(path);
    await reloaded.load();
    expect(reloaded.get()).toBe("0.2.0");
  });

  test("a missing file loads as undefined (no throw)", async () => {
    const store = createDeployStore(join(tmpdir(), "definitely-missing-house-bot-deploy.json"));
    await store.load();
    expect(store.get()).toBeUndefined();
  });

  test("a corrupt marker is tolerated as 'never announced'", async () => {
    const path = tempPath();
    writeFileSync(path, "not json{");
    const store = createDeployStore(path);
    await store.load();
    expect(store.get()).toBeUndefined();
  });
});
