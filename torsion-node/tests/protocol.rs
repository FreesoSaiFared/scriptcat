use serde_json::json;
use torsion_node::protocol::{
    CHANNEL_PROTOCOL, NODE_PROTOCOL, NodeRequestFrame, RequestedAction, validate_peer_ack,
};

#[test]
fn it_exposes_only_the_v01_public_operations() {
    let names: Vec<_> = RequestedAction::ALL
        .iter()
        .copied()
        .map(RequestedAction::as_str)
        .collect();

    assert_eq!(
        names,
        [
            "node.status",
            "script.install",
            "script.update",
            "script.status",
            "extension.reload",
            "tab.register",
            "tab.list",
            "tab.invoke",
            "worker.register",
            "worker.run",
        ]
    );
    assert_eq!(CHANNEL_PROTOCOL, "torsionfield-script-v1");
    assert_eq!(NODE_PROTOCOL, "torsionfield-node-v1");
}

#[test]
fn it_rejects_an_operation_outside_the_public_allowlist() {
    let value = json!({
        "action": "node/request",
        "data": {
            "protocolVersion": NODE_PROTOCOL,
            "operationId": "op-1",
            "requestedAction": "worker.delete",
            "input": {}
        }
    });

    assert!(serde_json::from_value::<NodeRequestFrame>(value).is_err());
}

#[test]
fn it_accepts_only_an_authenticated_ack_from_the_exact_configured_peer() {
    let valid = json!({
        "action": "hello/ack",
        "data": {
            "protocolVersion": NODE_PROTOCOL,
            "role": "node",
            "nodeId": "node-a",
            "authenticated": true
        }
    });
    validate_peer_ack(&valid, "node-a").unwrap();

    for pointer in [
        "/action",
        "/data/protocolVersion",
        "/data/role",
        "/data/nodeId",
        "/data/authenticated",
    ] {
        let mut invalid = valid.clone();
        *invalid.pointer_mut(pointer).unwrap() = json!("wrong");
        assert!(
            validate_peer_ack(&invalid, "node-a").is_err(),
            "accepted invalid {pointer}"
        );
    }
}
