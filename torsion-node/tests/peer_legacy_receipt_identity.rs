use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tempfile::tempdir;
use tokio_tungstenite::{accept_async, connect_async, tungstenite::Message};
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

async fn request<S>(socket: &mut tokio_tungstenite::WebSocketStream<S>, variant: u64) -> Value
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    send_json(
        socket,
        json!({"action":"node/request","data":{
            "protocolVersion":NODE_PROTOCOL,
            "operationId":"legacy-peer-id",
            "requestedAction":"node.status",
            "targetNodeId":"node-a",
            "input":{"variant":variant}
        }}),
    )
    .await;
    receive_json(socket).await
}

#[tokio::test]
async fn a_peer_receipt_without_a_fingerprint_cannot_downgrade_request_identity() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let peer_url = format!("ws://127.0.0.1:{}", listener.local_addr().unwrap().port());

    let fake_peer = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut socket = accept_async(stream).await.unwrap();
        let _hello = receive_json(&mut socket).await;
        send_json(
            &mut socket,
            json!({"action":"hello/ack","data":{
                "protocolVersion":NODE_PROTOCOL,"role":"node","nodeId":"node-a","authenticated":true
            }}),
        )
        .await;
        let request = receive_json(&mut socket).await;
        assert_eq!(request["data"]["input"]["variant"], 1);
        // Deliberately omit requestFingerprint to emulate an older peer.
        send_json(
            &mut socket,
            json!({"action":"node/result","data":{
                "protocolVersion":NODE_PROTOCOL,
                "operationId":"legacy-peer-id",
                "requestedAction":"node.status",
                "actor":null,
                "trustAccepted":true,
                "trustClassification":"trusted_installation_secret",
                "attemptCount":1,
                "finalStatus":"succeeded",
                "result":{"nodeId":"node-a","legacy":true},
                "outputEvidence":null,
                "error":null,
                "startedAt":"start",
                "finishedAt":"finish"
            }}),
        )
        .await;
    });

    let repo = tempdir().unwrap();
    let mut config = NodeConfig::new(repo.path(), "node-b", "ws://127.0.0.1:0").unwrap();
    config.operation_timeout_ms = 1_000;
    config.peers.insert("node-a".into(), peer_url);
    let node = spawn(config, SECRET).await.unwrap();
    let (mut client, _) = connect_async(node.url()).await.unwrap();
    send_json(
        &mut client,
        json!({"action":"hello","data":{
            "protocolVersion":CHANNEL_PROTOCOL,"role":"client","token":SECRET
        }}),
    )
    .await;
    assert_eq!(
        receive_json(&mut client).await["data"]["authenticated"],
        true
    );

    let first = request(&mut client, 1).await;
    assert_eq!(first["data"]["finalStatus"], "failed");
    assert!(
        first["data"]["error"]
            .as_str()
            .is_some_and(|error| error.contains("missing logical request fingerprint"))
    );

    // Even if the caller changes semantic input under the same operation id, the legacy peer
    // response must never become an action-only cached success at node-b.
    let second = request(&mut client, 2).await;
    assert_eq!(second["data"]["finalStatus"], "rejected");
    assert!(
        second["data"]["error"]
            .as_str()
            .is_some_and(|error| error.contains("different request"))
    );

    fake_peer.await.unwrap();
    node.shutdown().await.unwrap();
}
