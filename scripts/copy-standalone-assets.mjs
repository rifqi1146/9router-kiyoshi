import { chmodSync, cpSync, existsSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

function resolveGoBinary() {
  try {
    execFileSync("go", ["version"], { stdio: "ignore" });
    return "go";
  } catch {
    if (process.platform !== "win32" && existsSync("/usr/local/go/bin/go")) {
      return "/usr/local/go/bin/go";
    }
    return null;
  }
}
export function copyStandaloneAssets({ projectRoot = process.cwd(), distDir = process.env.NEXT_DIST_DIR || ".next" } = {}) {
  if (process.env.NEXT_TRACING_ROOT_MODE === "workspace") {
    console.log("[standalone-assets] Skipping workspace-traced CLI build; CLI packaging handles assets");
    return;
  }

  const buildDir = resolve(projectRoot, distDir);
  const standaloneDir = resolve(buildDir, "standalone");

  if (!existsSync(standaloneDir)) {
    console.log(`[standalone-assets] No standalone build found at ${standaloneDir}`);
    return;
  }

  const staticSource = resolve(buildDir, "static");
  const staticDestination = resolve(standaloneDir, distDir, "static");
  if (existsSync(staticSource)) {
    cpSync(staticSource, staticDestination, { recursive: true, force: true });
    console.log(`[standalone-assets] Copied static assets to ${staticDestination}`);
  }

  const publicSource = resolve(projectRoot, "public");
  const publicDestination = resolve(standaloneDir, "public");
  if (existsSync(publicSource)) {
    cpSync(publicSource, publicDestination, { recursive: true, force: true });
    console.log(`[standalone-assets] Copied public assets to ${publicDestination}`);
  }

  // Without it beside server.js the standalone build serves requests unsanitized.
  const serverWrapperSource = resolve(projectRoot, "custom-server.js");
  const serverWrapperDestination = resolve(standaloneDir, "custom-server.js");
  if (existsSync(serverWrapperSource)) {
    cpSync(serverWrapperSource, serverWrapperDestination, { force: true });
    console.log(`[standalone-assets] Copied custom-server.js to ${serverWrapperDestination}`);
  }

  for (const rel of [
    "open-sse/config/agy-fingerprint.default.json",
    "src/mitm/paths.js",
    "src/mitm/cert/generate.js",
    "src/mitm/cert/rootCA.js",
  ]) {
    const src = resolve(projectRoot, rel);
    const dst = resolve(standaloneDir, rel);
    if (existsSync(src)) {
      mkdirSync(dirname(dst), { recursive: true });
      cpSync(src, dst, { force: true });
    }
  }

  const agwireName = process.platform === "win32" ? "agwire.exe" : "agwire";
  const agwireDir = resolve(projectRoot, "go", "agwire");
  const agwireSrc = resolve(projectRoot, "go", "bin", agwireName);
  const agwireDest = resolve(standaloneDir, "bin", agwireName);
  const goBin = resolveGoBinary();
  if (goBin && existsSync(resolve(agwireDir, "go.mod"))) {
    try {
      mkdirSync(dirname(agwireSrc), { recursive: true });
      execFileSync(goBin, ["build", "-trimpath", "-ldflags=-s -w", "-o", agwireSrc, "."], {
        cwd: agwireDir,
        env: { ...process.env, CGO_ENABLED: "0" },
        stdio: "inherit",
      });
    } catch (err) {
      console.warn(`[standalone-assets] agwire build failed (${err.message}) — ${existsSync(agwireSrc) ? "using existing binary" : "skipping"}`);
    }
  }
  if (existsSync(agwireSrc)) {
    mkdirSync(dirname(agwireDest), { recursive: true });
    cpSync(agwireSrc, agwireDest, { force: true });
    if (process.platform !== "win32") {
      chmodSync(agwireDest, 0o755);
    }
    console.log(`[standalone-assets] Copied ${agwireName} to ${agwireDest}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(dirname(fileURLToPath(import.meta.url)), "copy-standalone-assets.mjs")) {
  copyStandaloneAssets();
}
