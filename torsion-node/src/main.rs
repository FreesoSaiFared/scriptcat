use std::{io::Write, path::PathBuf, process::ExitCode};

use anyhow::{Context, Result, bail};
use clap::Parser;
use serde_json::json;
use torsion_node::{
    NodeConfig,
    config::{ChannelConfig, validate_identifier, validate_peer_url},
    spawn,
};
use url::Url;

#[derive(Debug, Parser)]
#[command(name = "torsion-node", version, about = "Resident Torsion Node v0.1")]
struct Args {
    #[arg(long, default_value = ".")]
    repo: PathBuf,
    #[arg(long)]
    node_id: Option<String>,
    #[arg(long)]
    listen: Option<String>,
    #[arg(long = "peer", value_name = "NODE_ID=WS_URL")]
    peers: Vec<String>,
}

#[tokio::main]
async fn main() -> ExitCode {
    match run().await {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("torsion-node: {error:#}");
            ExitCode::FAILURE
        }
    }
}

async fn run() -> Result<()> {
    let args = Args::parse();
    let repo = std::fs::canonicalize(&args.repo)
        .with_context(|| format!("failed to resolve repository root: {}", args.repo.display()))?;
    let channel = ChannelConfig::load(&repo)?;
    let listen = args.listen.unwrap_or(channel.url);
    let port = Url::parse(&listen)?
        .port()
        .context("listen URL has no port")?;
    let node_id = args.node_id.unwrap_or_else(|| format!("local-{port}"));
    let mut config = NodeConfig::new(&repo, node_id, listen)?;
    for peer in args.peers {
        let (peer_id, peer_url) = peer
            .split_once('=')
            .with_context(|| format!("invalid --peer value, expected NODE_ID=WS_URL: {peer}"))?;
        validate_identifier(peer_id, "peer node id")?;
        validate_peer_url(peer_url)?;
        if config
            .peers
            .insert(peer_id.into(), peer_url.into())
            .is_some()
        {
            bail!("peer node id was configured more than once: {peer_id}");
        }
    }
    let node_id = config.node_id.clone();
    let node = spawn(config, channel.token).await?;
    println!(
        "{}",
        json!({
            "event": "ready",
            "protocolVersion": "torsionfield-node-v1",
            "nodeId": node_id,
            "url": node.url(),
        })
    );
    std::io::stdout()
        .flush()
        .context("failed to flush ready event")?;
    tokio::signal::ctrl_c()
        .await
        .context("failed to wait for shutdown signal")?;
    node.shutdown().await
}
