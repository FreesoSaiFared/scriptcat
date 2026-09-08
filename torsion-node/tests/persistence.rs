use serde_json::json;
use tempfile::tempdir;
use torsion_node::{
    persistence::{BeginReceipt, StateStore},
    protocol::{Actor, FinalStatus, Receipt, RequestedAction, TabActor},
};

#[tokio::test]
async fn it_restores_actor_records_and_receipts_after_restart() {
    let repo = tempdir().unwrap();
    let store = StateStore::open(repo.path(), "node-a").await.unwrap();
    let actor = Actor::Tab(TabActor {
        actor_id: "fixture".into(),
        fixture_url: "http://127.0.0.1:9000/fixture".into(),
        tab_id: Some(42),
    });
    store.register_actor(actor.clone()).await.unwrap();

    let receipt = Receipt {
        protocol_version: "torsionfield-node-v1".into(),
        operation_id: "op-1".into(),
        requested_action: RequestedAction::TabRegister,
        actor: Some(actor.clone()),
        trust_accepted: true,
        trust_classification: "trusted_installation_secret".into(),
        attempt_count: 1,
        final_status: FinalStatus::Succeeded,
        result: json!({"registered": true}),
        output_evidence: serde_json::Value::Null,
        error: None,
        started_at: "2026-08-05T10:00:00Z".into(),
        finished_at: Some("2026-08-05T10:00:01Z".into()),
    };
    store.write_receipt(&receipt).await.unwrap();
    drop(store);

    let restored = StateStore::open(repo.path(), "node-a").await.unwrap();
    assert_eq!(restored.actor("fixture").await, Some(actor));
    assert_eq!(restored.receipt("op-1").await, Some(receipt));
    assert_eq!(restored.receipt_count().await, 1);
    assert!(
        repo.path()
            .join(".torsionfield-node/node-a/actors.json")
            .is_file()
    );
    assert!(
        repo.path()
            .join(".torsionfield-node/node-a/receipts.json")
            .is_file()
    );
}

#[tokio::test]
async fn it_claims_an_operation_id_once_without_replacing_its_in_progress_receipt() {
    let repo = tempdir().unwrap();
    let store = StateStore::open(repo.path(), "node-a").await.unwrap();
    let receipt = pending_receipt("op-claim", "first");
    let mut claims = Vec::new();
    for _ in 0..16 {
        let store = store.clone();
        let receipt = receipt.clone();
        claims.push(tokio::spawn(async move {
            store.begin_receipt(&receipt).await.unwrap()
        }));
    }

    let mut claimed = 0;
    for claim in claims {
        match claim.await.unwrap() {
            BeginReceipt::Claimed => claimed += 1,
            BeginReceipt::Existing(existing) => assert_eq!(*existing, receipt),
        }
    }
    assert_eq!(claimed, 1);
}

#[tokio::test]
async fn it_rolls_back_actor_and_receipt_mutations_when_atomic_persistence_fails() {
    let repo = tempdir().unwrap();
    let store = StateStore::open(repo.path(), "node-a").await.unwrap();
    let original_actor = Actor::Tab(TabActor {
        actor_id: "fixture".into(),
        fixture_url: "http://127.0.0.1:9000/original".into(),
        tab_id: Some(1),
    });
    store.register_actor(original_actor.clone()).await.unwrap();
    let original_receipt = pending_receipt("op-rollback", "original");
    store.write_receipt(&original_receipt).await.unwrap();

    let state_dir = repo.path().join(".torsionfield-node/node-a");
    std::fs::remove_file(state_dir.join("actors.json")).unwrap();
    std::fs::create_dir(state_dir.join("actors.json")).unwrap();
    let replacement_actor = Actor::Tab(TabActor {
        actor_id: "fixture".into(),
        fixture_url: "http://127.0.0.1:9000/replacement".into(),
        tab_id: Some(2),
    });
    assert!(store.register_actor(replacement_actor).await.is_err());
    assert_eq!(store.actor("fixture").await, Some(original_actor));

    std::fs::remove_file(state_dir.join("receipts.json")).unwrap();
    std::fs::create_dir(state_dir.join("receipts.json")).unwrap();
    let replacement_receipt = pending_receipt("op-rollback", "replacement");
    assert!(store.write_receipt(&replacement_receipt).await.is_err());
    assert_eq!(store.receipt("op-rollback").await, Some(original_receipt));
}

fn pending_receipt(operation_id: &str, marker: &str) -> Receipt {
    Receipt {
        protocol_version: "torsionfield-node-v1".into(),
        operation_id: operation_id.into(),
        requested_action: RequestedAction::NodeStatus,
        actor: None,
        trust_accepted: true,
        trust_classification: "trusted_installation_secret".into(),
        attempt_count: 1,
        final_status: FinalStatus::InProgress,
        result: json!({"marker": marker}),
        output_evidence: serde_json::Value::Null,
        error: None,
        started_at: "2026-08-05T10:00:00Z".into(),
        finished_at: None,
    }
}
