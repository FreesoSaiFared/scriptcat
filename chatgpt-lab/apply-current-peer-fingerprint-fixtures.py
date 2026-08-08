from pathlib import Path

path = Path("torsion-node/tests/server.rs")
text = path.read_text(encoding="utf-8")

old = '''use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
'''
new = '''use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
'''
if text.count(old) != 1:
    raise SystemExit(f"import anchor count={text.count(old)}")
text = text.replace(old, new)

old = '''const SECRET: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

async fn send_json'''
new = '''const SECRET: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

fn logical_request_fingerprint(request: &Value, current_node_id: &str) -> String {
    let data = &request["data"];
    let effective_target_node_id = data["targetNodeId"].as_str().unwrap_or(current_node_id);
    let canonical = serde_json::to_vec(&(
        &data["requestedAction"],
        &data["actorId"],
        effective_target_node_id,
        &data["input"],
    ))
    .unwrap();
    format!("{:x}", Sha256::digest(canonical))
}

async fn send_json'''
if text.count(old) != 1:
    raise SystemExit(f"helper anchor count={text.count(old)}")
text = text.replace(old, new)

old = '''        let request = receive_json(&mut socket).await;
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        send_json(&mut socket, json!({"action":"node/result","data":{
            "protocolVersion":NODE_PROTOCOL,"operationId":request["data"]["operationId"],
            "requestedAction":"worker.run","actor":null,"trustAccepted":true,
'''
new = '''        let request = receive_json(&mut socket).await;
        let request_fingerprint = logical_request_fingerprint(&request, "node-a");
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        send_json(&mut socket, json!({"action":"node/result","data":{
            "protocolVersion":NODE_PROTOCOL,"operationId":request["data"]["operationId"],
            "requestedAction":"worker.run","requestFingerprint":request_fingerprint,
            "actor":null,"trustAccepted":true,
'''
if text.count(old) != 1:
    raise SystemExit(f"long-worker anchor count={text.count(old)}")
text = text.replace(old, new)

old = '''        let original = receive_json(&mut first).await;
        assert_eq!(original["data"]["requestedAction"], "worker.run");
        send_json(
            &mut first,
            json!({"action":"node/result","data":{
                "protocolVersion":NODE_PROTOCOL,"operationId":"polled-peer-worker",
                "requestedAction":"worker.run","actor":null,"trustAccepted":true,
'''
new = '''        let original = receive_json(&mut first).await;
        assert_eq!(original["data"]["requestedAction"], "worker.run");
        let original_fingerprint = logical_request_fingerprint(&original, "node-a");
        send_json(
            &mut first,
            json!({"action":"node/result","data":{
                "protocolVersion":NODE_PROTOCOL,"operationId":"polled-peer-worker",
                "requestedAction":"worker.run","requestFingerprint":original_fingerprint.clone(),
                "actor":null,"trustAccepted":true,
'''
if text.count(old) != 1:
    raise SystemExit(f"poll-original anchor count={text.count(old)}")
text = text.replace(old, new)

old = '''                    "protocolVersion":NODE_PROTOCOL,"operationId":"polled-peer-worker",
                    "requestedAction":"worker.run","actor":null,"trustAccepted":true,
                    "trustClassification":"trusted_installation_secret","attemptCount":1,
'''
new = '''                    "protocolVersion":NODE_PROTOCOL,"operationId":"polled-peer-worker",
                    "requestedAction":"worker.run","requestFingerprint":original_fingerprint,
                    "actor":null,"trustAccepted":true,
                    "trustClassification":"trusted_installation_secret","attemptCount":1,
'''
if text.count(old) != 1:
    raise SystemExit(f"poll-subject anchor count={text.count(old)}")
text = text.replace(old, new)

path.write_text(text, encoding="utf-8")
