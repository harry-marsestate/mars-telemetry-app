import type Anthropic from "@anthropic-ai/sdk";

// Shown when Kimi failed and Claude answered instead (docs/SECURITY.md,
// "Mandatory fallback"). DISPLAY ONLY: it goes out as its own `text` event and
// never into the turns returned in `done`. Those turns are replayed verbatim on
// the next question, and the assistant turn Claude produced carries signed
// thinking blocks -- appending the note to it would replay an edited turn,
// which Sonnet 5.5 rejects with a 400 on enforced accounts.
export const FALLBACK_NOTE = "\n\n*(answered via backup model due to a processing issue)*";

export const NO_TEXT_MAX_TOKENS =
  "That answer needed more room than I had to work with -- try narrowing the question (a specific block, vintage, or metric) and I'll try again.";
export const NO_TEXT_OTHER = "I wasn't able to put together an answer for that -- try rephrasing the question.";

// The events that close a terminal Claude turn, in send order. `newTurns` is
// returned in `done` exactly as the model produced it: nothing here edits it.
export function finishEvents(o: {
  newTurns: Anthropic.MessageParam[];
  sawText: boolean;
  stopReason: string | null;
  usedFallback: boolean;
  userTurn: Anthropic.MessageParam;
}): Record<string, unknown>[] {
  // A refusal (stop_reason "refusal", possibly after some text streamed):
  // `done` says so and returns no turns. The browser replaces whatever it
  // showed with a notice and keeps this question out of its history, so the
  // refused turn is never replayed. Dropping the tail of the history is not
  // an edit of an earlier turn, so preserved thinking is unaffected.
  if (o.stopReason === "refusal") {
    return [{ type: "done", appended: [], refused: true, truncated: false, provider: "claude", user_turn: null }];
  }

  const events: Record<string, unknown>[] = [];

  // A genuinely terminal turn (no tool_use left to run) can still carry no
  // usable text -- most commonly a max_tokens cutoff that landed entirely
  // inside "thinking" before any text was written. Surface that honestly
  // instead of finishing with an empty bubble.
  if (!o.sawText) {
    events.push({ type: "text", text: o.stopReason === "max_tokens" ? NO_TEXT_MAX_TOKENS : NO_TEXT_OTHER });
  }

  // Fallback disclosure, after the answer is known (good or honestly
  // degraded): the operator always sees plainly that Kimi failed and this
  // reply came from the backup model, never finds out silently.
  if (o.usedFallback) events.push({ type: "text", text: FALLBACK_NOTE });

  // `truncated` rides on the done event rather than being concatenated onto
  // the reply: by this point the text has already been streamed, so the note
  // has to be appended client-side. `provider` is always "claude" here -- this
  // is reached either because CHAT_MODEL_PROVIDER/the operator toggle picked
  // Claude, or because Kimi just failed and this is the mandatory fallback;
  // both mean Claude is the model that actually wrote the content.
  events.push({
    type: "done",
    appended: o.newTurns,
    truncated: o.stopReason === "max_tokens",
    provider: "claude",
    user_turn: o.userTurn,
  });
  return events;
}
