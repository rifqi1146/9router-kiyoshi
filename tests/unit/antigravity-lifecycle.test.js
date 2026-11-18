// Verifies the Antigravity client-lifecycle emulation added 2026-11-16.
// Reference traffic: live TLS capture of the official CLI `agy` 1.5.9.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const proxyAwareFetch = vi.fn(async () => ({
  ok: true,
  status: 200,
  arrayBuffer: async () => new ArrayBuffer(0),
}));

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch }));

const {
  ensureAntigravitySession,
  registerAntigravityTrajectory,
  resetAntigravityLifecycle,
  PREFLIGHT_TTL_MS,
} = await import("../../open-sse/services/antigravityLifecycle.js");

const { AntigravityExecutor } = await import("../../open-sse/executors/antigravity.js");

const DAILY = "https://daily-cloudcode-pa.googleapis.com/v1internal";
const TRAJECTORY = "7d1a0f10-5ac5-4725-95f0-79ea3003d12d";

function urlsCalled() {
  return proxyAwareFetch.mock.calls.map(([url]) => url);
}

function callsFor(suffix) {
  return proxyAwareFetch.mock.calls.filter(([url]) => url === `${DAILY}:${suffix}`);
}

describe("antigravity client lifecycle", () => {
  beforeEach(() => {
    proxyAwareFetch.mockClear();
    resetAntigravityLifecycle();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs the real client preflight with the captured bodies", async () => {
    await ensureAntigravitySession({
      connectionId: "conn-1",
      accessToken: "tok",
      projectId: "aicode-consumers",
    });

    for (const endpoint of ["listExperiments", "fetchAdminControls", "fetchUserInfo"]) {
      const [call] = callsFor(endpoint);
      expect(call, endpoint).toBeTruthy();
      expect(JSON.parse(call[1].body)).toEqual({ project: "aicode-consumers" });
      expect(call[1].headers["User-Agent"]).toMatch(/^antigravity\/cli\/1\.5\.11 \(aidev_client;/);
      expect(call[1].headers["Authorization"]).toBe("Bearer tok");
    }

    expect(urlsCalled()).toContain("https://aicode.googleapis.com/v1alpha:fetchConfig");
  });

  it("does not repeat the preflight inside the TTL window", async () => {
    const opts = { connectionId: "conn-1", accessToken: "tok", projectId: "aicode-consumers" };
    await ensureAntigravitySession(opts);
    const first = proxyAwareFetch.mock.calls.length;
    proxyAwareFetch.mockClear();

    const second = await ensureAntigravitySession(opts);
    expect(second.skipped).toBe(true);
    expect(proxyAwareFetch.mock.calls.length).toBe(0);
    expect(first).toBe(4);
  });

  it("re-runs the preflight once the TTL expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-16T00:00:00.000Z"));
    const opts = { connectionId: "conn-2", accessToken: "tok", projectId: "aicode-consumers" };

    await ensureAntigravitySession(opts);
    proxyAwareFetch.mockClear();
    vi.setSystemTime(new Date(Date.now() + PREFLIGHT_TTL_MS + 1));
    await ensureAntigravitySession(opts);

    expect(callsFor("listExperiments").length).toBe(1);
  });

  it("registers a trajectory before the turn and dedupes it", async () => {
    const opts = { connectionId: "conn-1", accessToken: "tok", trajectoryId: TRAJECTORY };

    const first = await registerAntigravityTrajectory(opts);
    expect(first.ran).toBe(true);

    const [call] = callsFor("writeTrajectoryAcls");
    expect(JSON.parse(call[1].body)).toEqual({ trajectoryId: TRAJECTORY });

    proxyAwareFetch.mockClear();
    const second = await registerAntigravityTrajectory(opts);
    expect(second.skipped).toBe(true);
    expect(proxyAwareFetch.mock.calls.length).toBe(0);
  });

  it("skips ids that are not trajectories", async () => {
    const result = await registerAntigravityTrajectory({
      connectionId: "conn-1",
      accessToken: "tok",
      trajectoryId: "not-a-uuid",
    });
    expect(result.skipped).toBe(true);
    expect(proxyAwareFetch.mock.calls.length).toBe(0);
  });

  it("fails open when upstream rejects the registration", async () => {
    proxyAwareFetch.mockRejectedValueOnce(new Error("upstream down"));
    await expect(registerAntigravityTrajectory({
      connectionId: "conn-9",
      accessToken: "tok",
      trajectoryId: TRAJECTORY,
    })).resolves.toMatchObject({ ran: true });
  });

  it("never lets a hanging preflight block the turn", async () => {
    vi.useFakeTimers();
    proxyAwareFetch.mockImplementation((url) => {
      if (url.endsWith(":writeTrajectoryAcls")) {
        return Promise.resolve({ status: 200, arrayBuffer: async () => new ArrayBuffer(0) });
      }
      return new Promise(() => {}); // preflight never answers
    });

    const ag = new AntigravityExecutor();
    ag._lastRequestId = `agent/conv-2/1794629692000/${TRAJECTORY}/1`;

    const turn = ag.beforeExecute({
      credentials: { connectionId: "conn-hang", accessToken: "tok", projectId: "aicode-consumers" },
      proxyOptions: null,
      log: null,
    });
    await vi.advanceTimersByTimeAsync(1_600);
    await expect(turn).resolves.toBeUndefined();
    expect(callsFor("writeTrajectoryAcls").length).toBe(1);
  });

  it("wires the executor hook to the trajectory inside requestId", async () => {
    const ag = new AntigravityExecutor();
    ag._lastRequestId = `agent/conv-1/1794629692000/${TRAJECTORY}/3`;

    await ag.beforeExecute({
      credentials: { connectionId: "conn-1", accessToken: "tok", projectId: "aicode-consumers" },
      proxyOptions: null,
      log: null,
    });

    const [call] = callsFor("writeTrajectoryAcls");
    expect(call).toBeTruthy();
    expect(JSON.parse(call[1].body)).toEqual({ trajectoryId: TRAJECTORY });
  });

  it("runs the lifecycle through the base executor path", async () => {
    proxyAwareFetch.mockImplementation(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      arrayBuffer: async () => new ArrayBuffer(0),
    }));

    const ag = new AntigravityExecutor();
    await ag.execute({
      model: "gemini-3.8-flash-high",
      body: { model: "gemini-3.8-flash-high", request: { contents: [{ role: "user", parts: [{ text: "hi" }] }] } },
      stream: true,
      credentials: { accessToken: "tok", connectionId: "conn-e2e", projectId: "aicode-consumers" },
      log: null,
    });

    // Not just the hook in isolation: the base executor must call it before fetch.
    expect(callsFor("writeTrajectoryAcls").length).toBe(1);
    expect(callsFor("listExperiments").length).toBe(1);
  });

  it("caps trajectory registrations per account per minute", async () => {
    const uuid = (i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
    let posted = 0;
    proxyAwareFetch.mockImplementation(async (url) => {
      if (url.endsWith(":writeTrajectoryAcls")) posted++;
      return { status: 200, arrayBuffer: async () => new ArrayBuffer(0) };
    });

    for (let i = 0; i < 25; i++) {
      await registerAntigravityTrajectory({
        connectionId: "conn-rl",
        accessToken: "tok",
        trajectoryId: uuid(i),
      });
    }

    expect(posted).toBe(20);
  });
});
