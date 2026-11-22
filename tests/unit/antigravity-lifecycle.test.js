// Verifies the Antigravity client-lifecycle emulation.
// Reference traffic: offline capture of `agy` 1.5.14 through a local CONNECT
// recorder (2026-11-23). Every metadata call is HTTP/1.1 with the captured body.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const wireCalls = [];

const antigravityPostJson = vi.fn(async (url, opts = {}) => {
  wireCalls.push({ url, opts });
  return { ok: true, status: 200, json: {}, text: "{}" };
});

const antigravityFetch = vi.fn(async (url, options = {}) => {
  wireCalls.push({ url, opts: { options } });
  return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
});

vi.mock("../../open-sse/utils/antigravityWire.js", () => ({
  antigravityPostJson,
  antigravityFetch,
  buildAntigravityHeaders: () => [],
  buildAntigravityHeaderObject: () => ({}),
  isAntigravityHost: () => true,
  sendWireRequest: vi.fn(),
  resetAntigravityWire: vi.fn(),
}));

const {
  ensureAntigravitySession,
  registerAntigravityTrajectory,
  resetAntigravityLifecycle,
  PREFLIGHT_TTL_MS,
} = await import("../../open-sse/services/antigravityLifecycle.js");

const { AntigravityExecutor } = await import("../../open-sse/executors/antigravity.js");

const DAILY = "https://daily-cloudcode-pa.googleapis.com/v1internal";
const TRAJECTORY = "7d1a0f10-5ac5-4725-95f0-79ea3003d12d";

function callsFor(suffix) {
  return wireCalls.filter(({ url }) => url === `${DAILY}:${suffix}`);
}

function resetWireMocks() {
  antigravityPostJson.mockReset();
  antigravityPostJson.mockImplementation(async (url, opts = {}) => {
    wireCalls.push({ url, opts });
    return { ok: true, status: 200, json: {}, text: "{}" };
  });
  antigravityFetch.mockReset();
  antigravityFetch.mockImplementation(async (url, options = {}) => {
    wireCalls.push({ url, opts: { options } });
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  });
}

describe("antigravity client lifecycle", () => {
  beforeEach(() => {
    wireCalls.length = 0;
    resetWireMocks();
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
      expect(call.opts.body).toEqual({ project: "aicode-consumers" });
      expect(call.opts.token).toBe("tok");
    }

    expect(wireCalls.map(({ url }) => url)).toContain("https://aicode.googleapis.com/v1alpha:fetchConfig");
    expect(antigravityFetch.mock.calls[0][1].method).toBe("GET");
  });

  it("does not repeat the preflight inside the TTL window", async () => {
    const opts = { connectionId: "conn-1", accessToken: "tok", projectId: "aicode-consumers" };
    await ensureAntigravitySession(opts);
    const first = wireCalls.length;
    wireCalls.length = 0;

    const second = await ensureAntigravitySession(opts);
    expect(second.skipped).toBe(true);
    expect(wireCalls.length).toBe(0);
    expect(first).toBe(4);
  });

  it("re-runs the preflight once the TTL expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-23T00:00:00.000Z"));
    const opts = { connectionId: "conn-2", accessToken: "tok", projectId: "aicode-consumers" };

    await ensureAntigravitySession(opts);
    wireCalls.length = 0;
    vi.setSystemTime(new Date(Date.now() + PREFLIGHT_TTL_MS + 1));
    await ensureAntigravitySession(opts);

    expect(callsFor("listExperiments").length).toBe(1);
  });

  it("registers a trajectory before the turn and dedupes it", async () => {
    const opts = { connectionId: "conn-1", accessToken: "tok", trajectoryId: TRAJECTORY };

    const first = await registerAntigravityTrajectory(opts);
    expect(first.ran).toBe(true);

    const [call] = callsFor("writeTrajectoryAcls");
    expect(call.opts.body).toEqual({ trajectoryId: TRAJECTORY });

    wireCalls.length = 0;
    const second = await registerAntigravityTrajectory(opts);
    expect(second.skipped).toBe(true);
    expect(wireCalls.length).toBe(0);
  });

  it("skips ids that are not trajectories", async () => {
    const result = await registerAntigravityTrajectory({
      connectionId: "conn-1",
      accessToken: "tok",
      trajectoryId: "not-a-uuid",
    });
    expect(result.skipped).toBe(true);
    expect(wireCalls.length).toBe(0);
  });

  it("fails open when upstream rejects the registration", async () => {
    antigravityPostJson.mockRejectedValueOnce(new Error("upstream down"));
    await expect(registerAntigravityTrajectory({
      connectionId: "conn-9",
      accessToken: "tok",
      trajectoryId: TRAJECTORY,
    })).resolves.toMatchObject({ ran: true });
  });

  it("never lets a hanging preflight block the turn", async () => {
    vi.useFakeTimers();
    antigravityPostJson.mockImplementation((url) => {
      if (url.endsWith(":writeTrajectoryAcls")) {
        return Promise.resolve({ ok: true, status: 200, json: {}, text: "{}" });
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
    expect(antigravityPostJson.mock.calls.filter(([url]) => url.endsWith(":writeTrajectoryAcls")).length).toBe(1);
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
    expect(call.opts.body).toEqual({ trajectoryId: TRAJECTORY });
  });

  it("runs the lifecycle through the base executor path", async () => {
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
    expect(antigravityFetch).toHaveBeenCalled();
  });

  it("caps trajectory registrations per account per minute", async () => {
    const uuid = (i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
    let posted = 0;
    antigravityPostJson.mockImplementation(async (url) => {
      if (url.endsWith(":writeTrajectoryAcls")) posted++;
      return { ok: true, status: 200, json: {}, text: "{}" };
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
