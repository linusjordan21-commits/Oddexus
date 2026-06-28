import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("appUsers persistent storage paths", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mb-users-test-"));
  const persistentDir = path.join(tmpRoot, "persistent-users");

  beforeEach(() => {
    vi.resetModules();
    fs.mkdirSync(persistentDir, { recursive: true });
    vi.stubEnv("APP_USERS_DATA_DIR", persistentDir);
    vi.stubEnv("APP_USERS_FILE", "");
    vi.stubEnv("RENDER", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("uses APP_USERS_DATA_DIR/users.json when env is set", async () => {
    const mod = await import("./appUsers");
    expect(mod.resolveUsersFilePath()).toBe(path.join(persistentDir, "users.json"));
  });

  it("falls back to data/users.json without env", async () => {
    vi.unstubAllEnvs();
    vi.resetModules();
    const mod = await import("./appUsers");
    expect(mod.resolveUsersFilePath()).toBe(path.resolve(process.cwd(), "data", "users.json"));
  });

  it("creates users file under env path on init", async () => {
    const mod = await import("./appUsers");
    mod.initAppUsersStorage();
    const target = path.join(persistentDir, "users.json");
    expect(fs.existsSync(target)).toBe(true);
    const result = mod.createAppUser({ username: "diskuser", password: "TestPass123!" });
    expect("error" in result).toBe(false);
    expect(mod.listAppUsers().some((u) => u.username === "diskuser")).toBe(true);
    expect(fs.existsSync(target)).toBe(true);
  });
});

describe("storageHealth", () => {
  it("returns combined health payload shape", async () => {
    const mod = await import("./storageHealth");
    const health = mod.getStorageHealth();
    expect(health.ok).toBe(true);
    expect(typeof health.users_path).toBe("string");
    expect(typeof health.licenses_path).toBe("string");
    expect(typeof health.download_path).toBe("string");
    expect(typeof health.users_count).toBe("number");
    expect(typeof health.license_count).toBe("number");
  });
});

describe("persistentStorage migration", () => {
  it("copies legacy file when target is missing", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mb-migrate-"));
    const legacy = path.join(tmp, "legacy.json");
    const target = path.join(tmp, "nested", "target.json");
    fs.writeFileSync(legacy, '[{"id":"1"}]');
    const { migrateLegacyJsonIfMissing } = await import("./persistentStorage");
    migrateLegacyJsonIfMissing(target, legacy, "test migration");
    expect(fs.existsSync(target)).toBe(true);
    expect(fs.readFileSync(target, "utf-8")).toBe('[{"id":"1"}]');
    expect(fs.existsSync(legacy)).toBe(true);
  });
});
