import { expect, test } from "bun:test";
import plugin, { HerdrAgentStatePlugin } from "./herdr-agent-state.js";

test("both server loaders remain inert even inside a Herdr pane", async () => {
  const previous = { ...process.env };
  try {
    process.env.HERDR_ENV = "1";
    process.env.HERDR_SOCKET_PATH = "test.sock";
    process.env.HERDR_PANE_ID = "test:p1";
    expect(plugin.server).toBe(HerdrAgentStatePlugin);
    expect(await HerdrAgentStatePlugin()).toEqual({});
    expect(await plugin.server()).toEqual({});
    expect(plugin.setup()).toBeUndefined();
  } finally {
    for (const name of ["HERDR_ENV", "HERDR_SOCKET_PATH", "HERDR_PANE_ID"]) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});
