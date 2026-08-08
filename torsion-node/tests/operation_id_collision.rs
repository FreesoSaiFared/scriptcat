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

#[tokio::test]
async fn it_rejects_reusing_an_operation_id_for_a_different_action() {
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
    assert_eq!(
        receive_json(&mut client).await["data"]["authenticated"],
        true
    );

    send_json(
        &mut client,
        json!({"action":"node/request","data":{
            "protocolVersion":NODE_PROTOCOL,
            "operationId":"collision-1",
            "requestedAction":"node.status",
            "input":{}
        }}),
    )
    .await;
    let first = receive_json(&mut client).await;
    assert_eq!(first["data"]["finalStatus"], "succeeded");
    assert_eq!(first["data"]["requestedAction"], "node.status");

    send_json(
        &mut client,
        json!({"action":"node/request","data":{
            "protocolVersion":NODE_PROTOCOL,
            "operationId":"collision-1",
            "requestedAction":"worker.register",
            "actorId":"collision-worker",
            "input":{"cwd":repo.path(),"argv":["rustc","--version"]}
        }}),
    )
    .await;
    let collision = receive_json(&mut client).await;

    assert_eq!(collision["data"]["operationId"], "collision-1");
    assert_eq!(collision["data"]["requestedAction"], "worker.register");
    assert_eq!(collision["data"]["finalStatus"], "rejected");
    assert!(
        collision["data"]["error"]
            .as_str()
            .is_some_and(|error| error.contains("already belongs to node.status"))
    );

    send_json(
        &mut client,
        json!({"action":"node/request","data":{
            "protocolVersion":NODE_PROTOCOL,
            "operationId":"collision-1",
            "requestedAction":"node.status",
            "input":{}
        }}),
    )
    .await;
    let replay = receive_json(&mut client).await;
    assert_eq!(replay, first, "the original idempotent receipt must remain intact");

    node.shutdown().await.unwrap();
}
