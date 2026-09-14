import { afterEach, beforeEach, expect, mock, test } from "bun:test";

const requests: unknown[] = [];
const activeDisposers: Array<() => void> = [];
const requestWaiters: Array<() => void> = [];
const stateWaiters: Array<() => void> = [];
let importCounter = 0;
let holdConnections = false;
let failConnections = false;
let acknowledgeConnections = true;
const connections: Array<() => void> = [];

mock.module("node:net", () => ({
  default: {
    createConnection(_path: string, onConnect: () => void) {
      const handlers = new Map<string, () => void>();
      const client = {
        destroyed: false,
        write(input: string) {
          if (client.destroyed) return;
          const request = JSON.parse(input.trim());
          requests.push(request);
          if (isRecord(request) && isRecord(request.params) && request.params.state !== undefined) {
            stateWaiters.shift()?.();
          }
          requestWaiters.shift()?.();
          if (acknowledgeConnections) queueMicrotask(() => client.emit("data"));
        },
        setTimeout() {},
        on(event: string, handler: () => void) {
          handlers.set(event, handler);
        },
        destroy() {
          client.destroyed = true;
        },
        emit(event: string) {
          handlers.get(event)?.();
        },
      };
      if (holdConnections) connections.push(onConnect);
      else if (failConnections) queueMicrotask(() => client.emit("error"));
      else queueMicrotask(onConnect);
      return client;
    },
  },
}));

beforeEach(() => {
  requests.length = 0;
  requestWaiters.length = 0;
  stateWaiters.length = 0;
  holdConnections = false;
  failConnections = false;
  acknowledgeConnections = true;
  connections.length = 0;
  process.env.HERDR_ENV = "1";
  process.env.HERDR_SOCKET_PATH = "test.sock";
  process.env.HERDR_PANE_ID = "test:p1";
});

afterEach(() => {
  for (const dispose of activeDisposers.splice(0)) {
    dispose();
  }
});

async function loadPlugin() {
  importCounter += 1;
  const module = await import(`./herdr-tui-session.js?test=${importCounter}`);
  return module.default;
}

function fakeApi() {
  const sessions = new Map<string, { id: string; parentID?: string }>();
  const stored = new Map<string, { id: string; parentID?: string }>();
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  const statuses: Record<string, { type: string }> = {};
  const permissions: Array<{ id: string; sessionID: string }> = [];
  const questions: Array<{ id: string; sessionID: string }> = [];
  const calls: string[] = [];
  let current: { name: string; params?: { sessionID: string } } = { name: "home" };
  let dispose: (() => void) | undefined;
  activeDisposers.push(() => dispose?.());

  return {
    statuses, permissions, questions, calls, listeners,
    api: {
      client: {
        session: {
          async get({ sessionID }: { sessionID: string }) {
            calls.push(`get:${sessionID}`);
            const data = stored.get(sessionID);
            if (!data) throw new Error("session not found");
            return { data };
          },
          async status() {
            calls.push("status");
            return { data: { ...statuses } };
          },
        },
        permission: {
          async list() { calls.push("permission"); return { data: [...permissions] }; },
        },
        question: {
          async list() { calls.push("question"); return { data: [...questions] }; },
        },
      },
      event: {
        on(type: string, handler: (event: unknown) => void) {
          if (!listeners.has(type)) listeners.set(type, new Set());
          listeners.get(type)!.add(handler);
          return () => { listeners.get(type)!.delete(handler); };
        },
      },
      route: {
        get current() {
          return current;
        },
      },
      state: {
        session: {
          get(sessionID: string) {
            return sessions.get(sessionID);
          },
        },
      },
      lifecycle: {
        onDispose(handler: () => void) {
          dispose = handler;
          return () => {};
        },
      },
    },
    addSession(session: { id: string; parentID?: string }, cached = true) {
      stored.set(session.id, session);
      if (cached) sessions.set(session.id, session);
    },
    emit(type: string, properties: Record<string, unknown> = {}) {
      for (const receive of listeners.get(type) ?? []) receive({ type, properties });
    },
    select(sessionID: string) {
      current = { name: "session", params: { sessionID } };
    },
    dispose() {
      dispose?.();
    },
  };
}

function waitForNextRequest(): Promise<void> {
  return new Promise((resolve) => requestWaiters.push(resolve));
}

function waitForStateReport(): Promise<void> {
  return new Promise((resolve) => stateWaiters.push(resolve));
}

test("reports a root session when only the local route changes", async () => {
  const plugin = await loadPlugin();
  const tui = fakeApi();
  tui.addSession({ id: "session-a" });
  await plugin.tui(tui.api);

  const dispatched = waitForNextRequest();
  tui.select("session-a");
  await dispatched;

  expect(requests).toHaveLength(1);
  expect(requestParam(requests[0], "agent_session_id")).toBe("session-a");
  expect(requestParam(requests[0], "session_start_source")).toBe("select");
  expect(requestParam(requests[0], "seq")).toBeUndefined();
});

test("retries an initial selection while Herdr detects the process", async () => {
  const plugin = await loadPlugin();
  const tui = fakeApi();
  tui.addSession({ id: "session-a" });
  tui.select("session-a");

  await plugin.tui(tui.api);
  await new Promise((resolve) => setTimeout(resolve, 125));

  expect(requests.filter((request) => requestParam(request, "session_start_source") === "select")
    .map((request) => requestParam(request, "agent_session_id"))).toEqual([
    "session-a",
    "session-a",
  ]);
});

test("does not report root sessions not selected by this TUI", async () => {
  const plugin = await loadPlugin();
  const tui = fakeApi();
  tui.addSession({ id: "session-a" });
  tui.addSession({ id: "session-b" });
  tui.select("session-a");
  await plugin.tui(tui.api);

  await new Promise((resolve) => setTimeout(resolve, 125));

  expect(requests.length).toBeGreaterThan(0);
  expect(requests.every((request) => requestParam(request, "agent_session_id") === "session-a")).toBe(
    true,
  );
});

test("does not replace the root session with a selected child session", async () => {
  const plugin = await loadPlugin();
  const tui = fakeApi();
  tui.addSession({ id: "root-session" });
  tui.addSession({ id: "child-session", parentID: "root-session" });
  tui.select("root-session");
  await plugin.tui(tui.api);
  await waitUntil(() => states().includes("idle"));

  tui.select("child-session");
  await new Promise((resolve) => setTimeout(resolve, 125));

  expect(requests.every((request) => requestParam(request, "agent_session_id") === "root-session")).toBe(true);
});

test("stops route polling when the TUI plugin is disposed", async () => {
  const plugin = await loadPlugin();
  const tui = fakeApi();
  tui.addSession({ id: "session-a" });
  await plugin.tui(tui.api);
  tui.dispose();
  tui.select("session-a");

  await new Promise((resolve) => setTimeout(resolve, 125));

  expect(requests).toHaveLength(0);
});

function requestParam(request: unknown, name: string): unknown {
  if (!isRecord(request) || !isRecord(request.params)) {
    return undefined;
  }
  return request.params[name];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function states() {
  return requests.map((request) => requestParam(request, "state")).filter((state) => state !== undefined);
}

async function waitUntil(predicate: () => boolean, timeout = 2_000) {
  const deadline = Date.now() + timeout;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(5);
  expect(predicate()).toBe(true);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function startV1() {
  const plugin = await loadPlugin();
  const tui = fakeApi();
  for (const session of [
    { id: "a" }, { id: "b" }, { id: "child", parentID: "a" },
    { id: "sibling", parentID: "a" }, { id: "grandchild", parentID: "child" },
    { id: "foreign", parentID: "b" },
  ]) tui.addSession(session);
  tui.select("a");
  await plugin.tui(tui.api);
  await waitUntil(() => states().includes("idle"));
  return tui;
}

test("V1 keeps an idle parent working until every active descendant finishes", async () => {
  const tui = await startV1();
  for (const sessionID of ["a", "child", "sibling", "grandchild"]) {
    tui.emit("session.status", { sessionID, status: { type: "busy" } });
  }
  await waitUntil(() => states().at(-1) === "working");
  for (const sessionID of ["a", "child", "sibling"]) {
    tui.emit("session.status", { sessionID, status: { type: "idle" } });
    tui.emit("session.idle", { sessionID });
  }
  tui.emit("session.status", { sessionID: "grandchild", status: { type: "retry" } });
  await Bun.sleep(30);
  expect(states().at(-1)).toBe("working");
  tui.emit("session.status", { sessionID: "grandchild", status: { type: "idle" } });
  await waitUntil(() => states().at(-1) === "idle");
  expect(requests.every((request) => requestParam(request, "agent_session_id") === "a")).toBe(true);
});

test("V1 child idle cannot finish a working root or count another root", async () => {
  const tui = await startV1();
  tui.emit("session.status", { sessionID: "a", status: { type: "busy" } });
  tui.emit("session.status", { sessionID: "child", status: { type: "idle" } });
  tui.emit("session.status", { sessionID: "foreign", status: { type: "busy" } });
  tui.emit("question.asked", { sessionID: "foreign", id: "foreign-question" });
  await waitUntil(() => states().at(-1) === "working");
  tui.emit("session.status", { sessionID: "a", status: { type: "idle" } });
  await waitUntil(() => states().at(-1) === "idle");
});

test("V1 retains sibling blockers and clears cancelled requests only for their owner", async () => {
  const tui = await startV1();
  tui.emit("session.status", { sessionID: "child", status: { type: "busy" } });
  tui.emit("permission.asked", { sessionID: "child", id: "p" });
  tui.emit("question.asked", { sessionID: "sibling", id: "q" });
  await waitUntil(() => states().at(-1) === "blocked");
  tui.emit("permission.replied", { sessionID: "child", requestID: "p" });
  tui.emit("session.status", { sessionID: "a", status: { type: "idle" } });
  await Bun.sleep(30);
  expect(states().at(-1)).toBe("blocked");
  tui.emit("session.error", { sessionID: "sibling", error: { name: "MessageAbortedError" } });
  tui.emit("session.status", { sessionID: "sibling", status: { type: "idle" } });
  await waitUntil(() => states().at(-1) === "working");
  tui.emit("session.status", { sessionID: "child", status: { type: "idle" } });
  await waitUntil(() => states().at(-1) === "idle");
});

test("V1 hydrates existing descendants and blockers without fetching historical trees", async () => {
  const plugin = await loadPlugin();
  const tui = fakeApi();
  tui.addSession({ id: "a" });
  tui.addSession({ id: "child", parentID: "a" }, false);
  tui.addSession({ id: "nested", parentID: "child" }, false);
  tui.statuses.nested = { type: "retry" };
  tui.questions.push({ id: "pending", sessionID: "nested" });
  tui.select("a");
  await plugin.tui(tui.api);
  await waitUntil(() => states().at(-1) === "blocked");
  expect(states()).not.toContain("idle");
  expect(tui.calls.filter((call) => call.startsWith("get:")).sort()).toEqual(["get:child", "get:nested"]);
  const calls = [...tui.calls];
  await Bun.sleep(250);
  expect(tui.calls).toEqual(calls);
  tui.emit("question.rejected", { sessionID: "nested", requestID: "pending" });
  await waitUntil(() => states().at(-1) === "working");
});

test("V1 does not report idle before hydration or overwrite events with a late snapshot", async () => {
  const plugin = await loadPlugin();
  const tui = fakeApi();
  const snapshot = deferred<{ data: Record<string, { type: string }> }>();
  tui.api.client.session.status = () => snapshot.promise;
  tui.addSession({ id: "a" });
  tui.addSession({ id: "child", parentID: "a" });
  tui.select("a");
  await plugin.tui(tui.api);
  await Bun.sleep(20);
  expect(states()).toEqual([]);
  tui.emit("session.status", { sessionID: "child", status: { type: "busy" } });
  await waitUntil(() => states().at(-1) === "working");
  snapshot.resolve({ data: {} });
  await Bun.sleep(30);
  expect(states()).not.toContain("idle");
});

test("V1 late hydration cannot revive a finished, replied, or deleted child", async () => {
  const plugin = await loadPlugin();
  const tui = fakeApi();
  const snapshot = deferred<{ data: Record<string, { type: string }> }>();
  tui.api.client.session.status = () => snapshot.promise;
  tui.addSession({ id: "a" });
  for (const id of ["child", "deleted"]) tui.addSession({ id, parentID: "a" });
  tui.permissions.push({ id: "p", sessionID: "child" });
  tui.questions.push({ id: "q", sessionID: "deleted" });
  tui.select("a");
  await plugin.tui(tui.api);
  tui.emit("permission.replied", { sessionID: "child", requestID: "p" });
  tui.emit("session.status", { sessionID: "child", status: { type: "idle" } });
  tui.emit("session.deleted", { info: { id: "deleted", parentID: "a" } });
  snapshot.resolve({ data: { child: { type: "busy" }, deleted: { type: "busy" } } });
  await waitUntil(() => states().at(-1) === "idle");
  expect(states()).not.toContain("blocked");
  expect(states()).not.toContain("working");
});

test("V1 retries unavailable hydration and unknown ancestry without assuming idle", async () => {
  const plugin = await loadPlugin();
  const tui = fakeApi();
  tui.addSession({ id: "a" });
  tui.statuses.child = { type: "busy" };
  const list = tui.api.client.question.list;
  tui.api.client.question.list = async () => { throw new Error("offline"); };
  tui.select("a");
  await plugin.tui(tui.api);
  await Bun.sleep(150);
  expect(states()).toEqual([]);
  tui.api.client.question.list = list;
  await Bun.sleep(550);
  expect(states()).toEqual([]);
  tui.addSession({ id: "child", parentID: "a" }, false);
  await waitUntil(() => states().at(-1) === "working");
});

test("V1 resnapshots on reconnection after missed completion", async () => {
  const tui = await startV1();
  tui.emit("session.status", { sessionID: "child", status: { type: "busy" } });
  await waitUntil(() => states().at(-1) === "working");
  tui.emit("server.connected");
  await waitUntil(() => states().at(-1) === "idle");
  expect(tui.calls.filter((call) => call === "status")).toHaveLength(2);
});

test("V1 rejects A/B/A stale hydration and connections and disposes listeners", async () => {
  const plugin = await loadPlugin();
  const tui = fakeApi();
  tui.addSession({ id: "a" });
  tui.addSession({ id: "b" });
  const oldSnapshot = deferred<{ data: Record<string, { type: string }> }>();
  const status = tui.api.client.session.status;
  tui.api.client.session.status = () => oldSnapshot.promise;
  holdConnections = true;
  tui.select("a");
  await plugin.tui(tui.api);
  await waitUntil(() => connections.length > 0);
  tui.select("b");
  await Bun.sleep(125);
  tui.api.client.session.status = status;
  tui.select("a");
  await Bun.sleep(125);
  oldSnapshot.resolve({ data: { a: { type: "busy" } } });
  holdConnections = false;
  for (const connect of connections.splice(0)) connect();
  await waitUntil(() => states().at(-1) === "idle");
  expect(states()).not.toContain("working");
  expect(requests.every((request) => requestParam(request, "agent_session_id") === "a")).toBe(true);
  holdConnections = true;
  tui.emit("session.status", { sessionID: "a", status: { type: "busy" } });
  await waitUntil(() => connections.length > 0);
  tui.dispose();
  const count = requests.length;
  for (const connect of connections.splice(0)) connect();
  await Bun.sleep(30);
  expect(requests).toHaveLength(count);
  expect([...tui.listeners.values()].every((listeners) => listeners.size === 0)).toBe(true);
});

test("V1 retries latest lifecycle after selection retries expire and keeps sequence order", async () => {
  const tui = await startV1();
  await Bun.sleep(1_800);
  failConnections = true;
  tui.emit("session.status", { sessionID: "child", status: { type: "busy" } });
  await Bun.sleep(50);
  failConnections = false;
  await waitUntil(() => states().at(-1) === "working");
  const seq = requests.map((request) => requestParam(request, "seq")).filter((value) => typeof value === "number") as number[];
  expect(seq.every((value, index) => index === 0 || value > seq[index - 1]!)).toBe(true);
  expect(requests.filter((request) => requestParam(request, "session_start_source") === "select")
    .every((request) => requestParam(request, "seq") === undefined)).toBe(true);
});

test("V1 deletion invalidates both ancestry completion and delayed socket writes", async () => {
  const plugin = await loadPlugin();
  const first = fakeApi();
  first.addSession({ id: "a" });
  first.select("a");
  const installing = plugin.tui(first.api);
  first.emit("session.deleted", { info: { id: "a" } });
  await installing;
  await Bun.sleep(30);
  expect(requests).toHaveLength(0);
  first.dispose();

  const tui = await startV1();
  holdConnections = true;
  tui.emit("session.status", { sessionID: "a", status: { type: "busy" } });
  await waitUntil(() => connections.length > 0);
  tui.emit("session.deleted", { info: { id: "a" } });
  const count = requests.length;
  for (const connect of connections.splice(0)) connect();
  await Bun.sleep(30);
  expect(requests).toHaveLength(count);
});

test("V1 resends working when a blocked report was applied but its acknowledgement was lost", async () => {
  const tui = await startV1();
  tui.emit("session.status", { sessionID: "child", status: { type: "busy" } });
  await waitUntil(() => states().at(-1) === "working");
  await Bun.sleep(1_800);
  acknowledgeConnections = false;
  tui.emit("permission.asked", { sessionID: "child", id: "p" });
  await waitUntil(() => states().at(-1) === "blocked");
  tui.emit("permission.replied", { sessionID: "child", requestID: "p" });
  acknowledgeConnections = true;
  await waitUntil(() => states().at(-1) === "working");
});

test("V1 waits for cyclic ancestry to be corrected and keeps root errors interruptible", async () => {
  const tui = await startV1();
  tui.emit("session.created", { info: { id: "x", parentID: "y" } });
  tui.emit("session.created", { info: { id: "y", parentID: "x" } });
  tui.emit("session.status", { sessionID: "x", status: { type: "busy" } });
  const count = states().length;
  await Bun.sleep(30);
  expect(states()).toHaveLength(count);
  tui.emit("session.updated", { info: { id: "y", parentID: "a" } });
  await waitUntil(() => states().at(-1) === "working");
  tui.emit("session.error", { sessionID: "a", error: { name: "APIError" } });
  await waitUntil(() => states().at(-1) === "blocked");
  tui.emit("session.status", { sessionID: "a", status: { type: "idle" } });
  await waitUntil(() => states().at(-1) === "working");
});

function v2Api() {
  const sessions = new Map([
    ["a", { id: "a" }],
    ["b", { id: "b" }],
    ["child", { id: "child", parentID: "a" }],
  ]);
  let route = { type: "session", sessionID: "a" };
  const listeners = new Set<(event: unknown) => void>();
  const permissions = new Map<string, Array<{ id: string }> | undefined>();
  const forms = new Map<string, Array<{ id: string }> | undefined>();
  return {
    api: {
      ui: { router: { current: () => route } },
      data: {
        session: {
          get: (id: string) => sessions.get(id),
          family: () => [...sessions.keys()],
          status: () => "idle",
          permission: { list: (id: string) => permissions.get(id) },
          form: { list: (id: string) => forms.get(id) },
        },
        listen: (handler: (event: unknown) => void) => {
          listeners.add(handler);
          return () => listeners.delete(handler);
        },
      },
    },
    select(sessionID: string) { route = { type: "session", sessionID }; },
    home() { route = { type: "home", sessionID: "" }; },
    emit(type: string, data?: object) {
      for (const listener of listeners) listener({ details: { type, data } });
    },
    listeners,
    sessions,
    permissions,
    forms,
  };
}

const flushReports = () => new Promise((resolve) => setTimeout(resolve, 10));

test("V2 ignores events without data", async () => {
  const plugin = await loadPlugin();
  const tui = v2Api();
  const dispose = await plugin.setup(tui.api);
  activeDisposers.push(dispose);
  await flushReports();
  requests.length = 0;
  expect(() => tui.emit("legacy.event")).not.toThrow();
  tui.emit("session.execution.started", { sessionID: "a" });
  await flushReports();
  expect(states()).toEqual(["working"]);
});

test("V2 completes and interrupts without legacy idle events", async () => {
  for (const terminal of ["succeeded", "interrupted", "failed"]) {
    const plugin = await loadPlugin();
    const tui = v2Api();
    const dispose = await plugin.setup(tui.api);
    activeDisposers.push(dispose);
    await flushReports();
    requests.length = 0;
    tui.emit("session.execution.started", { sessionID: "a" });
    tui.emit(`session.execution.${terminal}`, { sessionID: "a" });
    await flushReports();
    expect(states()).toEqual(["working", terminal === "failed" ? "blocked" : "idle"]);
    dispose();
  }
});

test("V2 aggregates root and child blockers and ignores other roots and child completion", async () => {
  const plugin = await loadPlugin();
  const tui = v2Api();
  const dispose = await plugin.setup(tui.api);
  activeDisposers.push(dispose);
  await flushReports();
  requests.length = 0;
  tui.emit("session.execution.started", { sessionID: "a" });
  tui.emit("permission.asked", { sessionID: "a", id: "permission-a" });
  tui.emit("form.created", { form: { sessionID: "child", id: "form-child" } });
  tui.emit("permission.replied", { sessionID: "a", requestID: "permission-a" });
  tui.emit("session.execution.succeeded", { sessionID: "child" });
  tui.emit("session.execution.started", { sessionID: "b" });
  tui.emit("permission.asked", { sessionID: "b", id: "other" });
  await flushReports();
  expect(states().at(-1)).toBe("blocked");
  expect(requests.every((r) => requestParam(r, "agent_session_id") === "a")).toBe(true);
  tui.emit("form.cancelled", { sessionID: "child", id: "form-child" });
  tui.emit("session.execution.succeeded", { sessionID: "a" });
  await flushReports();
  expect(states().slice(-2)).toEqual(["working", "idle"]);
});

test("V2 discards queued reports after selection changes and stops on disposal", async () => {
  const plugin = await loadPlugin();
  const tui = v2Api();
  const dispose = await plugin.setup(tui.api);
  activeDisposers.push(dispose);
  await flushReports();
  requests.length = 0;
  tui.emit("session.execution.started", { sessionID: "a" });
  tui.select("b");
  tui.emit("session.execution.started", { sessionID: "b" });
  await flushReports();
  expect(requests.every((r) => requestParam(r, "agent_session_id") === "b")).toBe(true);
  requests.length = 0;
  tui.emit("session.execution.succeeded", { sessionID: "b" });
  tui.home();
  await flushReports();
  expect(requests).toHaveLength(0);
  dispose();
  expect(tui.listeners.size).toBe(0);
  tui.select("a");
  await new Promise((resolve) => setTimeout(resolve, 250));
  expect(requests).toHaveLength(0);
});

test("V2 reconciles late blocker hydration without reviving an already-replied request", async () => {
  const plugin = await loadPlugin();
  const tui = v2Api();
  const dispose = await plugin.setup(tui.api);
  activeDisposers.push(dispose);
  await flushReports();
  tui.permissions.set("child", [{ id: "late" }]);
  await waitForStateReport();
  expect(states().at(-1)).toBe("blocked");
  tui.emit("permission.replied", { sessionID: "child", requestID: "late" });
  await waitForStateReport();
  expect(states().at(-1)).toBe("idle");
  tui.permissions.set("child", []);
  tui.forms.set("child", [{ id: "second" }]);
  await waitForStateReport();
  expect(states().at(-1)).toBe("blocked");
  tui.sessions.delete("child");
  tui.emit("session.deleted", { sessionID: "child" });
  await flushReports();
  expect(states().at(-1)).toBe("idle");
});

test("V2 never writes a delayed connection after disposal or a session switch", async () => {
  for (const action of ["dispose", "switch"]) {
    const plugin = await loadPlugin();
    const tui = v2Api();
    holdConnections = true;
    requests.length = 0;
    const dispose = await plugin.setup(tui.api);
    activeDisposers.push(dispose);
    await flushReports();
    expect(connections.length).toBeGreaterThan(0);
    if (action === "dispose") dispose();
    else tui.select("b");
    holdConnections = false;
    for (const connect of connections.splice(0)) connect();
    await flushReports();
    expect(requests).toHaveLength(0);
    dispose();
  }
});

test("V2 settles a connection that never completes", async () => {
  const plugin = await loadPlugin();
  const tui = v2Api();
  holdConnections = true;
  const dispose = await plugin.setup(tui.api);
  activeDisposers.push(dispose);
  const started = Date.now();
  while (connections.length <= 1 && Date.now() - started < 2_000) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  expect(connections.length).toBeGreaterThan(1);
  dispose();
});

test("V2 resends the latest state after a failed delivery", async () => {
  const plugin = await loadPlugin();
  const tui = v2Api();
  const dispose = await plugin.setup(tui.api);
  activeDisposers.push(dispose);
  await flushReports();
  // Exhaust the selection retry schedule so only the event report remains.
  await new Promise((resolve) => setTimeout(resolve, 1_600));
  requests.length = 0;
  tui.emit("session.execution.started", { sessionID: "a" });
  await flushReports();
  failConnections = true;
  tui.emit("session.execution.succeeded", { sessionID: "a" });
  const resend = waitForStateReport();
  await new Promise((resolve) => setTimeout(resolve, 700));
  failConnections = false;
  await resend;
  expect(states().at(-1)).toBe("idle");
  dispose();
});
