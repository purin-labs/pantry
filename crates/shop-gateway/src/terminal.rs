//! Simulated LAN payment terminal adapter (`gmo_stera`, Plan 90 Phase 4A).
//!
//! Persists every in-flight terminal attempt in a local JSON journal before
//! answering so that a socket drop or gateway restart recovers the exact
//! terminal result on `terminal_inquire` without ever double-charging.
//! Physical `stera terminal` LAN POS-link (CCT) framing waits for Phase 4B
//! after GMO Financial Gate delivers the official specification.

use std::collections::BTreeMap;
#[cfg(test)]
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::{journal, str_field};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SimulatedTerminalRule {
    /// Optional payment attempt id prefix; matches any attempt when omitted.
    #[serde(default)]
    pub match_attempt_prefix: Option<String>,
    /// Optional payment method filter ("card", "felica", "qr_code").
    #[serde(default)]
    pub payment_method: Option<String>,
    /// "captured", "declined", "cancelled", "indeterminate", or "drop_then_recover".
    pub outcome: String,
    #[serde(default)]
    pub tender_brand: Option<String>,
    #[serde(default)]
    pub reason_code: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct JournaledTerminalAttempt {
    pub payment_attempt_id: String,
    pub source_key: String,
    pub amount_minor: u64,
    pub currency: String,
    pub payment_method: String,
    pub outcome: String,
    pub provider_payment_reference: Option<String>,
    pub tender_brand: Option<String>,
    pub provider_refundable: Option<bool>,
    pub reason_code: Option<String>,
}

pub enum TerminalAction {
    /// Send this `terminal_result` message immediately over the WebSocket.
    SendResult(Value),
    /// Simulate a mid-flight socket drop after persisting the settled outcome
    /// to disk so the next reconnect + `terminal_inquire` recovers it.
    SimulateSocketDrop,
}

pub struct TerminalJournal {
    path: PathBuf,
    attempts: BTreeMap<String, JournaledTerminalAttempt>,
}

impl TerminalJournal {
    pub fn load(folder: &Path) -> Result<Self, String> {
        let path = folder.join("inflight-terminals.json");
        let attempts = journal::load(&path)?;
        Ok(Self { path, attempts })
    }

    fn persist(&self) -> Result<(), String> {
        journal::save(&self.path, &self.attempts)
    }

    pub fn handle_collect(
        &mut self,
        message: &Value,
        rules: &[SimulatedTerminalRule],
    ) -> Result<TerminalAction, String> {
        let request_id = str_field(message, "requestId")?;
        let source_key = str_field(message, "sourceKey")?;
        let attempt_id = str_field(message, "paymentAttemptId")?;
        let amount_minor = message
            .get("amountMinor")
            .and_then(Value::as_u64)
            .ok_or("terminal_collect missing amountMinor")?;
        let currency = str_field(message, "currency")?;
        let payment_method = str_field(message, "paymentMethod")?;

        // Idempotency: if this attempt is already journaled, never re-charge;
        // return the persisted outcome.
        if let Some(existing) = self.attempts.get(attempt_id) {
            return Ok(TerminalAction::SendResult(result_message(
                request_id, existing,
            )));
        }

        let matched = rules.iter().find(|rule| {
            let prefix_ok = rule
                .match_attempt_prefix
                .as_deref()
                .is_none_or(|prefix| attempt_id.starts_with(prefix));
            let method_ok = rule
                .payment_method
                .as_deref()
                .is_none_or(|method| method == payment_method);
            prefix_ok && method_ok
        });

        let raw_outcome = matched
            .map(|rule| rule.outcome.as_str())
            .unwrap_or("captured");
        let simulate_drop = raw_outcome == "drop_then_recover";
        let resolved_outcome = if simulate_drop {
            "captured"
        } else {
            raw_outcome
        };

        let (default_brand, default_refundable) = match payment_method {
            "felica" => ("FELICA_TRANSPORTATION", false),
            "qr_code" => ("PAYPAY", true),
            _ => ("VISA", true),
        };
        let entry = match resolved_outcome {
            "captured" => JournaledTerminalAttempt {
                payment_attempt_id: attempt_id.to_string(),
                source_key: source_key.to_string(),
                amount_minor,
                currency: currency.to_string(),
                payment_method: payment_method.to_string(),
                outcome: "captured".to_string(),
                provider_payment_reference: Some(format!("stera_sim_{attempt_id}")),
                tender_brand: Some(
                    matched
                        .and_then(|rule| rule.tender_brand.clone())
                        .unwrap_or_else(|| default_brand.to_string()),
                ),
                provider_refundable: Some(default_refundable),
                reason_code: None,
            },
            "declined" => JournaledTerminalAttempt {
                payment_attempt_id: attempt_id.to_string(),
                source_key: source_key.to_string(),
                amount_minor,
                currency: currency.to_string(),
                payment_method: payment_method.to_string(),
                outcome: "declined".to_string(),
                provider_payment_reference: None,
                tender_brand: None,
                provider_refundable: None,
                reason_code: Some(
                    matched
                        .and_then(|rule| rule.reason_code.clone())
                        .unwrap_or_else(|| "card_declined".to_string()),
                ),
            },
            "cancelled" => JournaledTerminalAttempt {
                payment_attempt_id: attempt_id.to_string(),
                source_key: source_key.to_string(),
                amount_minor,
                currency: currency.to_string(),
                payment_method: payment_method.to_string(),
                outcome: "cancelled".to_string(),
                provider_payment_reference: None,
                tender_brand: None,
                provider_refundable: None,
                reason_code: Some(
                    matched
                        .and_then(|rule| rule.reason_code.clone())
                        .unwrap_or_else(|| "operator_cancelled".to_string()),
                ),
            },
            _ => JournaledTerminalAttempt {
                payment_attempt_id: attempt_id.to_string(),
                source_key: source_key.to_string(),
                amount_minor,
                currency: currency.to_string(),
                payment_method: payment_method.to_string(),
                outcome: "indeterminate".to_string(),
                provider_payment_reference: None,
                tender_brand: None,
                provider_refundable: None,
                reason_code: Some(
                    matched
                        .and_then(|rule| rule.reason_code.clone())
                        .unwrap_or_else(|| "lan_timeout".to_string()),
                ),
            },
        };

        self.attempts.insert(attempt_id.to_string(), entry.clone());
        self.persist()?;

        if simulate_drop {
            Ok(TerminalAction::SimulateSocketDrop)
        } else {
            Ok(TerminalAction::SendResult(result_message(
                request_id, &entry,
            )))
        }
    }

    pub fn handle_cancel(&mut self, message: &Value) -> Result<Value, String> {
        let request_id = str_field(message, "requestId")?;
        let source_key = str_field(message, "sourceKey")?;
        let attempt_id = str_field(message, "paymentAttemptId")?;
        if let Some(existing) = self.attempts.get(attempt_id) {
            return Ok(result_message(request_id, existing));
        }
        let cancelled = JournaledTerminalAttempt {
            payment_attempt_id: attempt_id.to_string(),
            source_key: source_key.to_string(),
            amount_minor: 0,
            currency: "JPY".to_string(),
            payment_method: "card".to_string(),
            outcome: "cancelled".to_string(),
            provider_payment_reference: None,
            tender_brand: None,
            provider_refundable: None,
            reason_code: Some("operator_cancelled".to_string()),
        };
        self.attempts
            .insert(attempt_id.to_string(), cancelled.clone());
        self.persist()?;
        Ok(result_message(request_id, &cancelled))
    }

    pub fn handle_inquire(&self, message: &Value) -> Result<Value, String> {
        let request_id = str_field(message, "requestId")?;
        let source_key = str_field(message, "sourceKey")?;
        let attempt_id = str_field(message, "paymentAttemptId")?;
        if let Some(existing) = self.attempts.get(attempt_id) {
            return Ok(result_message(request_id, existing));
        }
        Ok(json!({
            "type": "terminal_result",
            "requestId": request_id,
            "sourceKey": source_key,
            "paymentAttemptId": attempt_id,
            "outcome": "indeterminate",
            "providerPaymentReference": Value::Null,
            "paymentMethod": Value::Null,
            "tenderBrand": Value::Null,
            "providerRefundable": Value::Null,
            "reasonCode": "attempt_not_found",
        }))
    }
}

fn result_message(request_id: &str, entry: &JournaledTerminalAttempt) -> Value {
    json!({
        "type": "terminal_result",
        "requestId": request_id,
        "sourceKey": entry.source_key,
        "paymentAttemptId": entry.payment_attempt_id,
        "outcome": entry.outcome,
        "providerPaymentReference": entry.provider_payment_reference,
        "paymentMethod": entry.payment_method,
        "tenderBrand": entry.tender_brand,
        "providerRefundable": entry.provider_refundable,
        "reasonCode": entry.reason_code,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(label: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("shop_gateway_test_{label}_{nanos}"));
        fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    #[test]
    fn simulated_stera_card_felica_qr_and_drop_recovery() {
        let dir = temp_dir("stera");
        let rules = vec![
            SimulatedTerminalRule {
                match_attempt_prefix: Some("att_decline".to_string()),
                payment_method: None,
                outcome: "declined".to_string(),
                tender_brand: None,
                reason_code: Some("insufficient_funds".to_string()),
            },
            SimulatedTerminalRule {
                match_attempt_prefix: Some("att_drop".to_string()),
                payment_method: None,
                outcome: "drop_then_recover".to_string(),
                tender_brand: Some("FELICA_TRANSPORTATION".to_string()),
                reason_code: None,
            },
        ];

        {
            let mut journal = TerminalJournal::load(&dir).expect("load");
            // 1. Card capture
            let action = journal
                .handle_collect(
                    &json!({
                        "type": "terminal_collect",
                        "requestId": "req_1",
                        "sourceKey": "stera-counter-1",
                        "paymentAttemptId": "att_card_1",
                        "amountMinor": 1200,
                        "currency": "JPY",
                        "paymentMethod": "card",
                        "expiresAt": "2026-11-19T12:00:00Z"
                    }),
                    &rules,
                )
                .expect("collect card");
            match action {
                TerminalAction::SendResult(msg) => {
                    assert_eq!(msg["outcome"], "captured");
                    assert_eq!(msg["tenderBrand"], "VISA");
                    assert_eq!(msg["providerRefundable"], true);
                }
                TerminalAction::SimulateSocketDrop => panic!("unexpected drop"),
            }

            // 2. FeliCa capture marks providerRefundable: false
            let felica = journal
                .handle_collect(
                    &json!({
                        "type": "terminal_collect",
                        "requestId": "req_2",
                        "sourceKey": "stera-counter-1",
                        "paymentAttemptId": "att_felica_1",
                        "amountMinor": 650,
                        "currency": "JPY",
                        "paymentMethod": "felica",
                        "expiresAt": "2026-11-19T12:00:00Z"
                    }),
                    &rules,
                )
                .expect("collect felica");
            match felica {
                TerminalAction::SendResult(msg) => {
                    assert_eq!(msg["outcome"], "captured");
                    assert_eq!(msg["tenderBrand"], "FELICA_TRANSPORTATION");
                    assert_eq!(msg["providerRefundable"], false);
                }
                TerminalAction::SimulateSocketDrop => panic!("unexpected drop"),
            }

            // 3. Declined attempt
            let decline = journal
                .handle_collect(
                    &json!({
                        "type": "terminal_collect",
                        "requestId": "req_3",
                        "sourceKey": "stera-counter-1",
                        "paymentAttemptId": "att_decline_1",
                        "amountMinor": 500,
                        "currency": "JPY",
                        "paymentMethod": "card",
                        "expiresAt": "2026-11-19T12:00:00Z"
                    }),
                    &rules,
                )
                .expect("collect decline");
            match decline {
                TerminalAction::SendResult(msg) => {
                    assert_eq!(msg["outcome"], "declined");
                    assert_eq!(msg["reasonCode"], "insufficient_funds");
                }
                TerminalAction::SimulateSocketDrop => panic!("unexpected drop"),
            }

            // 4. Mid-flight drop persists captured attempt to disk
            let drop_action = journal
                .handle_collect(
                    &json!({
                        "type": "terminal_collect",
                        "requestId": "req_4",
                        "sourceKey": "stera-counter-1",
                        "paymentAttemptId": "att_drop_1",
                        "amountMinor": 980,
                        "currency": "JPY",
                        "paymentMethod": "felica",
                        "expiresAt": "2026-11-19T12:00:00Z"
                    }),
                    &rules,
                )
                .expect("collect drop");
            assert!(matches!(drop_action, TerminalAction::SimulateSocketDrop));
        }

        // Reload journal after simulated gateway restart and recover via terminal_inquire.
        let reloaded = TerminalJournal::load(&dir).expect("reload");
        let inquired = reloaded
            .handle_inquire(&json!({
                "type": "terminal_inquire",
                "requestId": "req_inquire_4",
                "sourceKey": "stera-counter-1",
                "paymentAttemptId": "att_drop_1"
            }))
            .expect("inquire");
        assert_eq!(inquired["outcome"], "captured");
        assert_eq!(inquired["providerPaymentReference"], "stera_sim_att_drop_1");
        assert_eq!(inquired["tenderBrand"], "FELICA_TRANSPORTATION");
        assert_eq!(inquired["providerRefundable"], false);

        let _ = fs::remove_dir_all(&dir);
    }
}
