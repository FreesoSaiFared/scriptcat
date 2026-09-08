use std::{
    collections::{HashMap, HashSet},
    net::SocketAddr,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};

use anyhow::{Context, Result, anyhow, bail};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use tokio::{
    net::{TcpListener, TcpStream, lookup_host},
    sync::{Mutex, mpsc, oneshot, watch},
    task::{JoinHandle, JoinSet},
    time::{Instant, sleep, timeout},
};
use tokio_tungstenite::{
    WebSocketStream, accept_async, connect_async,
    tungstenite::{
        Message,
        protocol::{CloseFrame, frame::coding::CloseCode},
    },
};
use url::Url;

use crate::{
    config::{NodeConfig, validate_identifier, validate_peer_url},
    persistence::{BeginReceipt, StateStore},
    protocol::{
        Actor, CHANNEL_PROTOCOL, ExtensionActor, FinalStatus, HelloAckFrame, HelloFrame,
        NODE_PROTOCOL, NodeActor, NodeRequest, NodeRequestFrame, NodeResultFrame, Receipt,
        RequestedAction, Role, TabActor, WorkerActor, validate_peer_ack,
    },
    worker::{MAX_OUTPUT_BYTES, run_worker},
};

const HELLO_TIMEOUT: Duration = Duration::from_secs(5);
const PEER_RETRY_INITIAL: Duration = Duration::from_millis(200);
const PEER_RETRY_MAX: Duration = Duration::from_secs(2);
const PEER_CONNECT_TIMEOUT: Duration = Duration::from_millis(250);
const DEFAULT_WORKER_TIMEOUT_MS: u64 = 30_000;
const MAX_WORKER_TIMEOUT_MS: u64 = 300_000;
const PEER_WORKER_MARGIN_MS: u64 = 30_000;

pub struct RunningNode {
    url: String,
    shutdown: watch::Sender<bool>,
    task: JoinHandle<Result<()>>,
}

impl RunningNode {
    pub fn url(&self) -> &str {
        &self.url
    }

    pub async fn shutdown(self) -> Result<()> {
        let _ = self.shutdown.send(true);
        self.task.await.context("node listener task failed")?
    }
}

pub async fn spawn(config: NodeConfig, secret: impl Into<String>) -> Result<RunningNode> {
    for (node_id, peer_url) in &config.peers {
        validate_identifier(node_id, "peer node id")?;
        validate_peer_url(peer_url)?;
    }
    let store = StateStore::open(&config.repo_root, &config.node_id).await?;
    let mut listen_url = Url::parse(&config.listen_url)?;
    let address = resolve_address(&listen_url).await?;
    let listener = TcpListener::bind(address)
        .await
        .with_context(|| format!("failed to bind resident listener: {}", config.listen_url))?;
    let local_address = listener.local_addr()?;
    listen_url
        .set_port(Some(local_address.port()))
        .map_err(|()| anyhow!("failed to set bound listener port"))?;
    let public_url = listen_url.to_string().trim_end_matches('/').to_owned();
    let runtime = Arc::new(Runtime {
        repo_root: config.repo_root,
        node_id: config.node_id,
        listen_url: public_url.clone(),
        peers: config.peers,
        secret: secret.into(),
        operation_timeout: Duration::from_millis(config.operation_timeout_ms),
        store,
        extension: Mutex::new(None),
        pending_extension: Mutex::new(HashMap::new()),
        tab_leases: Mutex::new(HashSet::new()),
        connection_sequence: AtomicU64::new(1),
    });
    let (shutdown, receiver) = watch::channel(false);
    let task = tokio::spawn(run_listener(listener, runtime, receiver));
    Ok(RunningNode {
        url: public_url,
        shutdown,
        task,
    })
}

async fn resolve_address(url: &Url) -> Result<SocketAddr> {
    let host = url.host_str().context("listener URL has no host")?;
    let port = url.port().context("listener URL has no port")?;
    lookup_host((host, port))
        .await?
        .next()
        .ok_or_else(|| anyhow!("listener host did not resolve: {host}"))
}

async fn run_listener(
    listener: TcpListener,
    runtime: Arc<Runtime>,
    mut shutdown: watch::Receiver<bool>,
) -> Result<()> {
    let mut connections = JoinSet::new();
    loop {
        tokio::select! {
            result = listener.accept() => {
                let (stream, _) = result.context("resident listener accept failed")?;
                let runtime = Arc::clone(&runtime);
                connections.spawn(async move {
                    let _ = serve_connection(runtime, stream).await;
                });
            }
            changed = shutdown.changed() => {
                if changed.is_err() || *shutdown.borrow() {
                    break;
                }
            }
            Some(_) = connections.join_next(), if !connections.is_empty() => {}
        }
    }
    connections.abort_all();
    while connections.join_next().await.is_some() {}
    Ok(())
}

enum ExtensionOutbound {
    Frame(Value),
    Close,
}

struct ExtensionLink {
    id: u64,
    sender: mpsc::Sender<ExtensionOutbound>,
}

struct Runtime {
    repo_root: std::path::PathBuf,
    node_id: String,
    listen_url: String,
    peers: std::collections::BTreeMap<String, String>,
    secret: String,
    operation_timeout: Duration,
    store: StateStore,
    extension: Mutex<Option<ExtensionLink>>,
    pending_extension: Mutex<HashMap<String, oneshot::Sender<Value>>>,
    tab_leases: Mutex<HashSet<String>>,
    connection_sequence: AtomicU64,
}

async fn serve_connection(runtime: Arc<Runtime>, stream: TcpStream) -> Result<()> {
    let mut socket = accept_async(stream)
        .await
        .context("WebSocket upgrade failed")?;
    let hello = timeout(HELLO_TIMEOUT, socket.next()).await;
    let parsed = match hello {
        Ok(Some(Ok(message))) => parse_json::<HelloFrame>(message).ok(),
        _ => None,
    };
    let authenticated =
        parsed.as_ref().is_some_and(|frame| {
            frame.action == "hello"
                && frame.data.protocol_version == CHANNEL_PROTOCOL
                && frame.data.token == runtime.secret
                && (frame.data.role != Role::Node
                    || frame.data.node_id.as_deref().is_some_and(|node_id| {
                        validate_identifier(node_id, "peer node id").is_ok()
                    }))
        });
    send_value(
        &mut socket,
        serde_json::to_value(HelloAckFrame::new(&runtime.node_id, authenticated))?,
    )
    .await?;
    if !authenticated {
        socket
            .close(Some(CloseFrame {
                code: CloseCode::Policy,
                reason: "authentication failed".into(),
            }))
            .await?;
        return Ok(());
    }

    match parsed.expect("authenticated hello must exist").data.role {
        Role::Extension => serve_extension(runtime, socket).await,
        Role::Client | Role::Node => serve_requester(runtime, socket).await,
    }
}

async fn serve_extension(runtime: Arc<Runtime>, socket: WebSocketStream<TcpStream>) -> Result<()> {
    let id = runtime.connection_sequence.fetch_add(1, Ordering::Relaxed);
    let (sender, mut receiver) = mpsc::channel(32);
    if let Some(previous) = runtime
        .extension
        .lock()
        .await
        .replace(ExtensionLink { id, sender })
    {
        let _ = previous.sender.send(ExtensionOutbound::Close).await;
    }

    let (mut sink, mut stream) = socket.split();
    loop {
        tokio::select! {
            outbound = receiver.recv() => match outbound {
                Some(ExtensionOutbound::Frame(value)) => {
                    sink.send(Message::Text(value.to_string().into())).await?;
                }
                Some(ExtensionOutbound::Close) | None => {
                    let _ = sink.send(Message::Close(None)).await;
                    break;
                }
            },
            inbound = stream.next() => match inbound {
                Some(Ok(Message::Text(text))) => runtime.receive_extension_result(text.as_bytes()).await,
                Some(Ok(Message::Binary(bytes))) => runtime.receive_extension_result(&bytes).await,
                Some(Ok(Message::Ping(bytes))) => sink.send(Message::Pong(bytes)).await?,
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                _ => {}
            }
        }
    }
    let mut extension = runtime.extension.lock().await;
    if extension.as_ref().is_some_and(|link| link.id == id) {
        *extension = None;
    }
    Ok(())
}

async fn serve_requester(
    runtime: Arc<Runtime>,
    mut socket: WebSocketStream<TcpStream>,
) -> Result<()> {
    while let Some(message) = socket.next().await {
        match message? {
            Message::Text(text) => {
                if let Ok(frame) = serde_json::from_slice::<NodeRequestFrame>(text.as_bytes()) {
                    if frame.action == "node/request" {
                        let receipt = runtime.process_request(frame.data).await;
                        send_value(
                            &mut socket,
                            serde_json::to_value(NodeResultFrame::new(&receipt))?,
                        )
                        .await?;
                    }
                }
            }
            Message::Binary(bytes) => {
                if let Ok(frame) = serde_json::from_slice::<NodeRequestFrame>(&bytes) {
                    if frame.action == "node/request" {
                        let receipt = runtime.process_request(frame.data).await;
                        send_value(
                            &mut socket,
                            serde_json::to_value(NodeResultFrame::new(&receipt))?,
                        )
                        .await?;
                    }
                }
            }
            Message::Ping(bytes) => socket.send(Message::Pong(bytes)).await?,
            Message::Close(_) => break,
            _ => {}
        }
    }
    Ok(())
}

impl Runtime {
    async fn receive_extension_result(&self, bytes: &[u8]) {
        let Ok(frame) = serde_json::from_slice::<Value>(bytes) else {
            return;
        };
        if frame.get("action").and_then(Value::as_str) != Some("torsionfield/result") {
            return;
        }
        let Some(operation_id) = frame.pointer("/data/operationId").and_then(Value::as_str) else {
            return;
        };
        if let Some(sender) = self.pending_extension.lock().await.remove(operation_id) {
            let _ = sender.send(frame["data"].clone());
        }
    }

    async fn process_request(&self, mut request: NodeRequest) -> Receipt {
        let started_at = timestamp();
        if request.protocol_version != NODE_PROTOCOL {
            return self
                .persist_failure(
                    &request,
                    started_at,
                    OperationFailure::failed("unsupported node protocol"),
                )
                .await;
        }
        if let Err(error) = validate_identifier(&request.operation_id, "operation id") {
            return self
                .persist_failure(
                    &request,
                    started_at,
                    OperationFailure::failed(error.to_string()),
                )
                .await;
        }

        let mut pending = self.pending_receipt(&request, started_at);
        match self.store.begin_receipt(&pending).await {
            Ok(BeginReceipt::Claimed) => {}
            Ok(BeginReceipt::Existing(receipt)) => return *receipt,
            Err(error) => {
                return self
                    .finish_failure(
                        pending,
                        OperationFailure::failed(format!(
                            "failed to persist operation receipt: {error}"
                        )),
                    )
                    .await;
            }
        }

        if request
            .target_node_id
            .as_deref()
            .is_some_and(|target| target != self.node_id)
        {
            return match self.forward_to_peer(request.clone()).await {
                Ok(receipt) => {
                    if let Err(error) = self.store.write_receipt(&receipt).await {
                        pending.attempt_count = receipt.attempt_count;
                        self.finish_failure(
                            pending,
                            OperationFailure::failed(format!(
                                "failed to persist peer receipt: {error}"
                            )),
                        )
                        .await
                    } else {
                        receipt
                    }
                }
                Err(error) => {
                    pending.attempt_count = error.attempt_count;
                    self.finish_failure(pending, OperationFailure::failed(error.error.to_string()))
                        .await
                }
            };
        }
        request.target_node_id = None;
        match self.execute_local(&request).await {
            Ok(outcome) => {
                let mut receipt = Receipt {
                    actor: outcome.actor,
                    final_status: FinalStatus::Succeeded,
                    result: outcome.result,
                    output_evidence: outcome.output_evidence,
                    finished_at: Some(timestamp()),
                    ..pending
                };
                if let Err(error) = self.store.write_receipt(&receipt).await {
                    receipt.final_status = FinalStatus::Failed;
                    receipt.error = Some(format!("failed to persist completed receipt: {error}"));
                }
                receipt
            }
            Err(error) => self.finish_failure(pending, error).await,
        }
    }

    fn pending_receipt(&self, request: &NodeRequest, started_at: String) -> Receipt {
        Receipt {
            protocol_version: NODE_PROTOCOL.into(),
            operation_id: request.operation_id.clone(),
            requested_action: request.requested_action,
            actor: None,
            trust_accepted: true,
            trust_classification: "trusted_installation_secret".into(),
            attempt_count: 1,
            final_status: FinalStatus::InProgress,
            result: Value::Null,
            output_evidence: Value::Null,
            error: None,
            started_at,
            finished_at: None,
        }
    }

    async fn persist_failure(
        &self,
        request: &NodeRequest,
        started_at: String,
        error: OperationFailure,
    ) -> Receipt {
        self.finish_failure(self.pending_receipt(request, started_at), error)
            .await
    }

    async fn finish_failure(&self, pending: Receipt, error: OperationFailure) -> Receipt {
        let mut receipt = Receipt {
            actor: error.actor.map(|actor| *actor),
            final_status: if error.rejected {
                FinalStatus::Rejected
            } else {
                FinalStatus::Failed
            },
            result: *error.result,
            output_evidence: *error.output_evidence,
            error: Some(error.message),
            finished_at: Some(timestamp()),
            ..pending
        };
        if let Err(persistence_error) = self.store.write_receipt(&receipt).await {
            let operation_error = receipt.error.take().unwrap_or_default();
            receipt.error = Some(format!(
                "{operation_error}; failed to persist failed receipt: {persistence_error}"
            ));
        }
        receipt
    }

    async fn execute_local(
        &self,
        request: &NodeRequest,
    ) -> std::result::Result<OperationOutcome, OperationFailure> {
        match request.requested_action {
            RequestedAction::NodeStatus => self.node_status(request).await,
            RequestedAction::ScriptInstall => self.script_operation(request, "install").await,
            RequestedAction::ScriptUpdate => self.script_operation(request, "update").await,
            RequestedAction::ScriptStatus => self.script_operation(request, "status").await,
            RequestedAction::ExtensionReload => self.script_operation(request, "reload").await,
            RequestedAction::TabRegister => self.tab_register(request).await,
            RequestedAction::TabList => self.tab_list().await,
            RequestedAction::TabInvoke => self.tab_invoke(request).await,
            RequestedAction::WorkerRegister => self.worker_register(request).await,
            RequestedAction::WorkerRun => self.worker_run(request).await,
        }
    }

    async fn node_status(
        &self,
        request: &NodeRequest,
    ) -> std::result::Result<OperationOutcome, OperationFailure> {
        if let Some(subject) = input_string(&request.input, "subjectOperationId")? {
            let receipt = self.store.receipt(&subject).await.ok_or_else(|| {
                OperationFailure::failed(format!("operation receipt not found: {subject}"))
            })?;
            return Ok(OperationOutcome::with_actor(
                self.node_actor(),
                json!({ "receipt": receipt }),
            ));
        }
        let actors = self.store.actors().await;
        let tabs = actors
            .iter()
            .filter(|actor| matches!(actor, Actor::Tab(_)))
            .count();
        let workers = actors
            .iter()
            .filter(|actor| matches!(actor, Actor::Worker(_)))
            .count();
        let peers: Vec<_> = self
            .peers
            .iter()
            .map(|(node_id, url)| json!({ "nodeId": node_id, "url": url }))
            .collect();
        let extension = self.extension.lock().await;
        let extension_connected = extension.is_some();
        let extension_connection_id = extension.as_ref().map(|link| link.id);
        drop(extension);
        Ok(OperationOutcome::with_actor(
            self.node_actor(),
            json!({
                "nodeId": self.node_id,
                "listenUrl": self.listen_url,
                "extensionConnected": extension_connected,
                "extensionConnectionId": extension_connection_id,
                "receiptCount": self.store.receipt_count().await,
                "actors": { "tabs": tabs, "workers": workers, "offered": actors },
                "peers": peers,
            }),
        ))
    }

    async fn script_operation(
        &self,
        request: &NodeRequest,
        extension_action: &str,
    ) -> std::result::Result<OperationOutcome, OperationFailure> {
        let input = input_object(&request.input)?;
        let mut data = Map::new();
        data.insert(
            "protocolVersion".into(),
            Value::String(CHANNEL_PROTOCOL.into()),
        );
        data.insert(
            "operationId".into(),
            Value::String(request.operation_id.clone()),
        );
        data.insert(
            "requestedAction".into(),
            Value::String(extension_action.into()),
        );
        data.insert("token".into(), Value::String(self.secret.clone()));
        match request.requested_action {
            RequestedAction::ScriptInstall | RequestedAction::ScriptUpdate => {
                for field in ["sourceUri", "code"] {
                    let value = input
                        .get(field)
                        .and_then(Value::as_str)
                        .filter(|value| !value.is_empty())
                        .ok_or_else(|| OperationFailure::failed(format!("{field} is required")))?;
                    data.insert(field.into(), Value::String(value.into()));
                }
                if let Some(verification) = input.get("verification") {
                    data.insert("verification".into(), verification.clone());
                }
            }
            RequestedAction::ScriptStatus => {
                let subject = input
                    .get("subjectOperationId")
                    .and_then(Value::as_str)
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| OperationFailure::failed("subjectOperationId is required"))?;
                data.insert("subjectOperationId".into(), Value::String(subject.into()));
            }
            RequestedAction::ExtensionReload => {}
            _ => unreachable!(),
        }
        let extension_actor = self.extension_actor();
        let result = match self
            .relay_extension(&request.operation_id, Value::Object(data))
            .await
        {
            Ok(result) => result,
            Err(mut error) => {
                error.actor = Some(Box::new(extension_actor.clone()));
                return Err(error);
            }
        };
        Ok(OperationOutcome {
            actor: Some(extension_actor),
            output_evidence: extension_evidence(&result),
            result,
        })
    }

    async fn tab_register(
        &self,
        request: &NodeRequest,
    ) -> std::result::Result<OperationOutcome, OperationFailure> {
        let actor_id = required_actor_id(request)?;
        let input = input_object(&request.input)?;
        let fixture_url = input
            .get("fixtureUrl")
            .and_then(Value::as_str)
            .ok_or_else(|| OperationFailure::failed("fixtureUrl is required"))?;
        validate_fixture_url(fixture_url)?;
        let requested_tab_id = optional_u64(input, "tabId")?;
        let mut data = json!({
            "protocolVersion": CHANNEL_PROTOCOL,
            "operationId": request.operation_id,
            "requestedAction": "tab.register",
            "token": self.secret,
            "fixtureUrl": fixture_url,
        });
        if let Some(tab_id) = requested_tab_id {
            data["tabId"] = json!(tab_id);
        }
        let extension_result = self.relay_extension(&request.operation_id, data).await?;
        let tab_id = unique_tab_id(&extension_result, fixture_url)?;
        if requested_tab_id.is_some_and(|requested| Some(requested) != tab_id) {
            return Err(OperationFailure::failed(
                "ScriptCat resolved a different tab than the requested tabId",
            ));
        }
        let actor = Actor::Tab(TabActor {
            actor_id,
            fixture_url: fixture_url.into(),
            tab_id,
        });
        self.store
            .register_actor(actor.clone())
            .await
            .map_err(OperationFailure::from_error)?;
        Ok(OperationOutcome {
            actor: Some(actor.clone()),
            result: json!({ "registered": true, "actor": actor, "extension": extension_result }),
            output_evidence: extension_evidence(&extension_result),
        })
    }

    async fn tab_list(&self) -> std::result::Result<OperationOutcome, OperationFailure> {
        let actors: Vec<_> = self
            .store
            .actors()
            .await
            .into_iter()
            .filter(|actor| matches!(actor, Actor::Tab(_)))
            .collect();
        Ok(OperationOutcome::with_actor(
            self.node_actor(),
            json!({ "actors": actors }),
        ))
    }

    async fn tab_invoke(
        &self,
        request: &NodeRequest,
    ) -> std::result::Result<OperationOutcome, OperationFailure> {
        let actor_id = required_actor_id(request)?;
        let actor =
            self.store.actor(&actor_id).await.ok_or_else(|| {
                OperationFailure::failed(format!("tab actor not found: {actor_id}"))
            })?;
        let Actor::Tab(tab) = &actor else {
            return Err(OperationFailure::failed(format!(
                "actor is not a tab: {actor_id}"
            )));
        };
        let tab_id = tab.tab_id.ok_or_else(|| {
            OperationFailure::failed(format!("tab actor has no bound tab id: {actor_id}"))
        })?;
        let input = input_object(&request.input)?;
        let value = input
            .get("value")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty() && value.len() <= 256)
            .ok_or_else(|| OperationFailure::failed("value must contain 1-256 UTF-8 bytes"))?;

        {
            let mut leases = self.tab_leases.lock().await;
            if !leases.insert(actor_id.clone()) {
                return Err(OperationFailure::rejected_with(
                    format!("tab actor is already leased: {actor_id}"),
                    Some(actor),
                    json!({ "lease": { "actorId": actor_id, "acquired": false, "released": false } }),
                ));
            }
        }
        let data = json!({
            "protocolVersion": CHANNEL_PROTOCOL,
            "operationId": request.operation_id,
            "requestedAction": "tab.invoke",
            "token": self.secret,
            "tabId": tab_id,
            "tabAction": "fixture.change-marker",
            "value": value,
        });
        let relayed = self.relay_extension(&request.operation_id, data).await;
        self.tab_leases.lock().await.remove(&actor_id);
        let lease = json!({ "actorId": actor_id, "acquired": true, "released": true });
        match relayed {
            Ok(mut result) => {
                insert_object_field(&mut result, "lease", lease.clone());
                Ok(OperationOutcome {
                    actor: Some(actor),
                    output_evidence: json!({
                        "lease": lease,
                        "extension": extension_evidence(&result),
                    }),
                    result,
                })
            }
            Err(mut error) => {
                error.actor = Some(Box::new(actor));
                error.output_evidence = Box::new(json!({
                    "lease": lease,
                    "extension": error.output_evidence,
                }));
                insert_object_field(&mut error.result, "lease", lease);
                Err(error)
            }
        }
    }

    async fn worker_register(
        &self,
        request: &NodeRequest,
    ) -> std::result::Result<OperationOutcome, OperationFailure> {
        let actor_id = required_actor_id(request)?;
        let input = input_object(&request.input)?;
        let cwd_value = input
            .get("cwd")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| OperationFailure::failed("cwd is required"))?;
        let cwd = tokio::fs::canonicalize(cwd_value).await.map_err(|error| {
            OperationFailure::failed(format!("failed to resolve worker cwd: {error}"))
        })?;
        if !cwd.starts_with(&self.repo_root) {
            return Err(OperationFailure::rejected(
                "worker cwd must stay within the repository",
            ));
        }
        let argv = input
            .get("argv")
            .and_then(Value::as_array)
            .ok_or_else(|| OperationFailure::failed("argv must be an array"))?
            .iter()
            .map(|value| {
                value
                    .as_str()
                    .filter(|argument| !argument.is_empty() && argument.len() <= 32_768)
                    .map(str::to_owned)
                    .ok_or_else(|| {
                        OperationFailure::failed("argv entries must be non-empty strings")
                    })
            })
            .collect::<std::result::Result<Vec<_>, _>>()?;
        if argv.is_empty() || argv.len() > 128 {
            return Err(OperationFailure::failed("argv must contain 1-128 entries"));
        }
        let timeout_ms = optional_u64(input, "timeoutMs")?.unwrap_or(DEFAULT_WORKER_TIMEOUT_MS);
        if !(1..=MAX_WORKER_TIMEOUT_MS).contains(&timeout_ms) {
            return Err(OperationFailure::rejected(format!(
                "timeoutMs must be between 1 and {MAX_WORKER_TIMEOUT_MS}"
            )));
        }
        let actor = Actor::Worker(WorkerActor {
            actor_id,
            cwd,
            argv,
            timeout_ms,
        });
        self.store
            .register_actor(actor.clone())
            .await
            .map_err(OperationFailure::from_error)?;
        Ok(OperationOutcome {
            actor: Some(actor.clone()),
            result: json!({ "registered": true, "actor": actor }),
            output_evidence: Value::Null,
        })
    }

    async fn worker_run(
        &self,
        request: &NodeRequest,
    ) -> std::result::Result<OperationOutcome, OperationFailure> {
        let actor_id = required_actor_id(request)?;
        let actor = self.store.actor(&actor_id).await.ok_or_else(|| {
            OperationFailure::failed(format!("worker actor not found: {actor_id}"))
        })?;
        let Actor::Worker(worker) = &actor else {
            return Err(OperationFailure::failed(format!(
                "actor is not a worker: {actor_id}"
            )));
        };
        let result = run_worker(worker)
            .await
            .map_err(OperationFailure::from_error)?;
        let result_value = serde_json::to_value(&result).map_err(OperationFailure::from_error)?;
        let evidence = json!({
            "bounded": {
                "timeoutMs": worker.timeout_ms,
                "maxOutputBytesPerStream": MAX_OUTPUT_BYTES,
                "timedOut": result.timed_out,
                "stdoutTruncated": result.stdout_truncated,
                "stderrTruncated": result.stderr_truncated,
            }
        });
        if result.timed_out || result.exit_code != Some(0) {
            return Err(OperationFailure {
                message: if result.timed_out {
                    "worker timed out".into()
                } else {
                    format!("worker exited with code {:?}", result.exit_code)
                },
                actor: Some(Box::new(actor)),
                result: Box::new(result_value),
                output_evidence: Box::new(evidence),
                rejected: false,
            });
        }
        Ok(OperationOutcome {
            actor: Some(actor),
            result: result_value,
            output_evidence: evidence,
        })
    }

    async fn relay_extension(
        &self,
        operation_id: &str,
        data: Value,
    ) -> std::result::Result<Value, OperationFailure> {
        let sender = self
            .extension
            .lock()
            .await
            .as_ref()
            .map(|link| link.sender.clone())
            .ok_or_else(|| OperationFailure::failed("ScriptCat extension is not connected"))?;
        let (result_sender, result_receiver) = oneshot::channel();
        let mut pending = self.pending_extension.lock().await;
        if pending.contains_key(operation_id) {
            return Err(OperationFailure::rejected(format!(
                "extension operation is already pending: {operation_id}"
            )));
        }
        pending.insert(operation_id.into(), result_sender);
        drop(pending);
        let frame = json!({ "action": "torsionfield", "data": data });
        if sender.send(ExtensionOutbound::Frame(frame)).await.is_err() {
            self.pending_extension.lock().await.remove(operation_id);
            return Err(OperationFailure::failed(
                "ScriptCat extension connection closed",
            ));
        }
        let result = match timeout(self.operation_timeout, result_receiver).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => {
                self.pending_extension.lock().await.remove(operation_id);
                return Err(OperationFailure::failed(
                    "ScriptCat extension result channel closed",
                ));
            }
            Err(_) => {
                self.pending_extension.lock().await.remove(operation_id);
                return Err(OperationFailure::failed(
                    "timed out waiting for ScriptCat extension result",
                ));
            }
        };
        if result.get("finalStatus").and_then(Value::as_str) != Some("succeeded") {
            return Err(OperationFailure {
                message: result
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("ScriptCat extension operation failed")
                    .into(),
                actor: None,
                output_evidence: Box::new(extension_evidence(&result)),
                result: Box::new(result),
                rejected: false,
            });
        }
        Ok(result)
    }

    async fn forward_to_peer(
        &self,
        mut request: NodeRequest,
    ) -> std::result::Result<Receipt, PeerForwardError> {
        let target_node_id = request
            .target_node_id
            .take()
            .ok_or_else(|| PeerForwardError {
                error: anyhow!("targetNodeId is required for peer forwarding"),
                attempt_count: 1,
            })?;
        let peer_url =
            self.peers
                .get(&target_node_id)
                .cloned()
                .ok_or_else(|| PeerForwardError {
                    error: anyhow!("peer is not configured: {target_node_id}"),
                    attempt_count: 1,
                })?;
        let operation_timeout = self.peer_operation_timeout(request.requested_action);
        let deadline = Instant::now() + operation_timeout;
        let mut delay = PEER_RETRY_INITIAL;
        let mut attempt_count = 0_u32;
        let mut poll_receipt = false;
        let final_error = loop {
            attempt_count += 1;
            let outbound = if poll_receipt {
                peer_poll_request(&request, attempt_count)
            } else {
                request.clone()
            };
            let remaining = deadline.saturating_duration_since(Instant::now());
            let error = match self
                .forward_peer_once(&peer_url, &target_node_id, &outbound, remaining)
                .await
            {
                Ok(receipt) if poll_receipt => match polled_subject_receipt(&receipt, &request) {
                    Ok(Some(mut subject)) if subject.final_status != FinalStatus::InProgress => {
                        subject.attempt_count = attempt_count;
                        return Ok(subject);
                    }
                    Ok(Some(_)) => anyhow!("peer operation is still in progress"),
                    Ok(None) => {
                        poll_receipt = false;
                        anyhow!("peer has not accepted the operation yet")
                    }
                    Err(error) => error,
                },
                Ok(mut receipt) if receipt.final_status != FinalStatus::InProgress => {
                    receipt.attempt_count = attempt_count;
                    return Ok(receipt);
                }
                Ok(_) => {
                    poll_receipt = true;
                    anyhow!("peer operation is still in progress")
                }
                Err(error) => {
                    poll_receipt = true;
                    error
                }
            };
            if Instant::now() >= deadline {
                break error;
            }
            sleep(delay.min(deadline.saturating_duration_since(Instant::now()))).await;
            delay = (delay * 2).min(PEER_RETRY_MAX);
        };
        Err(PeerForwardError {
            error: final_error,
            attempt_count: attempt_count.max(1),
        })
    }

    fn peer_operation_timeout(&self, action: RequestedAction) -> Duration {
        if action == RequestedAction::WorkerRun {
            self.operation_timeout.max(Duration::from_millis(
                MAX_WORKER_TIMEOUT_MS + PEER_WORKER_MARGIN_MS,
            ))
        } else {
            self.operation_timeout
        }
    }

    fn node_actor(&self) -> Actor {
        Actor::Node(NodeActor {
            actor_id: self.node_id.clone(),
            node_id: self.node_id.clone(),
        })
    }

    fn extension_actor(&self) -> Actor {
        Actor::Extension(ExtensionActor {
            actor_id: "scriptcat-extension".into(),
            node_id: self.node_id.clone(),
        })
    }

    async fn forward_peer_once(
        &self,
        peer_url: &str,
        target_node_id: &str,
        request: &NodeRequest,
        result_timeout: Duration,
    ) -> Result<Receipt> {
        let (mut socket, _) = timeout(PEER_CONNECT_TIMEOUT, connect_async(peer_url))
            .await
            .context("peer connection timed out")??;
        send_value(
            &mut socket,
            json!({
                "action": "hello",
                "data": {
                    "protocolVersion": CHANNEL_PROTOCOL,
                    "role": "node",
                    "token": self.secret,
                    "nodeId": self.node_id,
                }
            }),
        )
        .await?;
        let ack = timeout(PEER_CONNECT_TIMEOUT, receive_value(&mut socket))
            .await
            .context("peer authentication timed out")??;
        validate_peer_ack(&ack, target_node_id).map_err(|error| anyhow!(error))?;
        send_value(
            &mut socket,
            serde_json::to_value(NodeRequestFrame {
                action: "node/request".into(),
                data: request.clone(),
            })?,
        )
        .await?;
        let result = timeout(result_timeout, receive_value(&mut socket))
            .await
            .context("peer operation timed out")??;
        if result.get("action").and_then(Value::as_str) != Some("node/result") {
            bail!("peer returned an unexpected frame");
        }
        let receipt: Receipt = serde_json::from_value(result["data"].clone())
            .context("peer returned an invalid receipt")?;
        if receipt.protocol_version != NODE_PROTOCOL
            || receipt.operation_id != request.operation_id
            || receipt.requested_action != request.requested_action
        {
            bail!("peer returned a mismatched operation receipt");
        }
        Ok(receipt)
    }
}

struct PeerForwardError {
    error: anyhow::Error,
    attempt_count: u32,
}

fn peer_poll_request(subject: &NodeRequest, attempt_count: u32) -> NodeRequest {
    let digest = format!("{:x}", Sha256::digest(subject.operation_id.as_bytes()));
    NodeRequest {
        protocol_version: NODE_PROTOCOL.into(),
        operation_id: format!("peer-poll-{}-{attempt_count}", &digest[..24]),
        requested_action: RequestedAction::NodeStatus,
        actor_id: None,
        target_node_id: None,
        input: json!({ "subjectOperationId": subject.operation_id }),
    }
}

fn polled_subject_receipt(status: &Receipt, subject: &NodeRequest) -> Result<Option<Receipt>> {
    if status.final_status != FinalStatus::Succeeded {
        if status
            .error
            .as_deref()
            .is_some_and(|error| error.contains("operation receipt not found"))
        {
            return Ok(None);
        }
        bail!(
            "peer receipt lookup failed: {}",
            status.error.as_deref().unwrap_or("unknown peer error")
        );
    }

    let receipt: Receipt = serde_json::from_value(status.result["receipt"].clone())
        .context("peer receipt lookup returned an invalid receipt")?;
    if receipt.protocol_version != NODE_PROTOCOL
        || receipt.operation_id != subject.operation_id
        || receipt.requested_action != subject.requested_action
    {
        bail!("peer receipt lookup returned a mismatched operation receipt");
    }
    Ok(Some(receipt))
}

struct OperationOutcome {
    actor: Option<Actor>,
    result: Value,
    output_evidence: Value,
}

impl OperationOutcome {
    fn with_actor(actor: Actor, result: Value) -> Self {
        Self {
            actor: Some(actor),
            result,
            output_evidence: Value::Null,
        }
    }
}

struct OperationFailure {
    message: String,
    actor: Option<Box<Actor>>,
    result: Box<Value>,
    output_evidence: Box<Value>,
    rejected: bool,
}

impl OperationFailure {
    fn failed(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            actor: None,
            result: Box::new(Value::Null),
            output_evidence: Box::new(Value::Null),
            rejected: false,
        }
    }

    fn rejected(message: impl Into<String>) -> Self {
        Self {
            rejected: true,
            ..Self::failed(message)
        }
    }

    fn rejected_with(message: impl Into<String>, actor: Option<Actor>, evidence: Value) -> Self {
        Self {
            message: message.into(),
            actor: actor.map(Box::new),
            result: Box::new(evidence.clone()),
            output_evidence: Box::new(evidence),
            rejected: true,
        }
    }

    fn from_error(error: impl std::fmt::Display) -> Self {
        Self::failed(error.to_string())
    }
}

fn required_actor_id(request: &NodeRequest) -> std::result::Result<String, OperationFailure> {
    let actor_id = request
        .actor_id
        .as_deref()
        .ok_or_else(|| OperationFailure::failed("actorId is required"))?;
    validate_identifier(actor_id, "actor id").map_err(OperationFailure::from_error)?;
    Ok(actor_id.into())
}

fn input_object(input: &Value) -> std::result::Result<&Map<String, Value>, OperationFailure> {
    input
        .as_object()
        .ok_or_else(|| OperationFailure::failed("input must be an object"))
}

fn input_string(
    input: &Value,
    name: &str,
) -> std::result::Result<Option<String>, OperationFailure> {
    let input = input_object(input)?;
    match input.get(name) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) if !value.is_empty() => Ok(Some(value.clone())),
        Some(_) => Err(OperationFailure::failed(format!(
            "{name} must be a non-empty string"
        ))),
    }
}

fn optional_u64(
    input: &Map<String, Value>,
    name: &str,
) -> std::result::Result<Option<u64>, OperationFailure> {
    match input.get(name) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => value.as_u64().map(Some).ok_or_else(|| {
            OperationFailure::failed(format!("{name} must be a non-negative integer"))
        }),
    }
}

fn validate_fixture_url(value: &str) -> std::result::Result<(), OperationFailure> {
    let url = Url::parse(value).map_err(OperationFailure::from_error)?;
    let loopback = matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "::1"));
    if !matches!(url.scheme(), "http" | "https") || !loopback {
        return Err(OperationFailure::rejected(
            "fixtureUrl must be a loopback HTTP(S) URL",
        ));
    }
    Ok(())
}

fn unique_tab_id(
    result: &Value,
    fixture_url: &str,
) -> std::result::Result<Option<u64>, OperationFailure> {
    let matches: Vec<_> = result
        .get("tabs")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|tab| tab.get("url").and_then(Value::as_str) == Some(fixture_url))
        .filter_map(|tab| tab.get("tabId").and_then(Value::as_u64))
        .collect();
    match matches.as_slice() {
        [tab_id] => Ok(Some(*tab_id)),
        [] => Err(OperationFailure::failed(
            "extension did not resolve the fixture tab",
        )),
        _ => Err(OperationFailure::failed(
            "extension resolved multiple fixture tabs",
        )),
    }
}

fn extension_evidence(result: &Value) -> Value {
    for field in [
        "outputEvidence",
        "postcondition",
        "executionVerification",
        "tabs",
    ] {
        if let Some(value) = result.get(field).filter(|value| !value.is_null()) {
            return value.clone();
        }
    }
    Value::Null
}

fn insert_object_field(value: &mut Value, key: &str, field: Value) {
    if let Value::Object(object) = value {
        object.insert(key.into(), field);
    } else {
        let mut object = Map::new();
        object.insert("extension".into(), value.take());
        object.insert(key.into(), field);
        *value = Value::Object(object);
    }
}

fn timestamp() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .expect("UTC timestamps are representable as RFC 3339")
}

fn parse_json<T: serde::de::DeserializeOwned>(message: Message) -> Result<T> {
    match message {
        Message::Text(text) => Ok(serde_json::from_slice(text.as_bytes())?),
        Message::Binary(bytes) => Ok(serde_json::from_slice(&bytes)?),
        _ => bail!("expected a JSON text or binary frame"),
    }
}

async fn send_value<S>(socket: &mut WebSocketStream<S>, value: Value) -> Result<()>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    socket.send(Message::Text(value.to_string().into())).await?;
    Ok(())
}

async fn receive_value<S>(socket: &mut WebSocketStream<S>) -> Result<Value>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    while let Some(message) = socket.next().await {
        match message? {
            Message::Text(text) => return Ok(serde_json::from_slice(text.as_bytes())?),
            Message::Binary(bytes) => return Ok(serde_json::from_slice(&bytes)?),
            Message::Ping(bytes) => socket.send(Message::Pong(bytes)).await?,
            Message::Close(_) => bail!("WebSocket closed before a result arrived"),
            _ => {}
        }
    }
    bail!("WebSocket ended before a result arrived")
}
