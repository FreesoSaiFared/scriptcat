use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tempfile::tempdir;
use tokio_tungstenite::{connect_async, tungstenite::Message};
use torsion_node::{
    NodeConfig,
    protocol::{CHANNEL_PROTOCOL, NODE_PROTOCOL},
    spawn,
};

const SECRET: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

async fn send_json<S>(socket: &mut tokio_tungstenite::WebSocketStream<S>, value: Value)
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    socket
        .send(Message::Text(value.to_string().into()))
        .await
        .unwrap();
}

async fn receive_json<S>(socket: &mut tokio_tungstenite::WebSocketStream<S>) -> Value
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let message = socket.next().await.unwrap().unwrap();
    serde_json::from_slice(&message.into_data()).unwrap()
}

async fn authenticate<S>(socket: &mut tokio_tungstenite::WebSocketStream<S>)
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    send_json(
        socket,
        json!({
            "action": "hello",
            "data": {
                "protocolVersion": CHANNEL_PROTOCOL,
                "role": "client",
                "token": SECRET
            }
        }),
    )
    .await;
    assert_eq!(
        receive_json(socket).await["data"]["authenticated"],
        true
    );
}

async fn register_worker<S>(
    socket: &mut tokio_tungstenite::WebSocketStream<S>,
    repo: &std::path::Path,
    operation_id: &str,
    actor_id: &str,
    argv0: &str,
) -> Value
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    send_json(
        socket,
        json!({"action":"node/request","data":{
            "protocolVersion":NODE_PROTOCOL,
            "operationId":operation_id,
            "requestedAction":"worker.register",
            "actorId":actor_id,
            "input":{"cwd":repo,"argv":[argv0,"--version"]}
        }}),
    )
    .await;
    receive_json(socket).await
}

#[tokio::test]
async fn operation_id_is_bound_to_the_full_logical_request() {
    let repo = tempdir().unwrap();
    let node = spawn(
        NodeConfig::new(repo.path(), "node-a", "ws://127.0.0.1:0").unwrap(),
        SECRET,
    )
    .await
    .unwrap();
    let (mut client, _) = connect_async(node.url()).await.unwrap();
    authenticate(&mut client).await;

    let actor_first = register_worker(
        &mut client,
        repo.path(),
        "same-action-actor-collision",
        "worker-a",
        "rustc",
    )
    .await;
    assert_eq!(actor_first["data"]["finalStatus"], "succeeded");

    let actor_collision = register_worker(
        &mut client,
        repo.path(),
        "same-action-actor-collision",
        "worker-b",
        "rustc",
    )
    .await;
    assert_eq!(actor_collision["data"]["finalStatus"], "rejected");
    assert_eq!(
        actor_collision["data"]["requestedAction"],
        "worker.register"
    );
    assert!(
        actor_collision["data"]["error"]
            .as_str()
            .is_some_and(|error| error.contains("different request"))
    );

    let input_first = register_worker(
        &mut client,
        repo.path(),
        "same-action-input-collision",
        "worker-c",
        "rustc",
    )
    .await;
    assert_eq!(input_first["data"]["finalStatus"], "succeeded");

    let input_collision = register_worker(
        &mut client,
        repo.path(),
        "same-action-input-collision",
        "worker-c",
        "cargo",
    )
    .await;
    assert_eq!(input_collision["data"]["finalStatus"], "rejected");
    assert!(
        input_collision["data"]["error"]
            .as_str()
            .is_some_and(|error| error.contains("different request"))
    );

    let exact_replay = register_worker(
        &mut client,
        repo.path(),
        "same-action-input-collision",
        "worker-c",
        "rustc",
    )
    .await;
    assert_eq!(exact_replay, input_first);

    send_json(
        &mut client,
        serde_json::from_str(
            r#"{"action":"node/request","data":{"protocolVersion":"torsionfield-node-v1","operationId":"json-order-equivalence","requestedAction":"node.status","input":{"alpha":1,"beta":2}}}"#,
        )
        .unwrap(),
    )
    .await;
    let ordered_first = receive_json(&mut client).await;
    assert_eq!(ordered_first["data"]["finalStatus"], "succeeded");

    send_json(
        &mut client,
        serde_json::from_str(
            r#"{"action":"node/request","data":{"protocolVersion":"torsionfield-node-v1","operationId":"json-order-equivalence","requestedAction":"node.status","input":{"beta":2,"alpha":1}}}"#,
        )
        .unwrap(),
    )
    .await;
    let reordered_replay = receive_json(&mut client).await;
    assert_eq!(
        reordered_replay, ordered_first,
        "JSON object key order must not change logical request identity"
    );

    node.shutdown().await.unwrap();
}

#[tokio::test]
async fn request_identity_survives_node_restart() {
    let repo = tempdir().unwrap();
    let config = NodeConfig::new(repo.path(), "node-a", "ws://127.0.0.1:0").unwrap();

    let node = spawn(config.clone(), SECRET).await.unwrap();
    let (mut client, _) = connect_async(node.url()).await.unwrap();
    authenticate(&mut client).await;

    let first = register_worker(
        &mut client,
        repo.path(),
        "restart-durable-request",
        "restart-worker",
        "rustc",
    )
    .await;
    assert_eq!(first["data"]["finalStatus"], "succeeded");
    drop(client);
    node.shutdown().await.unwrap();

    let restarted = spawn(config, SECRET).await.unwrap();
    let (mut client, _) = connect_async(restarted.url()).await.unwrap();
    authenticate(&mut client).await;

    let replay = register_worker(
        &mut client,
        repo.path(),
        "restart-durable-request",
        "restart-worker",
        "rustc",
    )
    .await;
    assert_eq!(
        replay, first,
        "the persisted logical request must replay after restart"
    );

    let collision = register_worker(
        &mut client,
        repo.path(),
        "restart-durable-request",
        "restart-worker",
        "cargo",
    )
    .await;
    assert_eq!(collision["data"]["finalStatus"], "rejected");
    assert!(
        collision["data"]["error"]
            .as_str()
            .is_some_and(|error| error.contains("different request"))
    );

    restarted.shutdown().await.unwrap();
}
