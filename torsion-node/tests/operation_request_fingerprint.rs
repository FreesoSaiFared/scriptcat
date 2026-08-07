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

    send_json(
        &mut client,
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
    assert_eq!(receive_json(&mut client).await["data"]["authenticated"], true);

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
    assert_eq!(actor_collision["data"]["requestedAction"], "worker.register");
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

    node.shutdown().await.unwrap();
}
