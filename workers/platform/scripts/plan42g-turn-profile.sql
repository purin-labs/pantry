-- Content-free retained portal turns for the production acceptance organisation.
-- Usage is cumulative provider usage, including cached input; it is not billing.
-- The route describes the conversation's current selection, not historical routes.
WITH events AS (
  SELECT c.conversation_id,
    json_extract(c.state_json, '$.modelRoute.keySource') AS current_key_source,
    json_extract(c.state_json, '$.modelRoute.provider') AS current_provider,
    json_extract(c.state_json, '$.modelRoute.model') AS current_model,
    e.value AS event
  FROM portal_conversation AS c, json_each(c.state_json, '$.timeline') AS e
  WHERE c.organisation_id = 'organisation_c52fe098-174f-467e-b1d6-c01fc0baf9b7'
    AND c.updated_at >= (unixepoch() - 86400) * 1000
), starts AS (
  SELECT conversation_id, json_extract(event, '$.requestId') AS request_id,
    MIN(json_extract(event, '$.createdAt')) AS started_at
  FROM events
  WHERE json_extract(event, '$.kind') = 'user'
  GROUP BY conversation_id, request_id
)
SELECT e.conversation_id, s.request_id, e.current_key_source,
  e.current_provider, e.current_model, s.started_at,
  json_extract(e.event, '$.createdAt') AS completed_at,
  json_extract(e.event, '$.createdAt') - s.started_at AS full_turn_ms,
  json_extract(e.event, '$.usage.inputTokens') AS input_tokens,
  json_extract(e.event, '$.usage.cachedInputTokens') AS cached_input_tokens,
  json_extract(e.event, '$.usage.outputTokens') AS output_tokens,
  json_extract(e.event, '$.usage.totalTokens') AS total_tokens
FROM events AS e
JOIN starts AS s ON s.conversation_id = e.conversation_id
  AND s.request_id = json_extract(e.event, '$.requestId')
WHERE json_extract(e.event, '$.kind') = 'assistant'
  AND json_extract(e.event, '$.createdAt') >= (unixepoch() - 86400) * 1000
ORDER BY completed_at, e.conversation_id, s.request_id;
