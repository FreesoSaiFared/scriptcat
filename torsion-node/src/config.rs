use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};

use anyhow::{Context, Result, bail};
use serde::Deserialize;
use url::Url;

use crate::protocol::CHANNEL_PROTOCOL;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelConfig {
    pub protocol_version: String,
    pub url: String,
    pub token: String,
}

impl ChannelConfig {
    pub fn load(repo_root: &Path) -> Result<Self> {
        let path = repo_root.join(".torsionfield-channel.json");
        let bytes = fs::read(&path)
            .with_context(|| format!("failed to read channel config: {}", path.display()))?;
        let config: Self = serde_json::from_slice(&bytes)
            .with_context(|| format!("invalid channel config JSON: {}", path.display()))?;
        if config.protocol_version != CHANNEL_PROTOCOL {
            bail!("unsupported channel protocol: {}", config.protocol_version);
        }
        validate_channel_url(&config.url)?;
        if config.token.len() < 32 {
            bail!("channel token must contain at least 32 characters");
        }
        Ok(config)
    }
}

#[derive(Clone, Debug)]
pub struct NodeConfig {
    pub repo_root: PathBuf,
    pub node_id: String,
    pub listen_url: String,
    pub peers: BTreeMap<String, String>,
    pub operation_timeout_ms: u64,
}

impl NodeConfig {
    pub fn new(
        repo_root: impl AsRef<Path>,
        node_id: impl Into<String>,
        listen_url: impl Into<String>,
    ) -> Result<Self> {
        let repo_root = fs::canonicalize(repo_root.as_ref()).with_context(|| {
            format!(
                "failed to resolve repository root: {}",
                repo_root.as_ref().display()
            )
        })?;
        let node_id = node_id.into();
        validate_identifier(&node_id, "node id")?;
        let listen_url = listen_url.into();
        validate_listen_url(&listen_url)?;
        Ok(Self {
            repo_root,
            node_id,
            listen_url,
            peers: BTreeMap::new(),
            operation_timeout_ms: 45_000,
        })
    }
}

pub fn validate_identifier(value: &str, label: &str) -> Result<()> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
    {
        bail!("{label} must use 1-128 ASCII letters, digits, '.', ':', '_' or '-'");
    }
    Ok(())
}

fn parse_listener_url(value: &str) -> Result<Url> {
    let url = Url::parse(value).with_context(|| format!("invalid WebSocket URL: {value}"))?;
    if url.scheme() != "ws" {
        bail!("resident listener requires a ws:// URL");
    }
    if url.host_str().is_none() || url.port().is_none() {
        bail!("resident listener URL requires a host and explicit port");
    }
    if url.path() != "/" && !url.path().is_empty() {
        bail!("resident listener URL must not contain a path");
    }
    Ok(url)
}

fn validate_channel_url(value: &str) -> Result<Url> {
    let url = parse_listener_url(value)?;
    if !matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "::1")) {
        bail!("ScriptCat channel must use a loopback host");
    }
    Ok(url)
}

pub fn validate_listen_url(value: &str) -> Result<Url> {
    let url = parse_listener_url(value)?;
    if !matches!(
        url.host_str(),
        Some("127.0.0.1" | "localhost" | "::1" | "0.0.0.0")
    ) {
        bail!("resident listener must use a loopback or wildcard host");
    }
    Ok(url)
}

pub fn validate_peer_url(value: &str) -> Result<()> {
    let url = Url::parse(value).with_context(|| format!("invalid peer WebSocket URL: {value}"))?;
    if !matches!(url.scheme(), "ws" | "wss") || url.host_str().is_none() {
        bail!("peer URL must use ws:// or wss:// and include a host");
    }
    Ok(())
}
