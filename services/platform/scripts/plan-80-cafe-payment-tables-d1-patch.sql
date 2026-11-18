-- Removes the café payment tables of the old payment path through Satyr
-- (Plan 80 step 5 part B): payment attempts, their provider observations,
-- terminal collection ownership, Square terminal deliveries and payment
-- binding certifications. Underclerk now holds every payment. Apply to each
-- deployed regional database after the release that stops writing them. The
-- rows are deleted with the tables; Underclerk's own payment records are not
-- touched. The trigger and indexes go first, then children before their
-- parent. The statements are safe to repeat.
DROP TRIGGER IF EXISTS cafe_payment_binding_certification_no_update;
DROP INDEX IF EXISTS idx_cafe_payment_attempt_account;
DROP INDEX IF EXISTS idx_cafe_payment_attempt_provider_payment;
DROP INDEX IF EXISTS idx_cafe_payment_binding_certification_binding;
DROP INDEX IF EXISTS idx_cafe_terminal_collection_ownership_attempt;
DROP INDEX IF EXISTS idx_square_terminal_delivery_pending;
DROP TABLE IF EXISTS cafe_terminal_collection_ownership;
DROP TABLE IF EXISTS cafe_payment_observation;
DROP TABLE IF EXISTS cafe_payment_attempt;
DROP TABLE IF EXISTS square_terminal_delivery;
DROP TABLE IF EXISTS cafe_payment_binding_certification;
