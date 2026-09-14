// installed by herdr
// managed by herdr; reinstalling or updating the integration overwrites this file.
// HERDR_INTEGRATION_ID=opencode-tui
// HERDR_INTEGRATION_VERSION=12

import net from "node:net";

const SOURCE = "herdr:opencode";
const AGENT = "opencode";
const ROUTE_POLL_INTERVAL_MS = 100;
const SELECTION_RETRY_DELAYS_MS = [100, 400, 1_000];

function requestOnce(sessionID, state, seq, isCurrent = () => true) {
  const paneId = process.env.HERDR_PANE_ID;
  const socketPath = process.env.HERDR_SOCKET_PATH;
  if (!paneId || !socketPath) {
    return Promise.resolve(true);
  }

  const socketEndpoint =
    process.platform === "win32" ? `\\\\.\\pipe\\${socketPath}` : socketPath;
  const request = {
    id: `${SOURCE}:tui:${Date.now()}:${Math.floor(Math.random() * 1_000_000)
      .toString()
      .padStart(6, "0")}`,
    method: state === undefined ? "pane.report_agent_session" : "pane.report_agent",
    params: {
      pane_id: paneId,
      source: SOURCE,
      agent: AGENT,
      agent_session_id: sessionID,
      ...(state === undefined ? { session_start_source: "select" } : { state, seq }),
    },
  };

  return new Promise((resolve) => {
    let settled = false;
    let timer;
    const settle = (delivered) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client.destroy();
      resolve(delivered);
    };
    const client = net.createConnection(socketEndpoint, () => {
      if (!isCurrent()) {
        settle(false);
        return;
      }
      client.write(`${JSON.stringify(request)}\n`);
    });

    // A plain timer, not socket.setTimeout, so a connection that never finishes
    // connecting still settles and cannot block later reports behind the queue.
    timer = setTimeout(() => settle(false), 500);
    timer.unref?.();
    client.on("data", () => settle(true));
    client.on("error", () => settle(false));
    client.on("end", () => settle(false));
    client.on("close", () => settle(false));
  });
}

export default {
  id: "herdr.opencode.session-selection",
  // Keep this plain object dependency-free: V1 and V2 expose different SDK
  // packages, but both loaders accept their own lifecycle entry on this object.
  setup,
  tui,
};

// V1 also reports from the pane-local TUI. The shared server cannot identify
// which attached client's session belongs to the pane that launched it.
async function tui(api) {
  if (process.env.HERDR_ENV !== "1" || !process.env.HERDR_SOCKET_PATH || !process.env.HERDR_PANE_ID) return;

  let disposed = false;
  let context;
  let sequence = Date.now() * 1000;
  let chain = Promise.resolve();

  function routeID() {
    const route = api.route.current;
    return route?.name === "session" ? route.params?.sessionID : undefined;
  }

  function current(ctx) {
    return !disposed && context === ctx && routeID() === ctx.route;
  }

  async function read(ctx, request) {
    const result = await request({
      signal: AbortSignal.any([ctx.controller.signal, AbortSignal.timeout(5_000)]),
      throwOnError: true,
    });
    if (!current(ctx) || result?.data === undefined) throw new Error("session data unavailable");
    return result.data;
  }

  function root(ctx, id) {
    const seen = new Set();
    while (typeof id === "string" && !seen.has(id)) {
      if (ctx.deleted.has(id)) return;
      seen.add(id);
      const session = ctx.sessions.get(id) ?? api.state.session.get(id);
      if (!session) return;
      if (!session.parentID) return id;
      id = session.parentID;
    }
  }

  async function resolveRoot(ctx, id) {
    const seen = new Set();
    while (typeof id === "string" && !seen.has(id)) {
      if (ctx.deleted.has(id)) return;
      seen.add(id);
      let session = ctx.sessions.get(id) ?? api.state.session.get(id);
      if (!session) {
        if (!ctx.lookups.has(id)) {
          const requestedID = id;
          const lookup = read(ctx, (options) => api.client.session.get({ sessionID: requestedID }, options));
          ctx.lookups.set(id, lookup);
          lookup.finally(() => ctx.lookups.delete(requestedID)).catch(() => {});
        }
        session = await ctx.lookups.get(id);
        if (ctx.deleted.has(id)) return;
        // An event may have supplied newer ancestry meanwhile.
        session = ctx.sessions.get(id) ?? session;
        if (session.id !== id) throw new Error("unexpected session identity");
        ctx.sessions.set(id, session);
      }
      if (!session.parentID) return id;
      id = session.parentID;
    }
  }

  function owners(ctx) {
    return new Set([...ctx.statuses.keys(), ...ctx.blockers.values()]);
  }

  function state(ctx) {
    if (!ctx.selected) return;
    for (const owner of ctx.blockers.values()) {
      if (root(ctx, owner) === ctx.selected) return "blocked";
    }
    if (ctx.errors.has(ctx.selected)) return "blocked";
    for (const owner of ctx.statuses.keys()) {
      if (root(ctx, owner) === ctx.selected) return "working";
    }
    // Empty caches or unresolved active owners cannot establish idle.
    // The successful native status snapshot omits idle sessions.
    if (ctx.hydrated && [...owners(ctx)].every((id) => root(ctx, id) !== undefined)) return "idle";
  }

  function scheduleBlockerRefresh(ctx) {
    if (!ctx.selected) {
      ctx.refreshAt = Infinity;
      return;
    }
    if (ctx.loading || !ctx.hydrated) return;
    // Attachment can land between native idle and silent request cleanup.
    // Refresh only pending requests whose owner is no longer active; normal
    // execution and settled idle sessions remain event-driven.
    const unsettled = [...ctx.blockers.values()].some((id) =>
      !ctx.statuses.has(id) && root(ctx, id) === ctx.selected);
    ctx.refreshAt = unsettled ? Math.min(ctx.refreshAt, Date.now() + 1_000) : Infinity;
  }

  function publish(ctx, selection = false) {
    if (!current(ctx) || !ctx.selected) return;
    scheduleBlockerRefresh(ctx);
    ctx.selectionPending ||= selection;
    if (ctx.queued) return;
    ctx.queued = true;
    chain = chain.then(async () => {
      ctx.queued = false;
      if (!current(ctx)) return;
      const selected = ctx.selected;
      const isCurrent = () => current(ctx) && !!selected &&
        ctx.selected === selected && root(ctx, ctx.route) === selected;
      if (!isCurrent()) return;
      if (ctx.selectionPending) {
        const delivered = await requestOnce(selected, undefined, undefined, isCurrent);
        if (!isCurrent()) return;
        if (!delivered) {
          ctx.retryAt = Date.now() + 500;
          return;
        }
        ctx.selectionPending = false;
        ctx.lastState = undefined;
      }
      const value = state(ctx);
      if (value === undefined || value === ctx.lastState) return;
      const delivered = await requestOnce(selected, value, ++sequence, isCurrent);
      if (!isCurrent()) return;
      if (delivered) ctx.lastState = value;
      else {
        // The server may have applied a write whose acknowledgement was lost.
        ctx.lastState = undefined;
        ctx.retryAt = Date.now() + 500;
      }
    }).catch(() => {
      if (current(ctx)) {
        ctx.lastState = undefined;
        ctx.retryAt = Date.now() + 500;
      }
    });
  }

  function reconcile(ctx) {
    if (!current(ctx)) return;
    publish(ctx);
    if (ctx.resolving) {
      ctx.resolveAgain = true;
      return;
    }
    ctx.resolving = true;
    void (async () => {
      const selected = await resolveRoot(ctx, ctx.route);
      if (!current(ctx) || !selected || root(ctx, ctx.route) !== selected) return;
      if (selected && selected !== ctx.selected) {
        ctx.selected = selected;
        publish(ctx, true);
      }
      // Resolve active/request-bearing ancestry, never the entire history or
      // a tree on every route poll. Requests are deduplicated within the epoch.
      await Promise.all([...owners(ctx)].map((id) => resolveRoot(ctx, id)));
      if (current(ctx)) publish(ctx);
    })().catch(() => {
      if (current(ctx)) ctx.retryAt = Date.now() + 500;
    }).finally(() => {
      ctx.resolving = false;
      if (ctx.resolveAgain) {
        ctx.resolveAgain = false;
        reconcile(ctx);
      }
    });
  }

  function clearRequests(ctx, id) {
    for (const [key, owner] of ctx.blockers) if (owner === id) ctx.blockers.delete(key);
  }

  function apply(ctx, event) {
    const data = event.properties;
    if (!data) return;
    const id = data.sessionID ?? data.info?.id;
    if (typeof id !== "string") return;
    if (event.type === "session.deleted") {
      ctx.deleted.add(id);
      ctx.sessions.delete(id);
      ctx.statuses.delete(id);
      ctx.errors.delete(id);
      clearRequests(ctx, id);
      if (id === ctx.selected) {
        ctx.selected = undefined;
        ctx.refreshAt = Infinity;
      }
      return;
    }
    if (ctx.deleted.has(id)) return;
    switch (event.type) {
      case "session.created":
      case "session.updated":
        if (data.info) ctx.sessions.set(id, data.info);
        break;
      case "session.status":
      case "session.idle": {
        const status = event.type === "session.idle" ? "idle" : data.status?.type;
        if (status === "busy" || status === "retry") {
          ctx.statuses.set(id, status);
          ctx.errors.delete(id);
        } else if (status === "idle") {
          ctx.statuses.delete(id);
          ctx.errors.delete(id);
          // Native cancellation removes requests without emitting replies.
          // Terminal status clears this owner, never its descendants.
          clearRequests(ctx, id);
        }
        break;
      }
      case "session.error":
        if (data.error?.name !== "MessageAbortedError") ctx.errors.add(id);
        break;
      case "permission.asked":
      case "question.asked":
        if (typeof data.id === "string") ctx.blockers.set(`${event.type.split(".")[0]}:${data.id}`, id);
        break;
      case "permission.replied":
      case "question.replied":
      case "question.rejected":
        ctx.blockers.delete(`${event.type.split(".")[0]}:${data.requestID}`);
        break;
    }
  }

  async function hydrate(ctx) {
    if (ctx.loading || !current(ctx)) return;
    ctx.loading = true;
    ctx.events = [];
    try {
      const [statuses, permissions, questions] = await Promise.all([
        read(ctx, (options) => api.client.session.status(undefined, options)),
        read(ctx, (options) => api.client.permission.list(undefined, options)),
        read(ctx, (options) => api.client.question.list(undefined, options)),
      ]);
      if (!current(ctx)) return;
      if (!statuses || Array.isArray(statuses) || !Array.isArray(permissions) || !Array.isArray(questions)) {
        throw new Error("incomplete session snapshot");
      }
      ctx.statuses.clear();
      ctx.blockers.clear();
      for (const [id, status] of Object.entries(statuses)) {
        if (!ctx.deleted.has(id) && (status.type === "busy" || status.type === "retry")) ctx.statuses.set(id, status.type);
      }
      for (const [kind, requests] of [["permission", permissions], ["question", questions]]) {
        for (const request of requests) {
          if (!ctx.deleted.has(request.sessionID)) ctx.blockers.set(`${kind}:${request.id}`, request.sessionID);
        }
      }
      // Events precede native map updates. Replay every delta received during
      // this snapshot, including terminal states and request removals.
      for (const event of ctx.events) apply(ctx, event);
      ctx.hydrated = true;
      reconcile(ctx);
    } catch {
      if (current(ctx)) ctx.retryAt = Date.now() + 500;
    } finally {
      ctx.loading = false;
      ctx.events = [];
      if (current(ctx)) scheduleBlockerRefresh(ctx);
    }
  }

  function syncSelection(reset = false) {
    if (disposed) return;
    const id = routeID();
    if (reset || id !== context?.route) {
      context?.controller.abort();
      context = undefined;
      if (typeof id !== "string" || !id) return;
      const ctx = {
        route: id, controller: new AbortController(), sessions: new Map(),
        lookups: new Map(), statuses: new Map(), blockers: new Map(),
        errors: new Set(), deleted: new Set(), events: [],
        hydrated: false, loading: false, resolving: false,
        retryIndex: 0, selectionAt: 0, retryAt: Infinity, refreshAt: Infinity,
      };
      context = ctx;
      reconcile(ctx);
      void hydrate(ctx);
    }
    const ctx = context;
    if (!ctx) return;
    if (ctx.selected && Date.now() >= ctx.selectionAt) {
      publish(ctx, true);
      const delay = SELECTION_RETRY_DELAYS_MS[ctx.retryIndex++];
      ctx.selectionAt = delay === undefined ? Infinity : Date.now() + delay;
    }
    if (Date.now() >= ctx.retryAt) {
      ctx.retryAt = Infinity;
      if (!ctx.hydrated) void hydrate(ctx);
      reconcile(ctx);
    }
    if (!ctx.loading && Date.now() >= ctx.refreshAt) {
      ctx.refreshAt = Infinity;
      void hydrate(ctx);
    }
  }

  const subscriptions = [
    "session.created", "session.updated", "session.deleted", "session.status", "session.idle",
    "session.error", "permission.asked", "permission.replied",
    "question.asked", "question.replied", "question.rejected",
  ].map((type) => api.event.on(type, (event) => {
    syncSelection();
    const ctx = context;
    if (!ctx) return;
    if (ctx.loading) ctx.events.push(event);
    apply(ctx, event);
    reconcile(ctx);
  }));
  for (const type of ["server.connected", "server.instance.disposed", "global.disposed"]) {
    subscriptions.push(api.event.on(type, () => syncSelection(true)));
  }
  const poll = setInterval(syncSelection, ROUTE_POLL_INTERVAL_MS);
  api.lifecycle.onDispose(() => {
    disposed = true;
    context?.controller.abort();
    clearInterval(poll);
    for (const unsubscribe of subscriptions) unsubscribe();
  });
  // Do not block TUI startup on remote SDK hydration.
  syncSelection();
}

function setup(api) {
  if (process.env.HERDR_ENV !== "1" || !process.env.HERDR_SOCKET_PATH || !process.env.HERDR_PANE_ID) return;

  let disposed = false;
  let selected;
  let generation = 0;
  let sequence = Date.now() * 1000;
  let chain = Promise.resolve();
  let retryIndex = 0;
  let nextSelectionAt = 0;
  let state = "idle";
  let retryTimer;
  const sessions = new Map();
  let blockers = new Map();
  // Event callbacks may precede cache updates. Retain each delta until the
  // cache reflects it, so late hydration cannot undo a reply or lose an ask.
  const blockerChanges = new Map();

  function root(id) {
    const seen = new Set();
    while (typeof id === "string" && !seen.has(id)) {
      seen.add(id);
      const session = api.data.session.get(id) ?? sessions.get(id);
      if (!session) return;
      if (!session.parentID) return id;
      id = session.parentID;
    }
  }

  function current() {
    const route = api.ui.router.current();
    return route.type === "session" ? root(route.sessionID) : undefined;
  }

  // Selection and lifecycle use one queue. Recheck attribution at dispatch,
  // not just when receiving the event, and reject A -> B -> A stale work too.
  function enqueue(value) {
    const sessionID = selected;
    const revision = generation;
    const isCurrent = () => !disposed && revision === generation && !!sessionID && current() === sessionID;
    chain = chain.then(async () => {
      if (!isCurrent()) return;
      const delivered = await requestOnce(sessionID, value, value === undefined ? undefined : ++sequence, isCurrent);
      if (!delivered) scheduleStateRetry();
    }).catch(() => {});
  }

  // A dropped report must not strand the pane on a stale state once the
  // selection retry schedule has run out: resend the latest state until the
  // socket accepts it or the selection is no longer current.
  function scheduleStateRetry() {
    if (disposed || retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      publish();
    }, 500);
    retryTimer.unref?.();
  }

  function publish() {
    enqueue(blockers.size ? "blocked" : state);
  }

  function changeBlocker(id, kind, requestID, present) {
    if (typeof requestID !== "string") return;
    const key = `${kind}:${requestID}`;
    blockerChanges.set(key, { id, kind, present });
    if (present) blockers.set(key, id);
    else blockers.delete(key);
  }

  function reconcileBlockers() {
    const next = new Map();
    const hydrated = new Set();
    const members = new Set([selected, ...api.data.session.family(selected), ...blockers.values()]);
    for (const member of members) {
      if (root(member) !== selected) continue;
      for (const kind of ["permission", "form"]) {
        const items = api.data.session[kind].list(member);
        if (items === undefined) {
          for (const [key, owner] of blockers) {
            if (owner === member && key.startsWith(`${kind}:`)) next.set(key, owner);
          }
          continue;
        }
        hydrated.add(`${kind}:${member}`);
        for (const item of items) next.set(`${kind}:${item.id}`, member);
      }
    }
    for (const [key, change] of blockerChanges) {
      if (hydrated.has(`${change.kind}:${change.id}`) && next.has(key) === change.present) {
        blockerChanges.delete(key);
      } else if (change.present) {
        next.set(key, change.id);
      } else {
        next.delete(key);
      }
    }
    const changed = (blockers.size > 0) !== (next.size > 0);
    blockers = next;
    return changed;
  }

  function syncSelection() {
    if (disposed) return;
    const id = current();
    if (id !== selected) {
      selected = id;
      generation += 1;
      retryIndex = 0;
      nextSelectionAt = 0;
      blockers.clear();
      blockerChanges.clear();
      if (id) {
        state = api.data.session.status(id) === "running" ? "working" : "idle";
      }
    }
    if (!id) return;
    const blockersChanged = reconcileBlockers();
    if (Date.now() < nextSelectionAt) {
      if (blockersChanged) publish();
      return;
    }
    enqueue(undefined);
    publish();
    const delay = SELECTION_RETRY_DELAYS_MS[retryIndex++];
    nextSelectionAt = delay === undefined ? Number.POSITIVE_INFINITY : Date.now() + delay;
  }

  function receive({ details: event }) {
    if (disposed) return;
    const data = event.data;
    if (data == null) return;
    if (event.type === "session.created") {
      sessions.set(data.sessionID, { id: data.sessionID, parentID: data.parentID });
    }
    if (event.type === "session.deleted") {
      const affected = data.sessionID === selected || [...blockers.values()].includes(data.sessionID);
      sessions.delete(data.sessionID);
      // Deletion is delivered after the cache can remove the session. Use
      // stored ownership rather than looking up the deleted child's ancestry.
      for (const [key, owner] of blockers) if (owner === data.sessionID) blockers.delete(key);
      for (const [key, change] of blockerChanges) {
        if (change.id === data.sessionID) blockerChanges.delete(key);
      }
      syncSelection();
      if (selected && affected) publish();
      return;
    }
    syncSelection();
    const id = event.type === "form.created" ? data.form.sessionID : data.sessionID;
    if (!selected || root(id) !== selected) return;
    switch (event.type) {
      case "permission.asked":
        changeBlocker(id, "permission", data.id, true);
        break;
      case "permission.replied":
        changeBlocker(id, "permission", data.requestID, false);
        break;
      case "form.created":
        changeBlocker(id, "form", data.form.id, true);
        break;
      case "form.replied":
      case "form.cancelled":
        changeBlocker(id, "form", data.id, false);
        break;
      case "session.execution.started":
        if (id !== selected) return;
        state = "working";
        break;
      case "session.execution.succeeded":
      case "session.execution.interrupted":
        if (id !== selected) return;
        state = "idle";
        break;
      case "session.execution.failed":
        if (id !== selected) return;
        state = "blocked";
        break;
      default:
        return;
    }
    publish();
  }

  const unsubscribe = api.data.listen(receive);
  syncSelection();
  const poll = setInterval(syncSelection, ROUTE_POLL_INTERVAL_MS);
  return () => {
    disposed = true;
    generation += 1;
    clearTimeout(retryTimer);
    clearInterval(poll);
    unsubscribe();
    sessions.clear();
    blockers.clear();
    blockerChanges.clear();
  };
}
