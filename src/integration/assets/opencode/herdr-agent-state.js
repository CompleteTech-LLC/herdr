// installed by herdr
// managed by herdr; reinstalling or updating the integration overwrites this file.
// add custom hooks/plugins beside this file instead of editing it.
// HERDR_INTEGRATION_ID=opencode
// HERDR_INTEGRATION_VERSION=12

// Keep both loader entrypoints compatible. Lifecycle and session selection are
// reported together by herdr-tui-session.js in the pane-local V1/V2 TUI.
// A shared server has no reliable ownership signal for its attached clients.
export const HerdrAgentStatePlugin = async () => ({});

export default {
  id: "herdr.opencode",
  server: HerdrAgentStatePlugin,
  setup() {},
};
