// The one Claude model this project calls: the chat's answering loop
// (chat/index.ts), insight narration (insights-scan/narrate.ts), and the
// nightly probe that checks the model still exists (health-probe/probes.ts).
// Changing it is a production model change -- re-run the before/after
// accuracy check first (docs/SECURITY.md, "Chat and narration moved to
// Claude Sonnet 5.5").
export const ANTHROPIC_MODEL = "claude-sonnet-5-5";
