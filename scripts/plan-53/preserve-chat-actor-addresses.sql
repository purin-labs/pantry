-- Run against the inventoried source before changing user or conversation IDs.
UPDATE portal_conversation
SET state_json = json_set(
  state_json,
  '$.actorIdentity',
  organisation_id || ':portal-chat:' || user_id || ':' || conversation_id
)
WHERE json_type(state_json, '$.actorIdentity') IS NULL;
