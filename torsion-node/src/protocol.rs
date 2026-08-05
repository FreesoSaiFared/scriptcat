use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const CHANNEL_PROTOCOL: &str = "torsionfield-script-v1";
pub const NODE_PROTOCOL: &str = "torsionfield-node-v1";

pub fn validate_peer_ack(value: &Value, expected_node_id: &str) -> Result<(), String> {
    let valid = value.get("action").and_then(Value::as_str) == Some("hello/ack")
        && value
            .pointer("/data/protocolVersion")
            .and_then(Value::as_str)
            == Some(NODE_PROTOCOL)
        && value.pointer("/data/role").and_then(Value::as_str) == Some("node")
        && value.pointer("/data/nodeId").and_then(Value::as_str) == Some(expected_node_id)
        && value
            .pointer("/data/authenticated")
            .and_then(Value::as_bool)
            == Some(true);
    if valid {
        Ok(())
    } else {
        Err(format!(
            "peer acknowledgment did not authenticate configured node: {expected_node_id}"
        ))
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Extension,
    Client,
    Node,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HelloFrame {
    pub action: String,
    pub data: HelloData,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HelloData {
    pub protocol_version: String,
    pub role: Role,
    pub token: String,
    #[serde(default)]
    pub node_id: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct HelloAckFrame<'a> {
    pub action: &'static str,
    pub data: HelloAckData<'a>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HelloAckData<'a> {
    pub protocol_version: &'static str,
    pub role: Role,
    pub node_id: &'a str,
    pub authenticated: bool,
}

impl<'a> HelloAckFrame<'a> {
    pub fn new(node_id: &'a str, authenticated: bool) -> Self {
        Self {
            action: "hello/ack",
            data: HelloAckData {
                protocol_version: NODE_PROTOCOL,
                role: Role::Node,
                node_id,
                authenticated,
            },
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeRequestFrame {
    pub action: String,
    pub data: NodeRequest,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeRequest {
    pub protocol_version: String,
    pub operation_id: String,
    pub requested_action: RequestedAction,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actor_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_node_id: Option<String>,
    #[serde(default)]
    pub input: Value,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum RequestedAction {
    #[serde(rename = "node.status")]
    NodeStatus,
    #[serde(rename = "script.install")]
    ScriptInstall,
    #[serde(rename = "script.update")]
    ScriptUpdate,
    #[serde(rename = "script.status")]
    ScriptStatus,
    #[serde(rename = "extension.reload")]
    ExtensionReload,
    #[serde(rename = "tab.register")]
    TabRegister,
    #[serde(rename = "tab.list")]
    TabList,
    #[serde(rename = "tab.invoke")]
    TabInvoke,
    #[serde(rename = "worker.register")]
    WorkerRegister,
    #[serde(rename = "worker.run")]
    WorkerRun,
}

impl RequestedAction {
    pub const ALL: [Self; 10] = [
        Self::NodeStatus,
        Self::ScriptInstall,
        Self::ScriptUpdate,
        Self::ScriptStatus,
        Self::ExtensionReload,
        Self::TabRegister,
        Self::TabList,
        Self::TabInvoke,
        Self::WorkerRegister,
        Self::WorkerRun,
    ];

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::NodeStatus => "node.status",
            Self::ScriptInstall => "script.install",
            Self::ScriptUpdate => "script.update",
            Self::ScriptStatus => "script.status",
            Self::ExtensionReload => "extension.reload",
            Self::TabRegister => "tab.register",
            Self::TabList => "tab.list",
            Self::TabInvoke => "tab.invoke",
            Self::WorkerRegister => "worker.register",
            Self::WorkerRun => "worker.run",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Actor {
    Node(NodeActor),
    Extension(ExtensionActor),
    Tab(TabActor),
    Worker(WorkerActor),
}

impl Actor {
    pub fn actor_id(&self) -> &str {
        match self {
            Self::Node(actor) => &actor.actor_id,
            Self::Extension(actor) => &actor.actor_id,
            Self::Tab(actor) => &actor.actor_id,
            Self::Worker(actor) => &actor.actor_id,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeActor {
    pub actor_id: String,
    pub node_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionActor {
    pub actor_id: String,
    pub node_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TabActor {
    pub actor_id: String,
    pub fixture_url: String,
    pub tab_id: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerActor {
    pub actor_id: String,
    pub cwd: PathBuf,
    pub argv: Vec<String>,
    pub timeout_ms: u64,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FinalStatus {
    InProgress,
    Succeeded,
    Failed,
    Rejected,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Receipt {
    pub protocol_version: String,
    pub operation_id: String,
    pub requested_action: RequestedAction,
    pub actor: Option<Actor>,
    pub trust_accepted: bool,
    pub trust_classification: String,
    pub attempt_count: u32,
    pub final_status: FinalStatus,
    pub result: Value,
    pub output_evidence: Value,
    pub error: Option<String>,
    pub started_at: String,
    pub finished_at: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct NodeResultFrame<'a> {
    pub action: &'static str,
    pub data: &'a Receipt,
}

impl<'a> NodeResultFrame<'a> {
    pub fn new(receipt: &'a Receipt) -> Self {
        Self {
            action: "node/result",
            data: receipt,
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerResult {
    pub command: Vec<String>,
    pub cwd: PathBuf,
    pub start: String,
    pub finish: String,
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub test_count: u64,
    pub result_hash: String,
    pub timed_out: bool,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
}
