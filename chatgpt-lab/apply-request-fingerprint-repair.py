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
                let action_mismatch = receipt.requested_action != request.requested_action;
                let fingerprint_mismatch = match (
                    receipt.request_fingerprint.as_deref(),
                    pending.request_fingerprint.as_deref(),
                ) {
                    (Some(existing), Some(requested)) => existing != requested,
                    (None, _) => action_mismatch,
                    (Some(_), None) => true,
                };
                if fingerprint_mismatch {
                    pending.final_status = FinalStatus::Rejected;
                    pending.error = Some(if action_mismatch {
                        format!(
                            "operation id {} already belongs to {}",
                            request.operation_id,
                            receipt.requested_action.as_str()
                        )
                    } else {
                        format!(
                            "operation id {} already belongs to a different request",
                            request.operation_id
                        )
                    });
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
            request_fingerprint: Some(request_fingerprint(request, &self.node_id)),
            actor: None,
'''
if text.count(old) != 1:
    raise SystemExit(f"pending receipt anchor count={text.count(old)}")
text = text.replace(old, new)

old = '''fn timestamp() -> String {
'''
new = '''fn request_fingerprint(request: &NodeRequest, current_node_id: &str) -> String {
    // The effective destination is part of the requested effect. Normalize a direct local
    // request to the current node id so direct and peer-forwarded forms of the same logical
    // request retain one identity, while changing the destination under one operation id is
    // rejected rather than replaying another node's receipt.
    let effective_target_node_id = request.target_node_id.as_deref().unwrap_or(current_node_id);
    let canonical = serde_json::to_vec(&(
        request.requested_action,
        &request.actor_id,
        effective_target_node_id,
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

persistence = Path("torsion-node/tests/persistence.rs")
text = persistence.read_text(encoding="utf-8")
anchors = (
    '''        requested_action: RequestedAction::TabRegister,\n        actor: Some(actor.clone()),\n''',
    '''        requested_action: RequestedAction::NodeStatus,\n        actor: None,\n''',
)
replacements = (
    '''        requested_action: RequestedAction::TabRegister,\n        request_fingerprint: None,\n        actor: Some(actor.clone()),\n''',
    '''        requested_action: RequestedAction::NodeStatus,\n        request_fingerprint: None,\n        actor: None,\n''',
)
for anchor, replacement in zip(anchors, replacements):
    if text.count(anchor) != 1:
        raise SystemExit(f"persistence receipt anchor count={text.count(anchor)} for {anchor!r}")
    text = text.replace(anchor, replacement)
persistence.write_text(text, encoding="utf-8")
