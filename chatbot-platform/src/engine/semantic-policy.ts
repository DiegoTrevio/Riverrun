import { config, semanticEnabledFor } from '../config.js';
import { query, queryOne } from '../db.js';

export async function semanticPolicy(accountId:string) {
  const row=await queryOne('SELECT * FROM semantic_settings WHERE account_id=$1',[accountId]);
  const enabled=!config.knowledgeSearch.forceOff && (row?.enabled ?? semanticEnabledFor(accountId));
  return {enabled,preparing:!config.knowledgeSearch.forceOff && (row?.preparing===true || enabled),
    daily_token_budget:row?.daily_token_budget??100000,verified_model:row?.verified_model??null,
    tested_signature:row?.tested_signature??null,tested_at:row?.tested_at??null,
    source:row?.enabled===null||!row?'environment':'account'};
}
export async function reserveEmbeddingTokens(accountId:string,texts:string[]) {
  const policy=await semanticPolicy(accountId);
  // UTF-8 bytes are a conservative ceiling; reservations stay consumed on ambiguous failures.
  const tokens=texts.reduce((n,t)=>n+Buffer.byteLength(t,'utf8'),0);
  const rows=await query(`INSERT INTO embedding_usage(account_id,reserved_tokens) SELECT $1::uuid,$2::integer WHERE $2::integer<=$3::integer
    ON CONFLICT(account_id,day) DO UPDATE SET reserved_tokens=embedding_usage.reserved_tokens+EXCLUDED.reserved_tokens
    WHERE embedding_usage.reserved_tokens+EXCLUDED.reserved_tokens<=$3::integer RETURNING reserved_tokens`,[accountId,tokens,policy.daily_token_budget]);
  if(!rows.length) throw new Error('embedding_budget_exhausted');
}
