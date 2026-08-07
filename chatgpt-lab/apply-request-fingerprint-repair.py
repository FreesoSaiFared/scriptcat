from pathlib import Path

protocol = Path("torsion-node/src/protocol.rs")
text = protocol.read_text(encoding="utf-8")
old = '''    pub operation_id: String,
    pub requested_action: RequestedAction,
    pub actor: Option<Actor>,
'''
new = '''    pub operation_id: String,
    pub requested_action: RequestedAction,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_fingerprint: Option<String>,
    pub actor: Option<Actor>,
'''
if text.count(old) != 1:
    raise SystemExit(f"protocol receipt anchor count={text.count(old)}")
protocol.write_text(text.replace(old, new), encoding="utf-8")

server = Path("torsion-node/src/server.rs")
text = server.read_text(encoding="utf-8")
old = '''        match self.store.begin_receipt(&pending).await {
            Ok(BeginReceipt::Claimed) => {}
            Ok(BeginReceipt::Existing(receipt)) => return *receipt,
            Err(error) => {
'''
new = '''        match self.store.begin_receipt(&pending).await {
            Ok(BeginReceipt::Claimed) => {}
            Ok(BeginReceipt::Existing(receipt)) => {
                let fingerprint_mismatch = match (
                    receipt.request_fingerprint.as_deref(),
                    pending.request_fingerprint.as_deref(),
                ) {
                    (Some(existing), Some(requested)) => existing != requested,
                    // Legacy receipts predate request fingerprints. Preserve the v7 action-level
                    // collision check rather than inventing information that was never persisted.
                    (None, _) => receipt.requested_action != request.requested_action,
                    (Some(_), None) => true,
                };
                if fingerprint_mismatch {
                    pending.final_status = FinalStatus::Rejected;
                    pending.error = Some(format!(
                        "operation id {} already belongs to a different request",
                        request.operation_id
                    ));
                    pending.output_evidence = json!({
                        "existingRequestedAction": receipt.requested_action.as_str(),
                        "existingRequestFingerprint": receipt.request_fingerprint,
                    });
                    pending.finished_at = Some(timestamp());
                    return pending;
                }
                return *receipt;
            }
            Err(error) => {
'''
if text.count(old) != 1:
    raise SystemExit(f"begin_receipt anchor count={text.count(old)}")
text = text.replace(old, new)

old = '''            operation_id: request.operation_id.clone(),
            requested_action: request.requested_action,
            actor: None,
'''
new = '''            operation_id: request.operation_id.clone(),
            requested_action: request.requested_action,
            request_fingerprint: Some(request_fingerprint(request)),
            actor: None,
'''
if text.count(old) != 1:
    raise SystemExit(f"pending receipt anchor count={text.count(old)}")
text = text.replace(old, new)

old = '''fn timestamp() -> String {
'''
new = '''fn request_fingerprint(request: &NodeRequest) -> String {
    // Routing is deliberately excluded: forwarding the same logical request through a peer
    // must retain the same identity. NodeRequest was already parsed from JSON, so this tuple
    // is deterministically serializable; serde_json's default map representation is ordered.
    let canonical = serde_json::to_vec(&(
        request.requested_action,
        &request.actor_id,
        &request.input,
    ))
    .expect("deserialized node requests are serializable");
    format!("{:x}", Sha256::digest(canonical))
}

fn timestamp() -> String {
'''
if text.count(old) != 1:
    raise SystemExit(f"timestamp anchor count={text.count(old)}")
server.write_text(text.replace(old, new), encoding="utf-8")
