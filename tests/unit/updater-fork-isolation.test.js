import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { copyStandaloneBuild } = require("../../cli/scripts/build-cli.js");

describe("fork updater isolation", () => {
  beforeEach(() => {
    if (global.__ghVersionCache) {
      global.__ghVersionCache.value = null;
      global.__ghVersionCache.fetchedAt = 0;
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (global.__ghVersionCache) {
      global.__ghVersionCache.value = null;
      global.__ghVersionCache.fetchedAt = 0;
    }
  });

  it("points UPDATER_CONFIG and GITHUB_CONFIG to rifqi1146/9router-kiyoshi", async () => {
    const { GITHUB_CONFIG, UPDATER_CONFIG } = await import("../../src/shared/constants/config.js");

    expect(UPDATER_CONFIG.ghRepo).toBe("rifqi1146/9router-kiyoshi");
    expect(UPDATER_CONFIG.ghAsset).toBe("9router-kiyoshi-latest.tgz");
    expect(UPDATER_CONFIG.ghUrl).toBe(
      "https://github.com/rifqi1146/9router-kiyoshi/releases/latest/download/9router-kiyoshi-latest.tgz"
    );
    expect(GITHUB_CONFIG.changelogUrl).toBe(
      "https://raw.githubusercontent.com/rifqi1146/9router-kiyoshi/main/CHANGELOG.md"
    );

    for (const platform of ["linux", "darwin", "win32"]) {
      const cmd = UPDATER_CONFIG.installCmdForPlatform(platform);
      expect(cmd).toContain("rifqi1146/9router-kiyoshi");
      expect(cmd).toContain("9router-kiyoshi-latest.tgz");
      expect(cmd).not.toContain("Azhar457/9router");
      expect(cmd).not.toContain("9router-plinian-latest.tgz");
    }
  });

  it("queries rifqi1146/9router-kiyoshi in /api/version and treats v0.6.900-kiyoshi as up to date", async () => {
    const requestedUrls = [];
    vi.spyOn(https, "get").mockImplementation((url, _opts, cb) => {
      requestedUrls.push(url);
      const res = new EventEmitter();
      queueMicrotask(() => {
        res.emit("data", JSON.stringify({ tag_name: "v0.6.900-kiyoshi" }));
        res.emit("end");
      });
      cb(res);
      return { on: vi.fn(), destroy: vi.fn() };
    });

    const { GET } = await import("../../src/app/api/version/route.js");
    const response = await GET();
    const body = await response.json();

    expect(requestedUrls).toEqual([
      "https://api.github.com/repos/rifqi1146/9router-kiyoshi/releases/latest",
    ]);
    expect(body.currentVersion).toBe("0.6.900");
    expect(body.latestVersion).toBe("0.6.900-kiyoshi");
    expect(body.hasUpdate).toBe(false);
  });

  it("flags hasUpdate when rifqi1146/9router-kiyoshi publishes a newer version", async () => {
    vi.spyOn(https, "get").mockImplementation((_url, _opts, cb) => {
      const res = new EventEmitter();
      queueMicrotask(() => {
        res.emit("data", JSON.stringify({ tag_name: "v0.6.901-kiyoshi" }));
        res.emit("end");
      });
      cb(res);
      return { on: vi.fn(), destroy: vi.fn() };
    });

    const { GET } = await import("../../src/app/api/version/route.js");
    const response = await GET();
    const body = await response.json();

    expect(body.latestVersion).toBe("0.6.901-kiyoshi");
    expect(body.hasUpdate).toBe(true);
  });

  it("excludes .build-home and .9router secrets/db when copying standalone CLI build", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "9r-cli-exclude-"));
    try {
      const appDir = path.join(root, "9router-kiyoshi");
      const distDir = path.join(appDir, ".next-cli-build");
      const standaloneApp = path.join(distDir, "standalone", "9router-kiyoshi");
      const cliAppDir = path.join(root, "cli-app");

      fs.mkdirSync(path.join(standaloneApp, "cli", ".build-home", ".9router", "db"), { recursive: true });
      fs.writeFileSync(path.join(standaloneApp, "server.js"), "console.log('ok');");
      fs.writeFileSync(path.join(standaloneApp, "cli", ".build-home", ".9router", "jwt-secret"), "secret");
      fs.writeFileSync(path.join(standaloneApp, "cli", ".build-home", ".9router", "db", "data.sqlite"), "sqlite");

      copyStandaloneBuild(appDir, distDir, cliAppDir);

      expect(fs.existsSync(path.join(cliAppDir, "server.js"))).toBe(true);
      expect(fs.existsSync(path.join(cliAppDir, "cli", ".build-home"))).toBe(false);
      expect(fs.existsSync(path.join(cliAppDir, "cli", ".build-home", ".9router", "jwt-secret"))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
