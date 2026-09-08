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

async fn authenticate<S>(
    socket: &mut tokio_tungstenite::WebSocketStream<S>,
    role: &str,
    node_id: Option<&str>,
) -> Value
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    send_json(
        socket,
        json!({
            "action": "hello",
            "data": {
                "protocolVersion": CHANNEL_PROTOCOL,
                "role": role,
                "token": SECRET,
                "nodeId": node_id,
            }
        }),
    )
    .await;
    receive_json(socket).await
}

#[tokio::test]
async fn it_authenticates_before_serving_node_status() {
    let repo = tempdir().unwrap();
    let node = spawn(
        NodeConfig::new(repo.path(), "node-a", "ws://127.0.0.1:0").unwrap(),
        SECRET,
    )
    .await
    .unwrap();

    let (mut rejected, _) = connect_async(node.url()).await.unwrap();
    send_json(
        &mut rejected,
        json!({"action":"hello","data":{"protocolVersion":CHANNEL_PROTOCOL,"role":"client","token":"wrong"}}),
    )
    .await;
    let rejection = receive_json(&mut rejected).await;
    assert_eq!(rejection["action"], "hello/ack");
    assert_eq!(rejection["data"]["authenticated"], false);

    let (mut client, _) = connect_async(node.url()).await.unwrap();
    let ack = authenticate(&mut client, "client", None).await;
    assert_eq!(ack["action"], "hello/ack");
    assert_eq!(ack["data"]["protocolVersion"], NODE_PROTOCOL);
    assert_eq!(ack["data"]["authenticated"], true);
    assert_eq!(ack["data"]["nodeId"], "node-a");

    send_json(
        &mut client,
        json!({"action":"node/request","data":{
            "protocolVersion":NODE_PROTOCOL,"operationId":"status-1","requestedAction":"node.status","input":{}
        }}),
    )
    .await;
    let response = receive_json(&mut client).await;
    assert_eq!(response["action"], "node/result");
    assert_eq!(response["data"]["finalStatus"], "succeeded");
    assert_eq!(response["data"]["actor"]["kind"], "node");
    assert_eq!(response["data"]["result"]["nodeId"], "node-a");
    assert_eq!(response["data"]["result"]["extensionConnected"], false);
    assert_eq!(
        response["data"]["result"]["extensionConnectionId"],
        Value::Null
    );

    node.shutdown().await.unwrap();
}

#[tokio::test]
async fn it_relays_script_frames_unchanged_to_the_authenticated_extension() {
    let repo = tempdir().unwrap();
    let node = spawn(
        NodeConfig::new(repo.path(), "node-a", "ws://127.0.0.1:0").unwrap(),
        SECRET,
    )
    .await
    .unwrap();
    let (mut extension, _) = connect_async(node.url()).await.unwrap();
    authenticate(&mut extension, "extension", None).await;
    let (mut client, _) = connect_async(node.url()).await.unwrap();
    authenticate(&mut client, "client", None).await;

    send_json(
        &mut client,
        json!({"action":"node/request","data":{
            "protocolVersion":NODE_PROTOCOL,"operationId":"extension-status-1",
            "requestedAction":"node.status","input":{}
        }}),
    )
    .await;
    let status = receive_json(&mut client).await;
    assert_eq!(status["data"]["result"]["extensionConnected"], true);
    assert!(status["data"]["result"]["extensionConnectionId"].is_u64());

    send_json(
        &mut client,
        json!({"action":"node/request","data":{
            "protocolVersion":NODE_PROTOCOL,
            "operationId":"install-1",
            "requestedAction":"script.install",
            "input":{"sourceUri":"file:///fixture.user.js","code":"// ==UserScript==\n// @name fixture\n// ==/UserScript=="}
        }}),
    )
    .await;

    let relayed = receive_json(&mut extension).await;
    assert_eq!(relayed["action"], "torsionfield");
    assert_eq!(relayed["data"]["protocolVersion"], CHANNEL_PROTOCOL);
    assert_eq!(relayed["data"]["operationId"], "install-1");
    assert_eq!(relayed["data"]["requestedAction"], "install");
    assert_eq!(relayed["data"]["token"], SECRET);
    assert_eq!(relayed["data"]["sourceUri"], "file:///fixture.user.js");

    let extension_result = json!({
        "protocolVersion":CHANNEL_PROTOCOL,"operationId":"install-1","requestedAction":"install",
        "trustAccepted":true,"trustClassification":"trusted_local_file","scriptId":"script-1",
        "scriptName":"fixture","requestedVersion":null,"installedVersion":null,"attemptCount":1,
        "finalStatus":"succeeded","executionVerification":{"status":"not_run"},"error":null
    });
    send_json(
        &mut extension,
        json!({"action":"torsionfield/result","data":extension_result}),
    )
    .await;
    let response = receive_json(&mut client).await;
    assert_eq!(response["data"]["actor"]["kind"], "extension");
    assert_eq!(response["data"]["result"], extension_result);
    assert_eq!(
        response["data"]["outputEvidence"],
        json!({"status":"not_run"})
    );

    node.shutdown().await.unwrap();
}

#[tokio::test]
async fn it_forwards_a_targeted_command_to_a_configured_peer() {
    let repo_a = tempdir().unwrap();
    let node_a = spawn(
        NodeConfig::new(repo_a.path(), "node-a", "ws://127.0.0.1:0").unwrap(),
        SECRET,
    )
    .await
    .unwrap();
    let repo_b = tempdir().unwrap();
    let mut config_b = NodeConfig::new(repo_b.path(), "node-b", "ws://127.0.0.1:0").unwrap();
    config_b.peers.insert("node-a".into(), node_a.url().into());
    let node_b = spawn(config_b, SECRET).await.unwrap();
    let (mut client, _) = connect_async(node_b.url()).await.unwrap();
    authenticate(&mut client, "client", None).await;

    send_json(
        &mut client,
        json!({"action":"node/request","data":{
            "protocolVersion":NODE_PROTOCOL,"operationId":"peer-status-1","requestedAction":"node.status",
            "targetNodeId":"node-a","input":{}
        }}),
    )
    .await;
    let response = receive_json(&mut client).await;
    assert_eq!(response["data"]["finalStatus"], "succeeded");
    assert_eq!(response["data"]["result"]["nodeId"], "node-a");

    node_b.shutdown().await.unwrap();
    node_a.shutdown().await.unwrap();
}

#[tokio::test]
async fn it_retries_a_peer_until_the_restarted_node_is_available() {
    let reservation = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let peer_url = format!(
        "ws://127.0.0.1:{}",
        reservation.local_addr().unwrap().port()
    );
    drop(reservation);

    let repo_b = tempdir().unwrap();
    let mut config_b = NodeConfig::new(repo_b.path(), "node-b", "ws://127.0.0.1:0").unwrap();
    config_b.operation_timeout_ms = 5_000;
    config_b.peers.insert("node-a".into(), peer_url.clone());
    let node_b = spawn(config_b, SECRET).await.unwrap();
    let (mut client, _) = connect_async(node_b.url()).await.unwrap();
    authenticate(&mut client, "client", None).await;
    send_json(
        &mut client,
        json!({"action":"node/request","data":{
            "protocolVersion":NODE_PROTOCOL,"operationId":"peer-retry-1","requestedAction":"node.status",
            "targetNodeId":"node-a","input":{}
        }}),
    )
    .await;

    tokio::time::sleep(std::time::Duration::from_millis(600)).await;
    let repo_a = tempdir().unwrap();
    let node_a = spawn(
        NodeConfig::new(repo_a.path(), "node-a", peer_url).unwrap(),
        SECRET,
    )
    .await
    .unwrap();
    let response = receive_json(&mut client).await;
    assert_eq!(response["data"]["finalStatus"], "succeeded");
    assert_eq!(response["data"]["result"]["nodeId"], "node-a");
    assert!(response["data"]["attemptCount"].as_u64().unwrap() >= 2);

    node_b.shutdown().await.unwrap();
    node_a.shutdown().await.unwrap();
}

#[tokio::test]
async fn it_rejects_worker_bindings_outside_the_repo_or_without_bounded_argv() {
    let repo = tempdir().unwrap();
    let outside = tempdir().unwrap();
    let node = spawn(
        NodeConfig::new(repo.path(), "node-a", "ws://127.0.0.1:0").unwrap(),
        SECRET,
    )
    .await
    .unwrap();
    let (mut client, _) = connect_async(node.url()).await.unwrap();
    authenticate(&mut client, "client", None).await;

    let cases = [
        (
            "outside-cwd",
            json!({"cwd": outside.path(), "argv": ["rustc", "--version"]}),
        ),
        ("empty-argv", json!({"cwd": repo.path(), "argv": []})),
        (
            "unbounded-timeout",
            json!({"cwd": repo.path(), "argv": ["rustc", "--version"], "timeoutMs": 300001}),
        ),
    ];
    for (operation_id, input) in cases {
        send_json(
            &mut client,
            json!({"action":"node/request","data":{
                "protocolVersion":NODE_PROTOCOL,"operationId":operation_id,"requestedAction":"worker.register",
                "actorId":operation_id,"input":input
            }}),
        )
        .await;
        let response = receive_json(&mut client).await;
        assert!(matches!(
            response["data"]["finalStatus"].as_str(),
            Some("failed" | "rejected")
        ));
        assert!(
            response["data"]["error"]
                .as_str()
                .is_some_and(|error| !error.is_empty())
        );
    }

    node.shutdown().await.unwrap();
}

#[tokio::test]
async fn it_always_verifies_tab_registration_with_scriptcat_and_offers_exact_actor_records_to_peers()
 {
    let repo_a = tempdir().unwrap();
    let node_a = spawn(
        NodeConfig::new(repo_a.path(), "node-a", "ws://127.0.0.1:0").unwrap(),
        SECRET,
    )
    .await
    .unwrap();
    let (mut extension, _) = connect_async(node_a.url()).await.unwrap();
    authenticate(&mut extension, "extension", None).await;
    let (mut client_a, _) = connect_async(node_a.url()).await.unwrap();
    authenticate(&mut client_a, "client", None).await;
    let fixture_url = "http://127.0.0.1:9000/fixture";

    send_json(
        &mut client_a,
        json!({"action":"node/request","data":{
            "protocolVersion":NODE_PROTOCOL,"operationId":"tab-register-explicit","requestedAction":"tab.register",
            "actorId":"fixture-tab","input":{"fixtureUrl":fixture_url,"tabId":42}
        }}),
    )
    .await;
    let relayed = tokio::time::timeout(
        std::time::Duration::from_secs(1),
        receive_json(&mut extension),
    )
    .await
    .expect("tab.register was not relayed to ScriptCat");
    assert_eq!(relayed["data"]["requestedAction"], "tab.register");
    assert_eq!(relayed["data"]["tabId"], 42);
    send_json(
        &mut extension,
        json!({"action":"torsionfield/result","data":{
            "protocolVersion":CHANNEL_PROTOCOL,"operationId":"tab-register-explicit","requestedAction":"tab.register",
            "trustAccepted":true,"trustClassification":"trusted_local_channel","scriptId":null,"scriptName":null,
            "requestedVersion":null,"installedVersion":null,"attemptCount":1,"finalStatus":"succeeded",
            "executionVerification":{"status":"not_run"},"error":null,"fixtureUrl":fixture_url,
            "tabs":[{"tabId":42,"url":fixture_url}],"postcondition":null
        }}),
    )
    .await;
    let registered = receive_json(&mut client_a).await;
    assert_eq!(registered["data"]["finalStatus"], "succeeded");

    send_json(
        &mut client_a,
        json!({"action":"node/request","data":{
            "protocolVersion":NODE_PROTOCOL,"operationId":"worker-register-offer","requestedAction":"worker.register",
            "actorId":"focused-worker","input":{"cwd":repo_a.path(),"argv":["rustc","--version"],"timeoutMs":300000}
        }}),
    )
    .await;
    assert_eq!(
        receive_json(&mut client_a).await["data"]["finalStatus"],
        "succeeded"
    );

    let repo_b = tempdir().unwrap();
    let mut config_b = NodeConfig::new(repo_b.path(), "node-b", "ws://127.0.0.1:0").unwrap();
    config_b.peers.insert("node-a".into(), node_a.url().into());
    let node_b = spawn(config_b, SECRET).await.unwrap();
    let (mut client_b, _) = connect_async(node_b.url()).await.unwrap();
    authenticate(&mut client_b, "client", None).await;
    send_json(
        &mut client_b,
        json!({"action":"node/request","data":{
            "protocolVersion":NODE_PROTOCOL,"operationId":"peer-offers","requestedAction":"node.status",
            "targetNodeId":"node-a","input":{}
        }}),
    )
    .await;
    let status = receive_json(&mut client_b).await;
    let offers = status["data"]["result"]["actors"]["offered"]
        .as_array()
        .expect("node.status omitted exact actor offers");
    assert!(
        offers
            .iter()
            .any(|actor| actor["kind"] == "tab" && actor["actorId"] == "fixture-tab")
    );
    assert!(
        offers
            .iter()
            .any(|actor| actor["kind"] == "worker" && actor["actorId"] == "focused-worker")
    );

    node_b.shutdown().await.unwrap();
    node_a.shutdown().await.unwrap();
}

#[tokio::test]
async fn it_returns_the_existing_in_progress_receipt_without_relaying_a_duplicate_operation() {
    let repo = tempdir().unwrap();
    let node = spawn(
        NodeConfig::new(repo.path(), "node-a", "ws://127.0.0.1:0").unwrap(),
        SECRET,
    )
    .await
    .unwrap();
    let (mut extension, _) = connect_async(node.url()).await.unwrap();
    authenticate(&mut extension, "extension", None).await;
    let (mut first, _) = connect_async(node.url()).await.unwrap();
    authenticate(&mut first, "client", None).await;
    let (mut duplicate, _) = connect_async(node.url()).await.unwrap();
    authenticate(&mut duplicate, "client", None).await;
    let request = json!({"action":"node/request","data":{
        "protocolVersion":NODE_PROTOCOL,"operationId":"duplicate-install","requestedAction":"script.install",
        "input":{"sourceUri":"file:///fixture.user.js","code":"// ==UserScript==\n// @name fixture\n// ==/UserScript=="}
    }});

    send_json(&mut first, request.clone()).await;
    let relayed = receive_json(&mut extension).await;
    send_json(&mut duplicate, request).await;
    let duplicate_result = receive_json(&mut duplicate).await;
    assert_eq!(duplicate_result["data"]["finalStatus"], "in_progress");
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(150), extension.next())
            .await
            .is_err(),
        "duplicate operation was relayed twice"
    );

    let mut completed = relayed["data"].clone();
    completed["trustAccepted"] = json!(true);
    completed["trustClassification"] = json!("trusted_local_file");
    completed["scriptId"] = json!("script-1");
    completed["scriptName"] = json!("fixture");
    completed["requestedVersion"] = Value::Null;
    completed["installedVersion"] = Value::Null;
    completed["attemptCount"] = json!(1);
    completed["finalStatus"] = json!("succeeded");
    completed["executionVerification"] = json!({"status":"not_run"});
    completed["error"] = Value::Null;
    send_json(
        &mut extension,
        json!({"action":"torsionfield/result","data":completed}),
    )
    .await;
    assert_eq!(
        receive_json(&mut first).await["data"]["finalStatus"],
        "succeeded"
    );

    node.shutdown().await.unwrap();
}

#[tokio::test]
async fn it_reports_all_failed_peer_connection_attempts() {
    let reservation = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let peer_url = format!(
        "ws://127.0.0.1:{}",
        reservation.local_addr().unwrap().port()
    );
    drop(reservation);
    let repo = tempdir().unwrap();
    let mut config = NodeConfig::new(repo.path(), "node-b", "ws://127.0.0.1:0").unwrap();
    config.operation_timeout_ms = 900;
    config.peers.insert("node-a".into(), peer_url);
    let node = spawn(config, SECRET).await.unwrap();
    let (mut client, _) = connect_async(node.url()).await.unwrap();
    authenticate(&mut client, "client", None).await;
    send_json(
        &mut client,
        json!({"action":"node/request","data":{
            "protocolVersion":NODE_PROTOCOL,"operationId":"failed-peer-attempts","requestedAction":"node.status",
            "targetNodeId":"node-a","input":{}
        }}),
    )
    .await;
    let response = receive_json(&mut client).await;
    assert_eq!(response["data"]["finalStatus"], "failed");
    assert!(response["data"]["attemptCount"].as_u64().unwrap() >= 2);
    node.shutdown().await.unwrap();
}

#[tokio::test]
async fn it_allows_a_peer_worker_to_outlive_the_generic_operation_timeout() {
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
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        send_json(&mut socket, json!({"action":"node/result","data":{
            "protocolVersion":NODE_PROTOCOL,"operationId":request["data"]["operationId"],
            "requestedAction":"worker.run","actor":null,"trustAccepted":true,
            "trustClassification":"trusted_installation_secret","attemptCount":1,"finalStatus":"succeeded",
            "result":{"command":["rustc","--version"],"cwd":".","start":"start","finish":"finish",
                "exitCode":0,"stdout":"ok","stderr":"","testCount":1,"resultHash":"00","timedOut":false,
                "stdoutTruncated":false,"stderrTruncated":false},
            "outputEvidence":null,"error":null,"startedAt":"start","finishedAt":"finish"
        }})).await;
    });
    let repo = tempdir().unwrap();
    let mut config = NodeConfig::new(repo.path(), "node-b", "ws://127.0.0.1:0").unwrap();
    config.operation_timeout_ms = 100;
    config.peers.insert("node-a".into(), peer_url);
    let node = spawn(config, SECRET).await.unwrap();
    let (mut client, _) = connect_async(node.url()).await.unwrap();
    authenticate(&mut client, "client", None).await;
    send_json(&mut client, json!({"action":"node/request","data":{
        "protocolVersion":NODE_PROTOCOL,"operationId":"long-peer-worker","requestedAction":"worker.run",
        "actorId":"focused-worker","targetNodeId":"node-a","input":{}
    }})).await;
    let response = receive_json(&mut client).await;
    assert_eq!(response["data"]["finalStatus"], "succeeded");
    fake_peer.await.unwrap();
    node.shutdown().await.unwrap();
}

#[tokio::test]
async fn it_polls_an_in_progress_peer_receipt_without_resubmitting_the_operation() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let peer_url = format!("ws://127.0.0.1:{}", listener.local_addr().unwrap().port());
    let fake_peer = tokio::spawn(async move {
        let (first_stream, _) = listener.accept().await.unwrap();
        let mut first = accept_async(first_stream).await.unwrap();
        let _hello = receive_json(&mut first).await;
        send_json(
            &mut first,
            json!({"action":"hello/ack","data":{
                "protocolVersion":NODE_PROTOCOL,"role":"node","nodeId":"node-a","authenticated":true
            }}),
        )
        .await;
        let original = receive_json(&mut first).await;
        assert_eq!(original["data"]["requestedAction"], "worker.run");
        send_json(
            &mut first,
            json!({"action":"node/result","data":{
                "protocolVersion":NODE_PROTOCOL,"operationId":"polled-peer-worker",
                "requestedAction":"worker.run","actor":null,"trustAccepted":true,
                "trustClassification":"trusted_installation_secret","attemptCount":1,
                "finalStatus":"in_progress","result":null,"outputEvidence":null,"error":null,
                "startedAt":"start","finishedAt":null
            }}),
        )
        .await;

        let (poll_stream, _) = listener.accept().await.unwrap();
        let mut poll = accept_async(poll_stream).await.unwrap();
        let _hello = receive_json(&mut poll).await;
        send_json(
            &mut poll,
            json!({"action":"hello/ack","data":{
                "protocolVersion":NODE_PROTOCOL,"role":"node","nodeId":"node-a","authenticated":true
            }}),
        )
        .await;
        let lookup = receive_json(&mut poll).await;
        assert_eq!(lookup["data"]["requestedAction"], "node.status");
        assert_eq!(
            lookup["data"]["input"]["subjectOperationId"],
            "polled-peer-worker"
        );
        let lookup_id = lookup["data"]["operationId"].clone();
        send_json(
            &mut poll,
            json!({"action":"node/result","data":{
                "protocolVersion":NODE_PROTOCOL,"operationId":lookup_id,
                "requestedAction":"node.status","actor":null,"trustAccepted":true,
                "trustClassification":"trusted_installation_secret","attemptCount":1,
                "finalStatus":"succeeded","result":{"receipt":{
                    "protocolVersion":NODE_PROTOCOL,"operationId":"polled-peer-worker",
                    "requestedAction":"worker.run","actor":null,"trustAccepted":true,
                    "trustClassification":"trusted_installation_secret","attemptCount":1,
                    "finalStatus":"succeeded","result":{"stdout":"done"},"outputEvidence":null,
                    "error":null,"startedAt":"start","finishedAt":"finish"
                }},"outputEvidence":null,"error":null,"startedAt":"start","finishedAt":"finish"
            }}),
        )
        .await;
    });

    let repo = tempdir().unwrap();
    let mut config = NodeConfig::new(repo.path(), "node-b", "ws://127.0.0.1:0").unwrap();
    config.operation_timeout_ms = 2_000;
    config.peers.insert("node-a".into(), peer_url);
    let node = spawn(config, SECRET).await.unwrap();
    let (mut client, _) = connect_async(node.url()).await.unwrap();
    authenticate(&mut client, "client", None).await;
    send_json(&mut client, json!({"action":"node/request","data":{
        "protocolVersion":NODE_PROTOCOL,"operationId":"polled-peer-worker","requestedAction":"worker.run",
        "actorId":"focused-worker","targetNodeId":"node-a","input":{}
    }})).await;
    let response = receive_json(&mut client).await;
    assert_eq!(response["data"]["finalStatus"], "succeeded");
    assert_eq!(response["data"]["result"]["stdout"], "done");
    assert_eq!(response["data"]["attemptCount"], 2);

    fake_peer.await.unwrap();
    node.shutdown().await.unwrap();
}
