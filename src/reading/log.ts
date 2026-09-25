// Writes every model call to `model_calls`, the source for cost per page (spec §4 step 2).
import type { Queryable } from "../shared/db/pool.ts";
import type { RecordCall } from "./reader.ts";

export function recordCallsIn(db: Queryable): RecordCall {
  return async (call) => {
    await db.query(
      `INSERT INTO model_calls
         (org_id, document_id, purpose, pdf_page, model, finish_reason, input_tokens, output_tokens, cost_usd, ok, error)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        call.context.orgId,
        call.context.documentId,
        call.purpose,
        call.pdfPage,
        call.model,
        call.finishReason,
        call.inputTokens,
        call.outputTokens,
        call.costUsd,
        call.ok,
        call.error,
      ],
    );
    console.log(
      JSON.stringify({
        event: "model_call",
        purpose: call.purpose,
        document: call.context.documentId,
        page: call.pdfPage,
        model: call.model,
        finish_reason: call.finishReason,
        input_tokens: call.inputTokens,
        output_tokens: call.outputTokens,
        ok: call.ok,
      }),
    );
  };
}
