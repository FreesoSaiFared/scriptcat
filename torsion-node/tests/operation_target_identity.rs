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
            "action":"hello",
            "data":{
                "protocolVersion":CHANNEL_PROTOCOL,
                "role":"client",
                "token":SECRET
            }
        }),
    )
    .await;
    assert_eq!(receive_json(socket).await["data"]["authenticated"], true);
}

async fn targeted_status<S>(
    socket: &mut tokio_tungstenite::WebSocketStream<S>,
    operation_id: &str,
    target_node_id: &str,
) -> Value
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    send_json(
        socket,
        json!({"action":"node/request","data":{
            "protocolVersion":NODE_PROTOCOL,
            "operationId":operation_id,
            "requestedAction":"node.status",
            "targetNodeId":target_node_id,
            "input":{}
        }}),
    )
    .await;
    receive_json(socket).await
}

#[tokio::test]
async fn operation_id_is_bound_to_the_effective_target_node() {
    let repo_a = tempdir().unwrap();
    let node_a = spawn(
        NodeConfig::new(repo_a.path(), "node-a", "ws://127.0.0.1:0").unwrap(),
        SECRET,
    )
    .await
    .unwrap();

    let repo_c = tempdir().unwrap();
    let node_c = spawn(
        NodeConfig::new(repo_c.path(), "node-c", "ws://127.0.0.1:0").unwrap(),
        SECRET,
    )
    .await
    .unwrap();

    let repo_b = tempdir().unwrap();
    let mut config_b = NodeConfig::new(repo_b.path(), "node-b", "ws://127.0.0.1:0").unwrap();
    config_b.peers.insert("node-a".into(), node_a.url().into());
    config_b.peers.insert("node-c".into(), node_c.url().into());
    let node_b = spawn(config_b, SECRET).await.unwrap();

    let (mut client, _) = connect_async(node_b.url()).await.unwrap();
    authenticate(&mut client).await;

    let first = targeted_status(&mut client, "target-sensitive-id", "node-a").await;
    assert_eq!(first["data"]["finalStatus"], "succeeded");
    assert_eq!(first["data"]["result"]["nodeId"], "node-a");

    let exact_replay = targeted_status(&mut client, "target-sensitive-id", "node-a").await;
    assert_eq!(exact_replay, first);

    let changed_target = targeted_status(&mut client, "target-sensitive-id", "node-c").await;
    assert_eq!(changed_target["data"]["finalStatus"], "rejected");
    assert!(
        changed_target["data"]["error"]
            .as_str()
            .is_some_and(|error| error.contains("different request"))
    );

    node_b.shutdown().await.unwrap();
    node_c.shutdown().await.unwrap();
    node_a.shutdown().await.unwrap();
}
