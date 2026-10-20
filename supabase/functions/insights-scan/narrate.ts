import Anthropic from "@anthropic-ai/sdk";
import type { SupabaseContext } from "@supabase/server";
import { ANTHROPIC_MODEL } from "../_shared/anthropic-model.ts";
import { type Finding, MAX_TOKENS, type NarrationCall, type NarrationOutcome, type NarrationWrite, narrateRows, SYSTEM_PROMPT } from "./narrate-core.ts";

type SupabaseClient = SupabaseContext["supabaseAdmin"];

// The model call and the guarded write for narrate-core.ts, which does the
// batching, retries and validation.
export function narrateFindings(sb: SupabaseClient, findings: Finding[]): Promise<NarrationOutcome> {
  const anthropic = new Anthropic({ apiKey: Deno.env.get("ANTHROPIC_API_KEY") });
  const model = ANTHROPIC_MODEL;

  const call: NarrationCall = async (input) => {
    const response = await anthropic.messages.create({
      model, max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: JSON.stringify(input) }],
    });
    return {
      text: response.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("\n"),
      stopReason: response.stop_reason,
      outputTokens: response.usage.output_tokens,
      // Not in this SDK version's types; present in the API response.
      thinkingTokens: (response.usage as { output_tokens_details?: { thinking_tokens?: number } }).output_tokens_details?.thinking_tokens ?? null,
    };
  };

  // Only a row that is still surfaced and un-narrated is written, so a
  // concurrent or repeated run can never narrate a row twice.
  const write: NarrationWrite = async (id, values) => {
    const { data, error } = await sb.from("insights").update(values)
      .eq("id", id).eq("status", "surfaced").is("narrated_at", null).select("id");
    return error ? { ok: false, error: error.message } : { ok: true, matched: (data?.length ?? 0) > 0 };
  };

  return narrateRows(findings, call, write, { model });
}
