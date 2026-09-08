use std::{
    collections::BTreeMap,
    io::Write,
    path::{Path, PathBuf},
    sync::Arc,
};

use anyhow::{Context, Result};
use atomicwrites::{AllowOverwrite, AtomicFile};
use serde::{Serialize, de::DeserializeOwned};
use tokio::sync::{Mutex, RwLock};

use crate::{
    config::validate_identifier,
    protocol::{Actor, Receipt},
};

#[derive(Default)]
struct State {
    actors: BTreeMap<String, Actor>,
    receipts: BTreeMap<String, Receipt>,
}

#[derive(Clone)]
pub struct StateStore {
    directory: PathBuf,
    state: Arc<RwLock<State>>,
    persist_lock: Arc<Mutex<()>>,
}

#[derive(Debug, PartialEq)]
pub enum BeginReceipt {
    Claimed,
    Existing(Box<Receipt>),
}

impl StateStore {
    pub async fn open(repo_root: &Path, node_id: &str) -> Result<Self> {
        validate_identifier(node_id, "node id")?;
        let directory = repo_root.join(".torsionfield-node").join(node_id);
        tokio::fs::create_dir_all(&directory)
            .await
            .with_context(|| {
                format!(
                    "failed to create node state directory: {}",
                    directory.display()
                )
            })?;
        let actors_path = directory.join("actors.json");
        let receipts_path = directory.join("receipts.json");
        let actors = read_map(&actors_path).await?;
        let receipts = read_map(&receipts_path).await?;
        let store = Self {
            directory,
            state: Arc::new(RwLock::new(State { actors, receipts })),
            persist_lock: Arc::new(Mutex::new(())),
        };
        store.persist_actors().await?;
        store.persist_receipts().await?;
        Ok(store)
    }

    pub async fn register_actor(&self, actor: Actor) -> Result<()> {
        validate_identifier(actor.actor_id(), "actor id")?;
        let _persist = self.persist_lock.lock().await;
        let actor_id = actor.actor_id().to_owned();
        let mut state = self.state.write().await;
        let previous = state.actors.insert(actor_id.clone(), actor);
        let result = match json_bytes(&state.actors) {
            Ok(bytes) => write_json(self.directory.join("actors.json"), bytes).await,
            Err(error) => Err(error),
        };
        if result.is_err() {
            match previous {
                Some(previous) => {
                    state.actors.insert(actor_id, previous);
                }
                None => {
                    state.actors.remove(&actor_id);
                }
            }
        }
        result
    }

    pub async fn actor(&self, actor_id: &str) -> Option<Actor> {
        self.state.read().await.actors.get(actor_id).cloned()
    }

    pub async fn actors(&self) -> Vec<Actor> {
        self.state.read().await.actors.values().cloned().collect()
    }

    pub async fn write_receipt(&self, receipt: &Receipt) -> Result<()> {
        let _persist = self.persist_lock.lock().await;
        let mut state = self.state.write().await;
        let previous = state
            .receipts
            .insert(receipt.operation_id.clone(), receipt.clone());
        let result = match json_bytes(&state.receipts) {
            Ok(bytes) => write_json(self.directory.join("receipts.json"), bytes).await,
            Err(error) => Err(error),
        };
        if result.is_err() {
            match previous {
                Some(previous) => {
                    state
                        .receipts
                        .insert(receipt.operation_id.clone(), previous);
                }
                None => {
                    state.receipts.remove(&receipt.operation_id);
                }
            }
        }
        result
    }

    pub async fn begin_receipt(&self, receipt: &Receipt) -> Result<BeginReceipt> {
        let _persist = self.persist_lock.lock().await;
        let mut state = self.state.write().await;
        if let Some(existing) = state.receipts.get(&receipt.operation_id) {
            return Ok(BeginReceipt::Existing(Box::new(existing.clone())));
        }
        state
            .receipts
            .insert(receipt.operation_id.clone(), receipt.clone());
        let result = match json_bytes(&state.receipts) {
            Ok(bytes) => write_json(self.directory.join("receipts.json"), bytes).await,
            Err(error) => Err(error),
        };
        if let Err(error) = result {
            state.receipts.remove(&receipt.operation_id);
            return Err(error);
        }
        Ok(BeginReceipt::Claimed)
    }

    pub async fn receipt(&self, operation_id: &str) -> Option<Receipt> {
        self.state.read().await.receipts.get(operation_id).cloned()
    }

    pub async fn receipt_count(&self) -> usize {
        self.state.read().await.receipts.len()
    }

    async fn persist_actors(&self) -> Result<()> {
        let _persist = self.persist_lock.lock().await;
        let state = self.state.read().await;
        let bytes = json_bytes(&state.actors)?;
        drop(state);
        write_json(self.directory.join("actors.json"), bytes).await
    }

    async fn persist_receipts(&self) -> Result<()> {
        let _persist = self.persist_lock.lock().await;
        let state = self.state.read().await;
        let bytes = json_bytes(&state.receipts)?;
        drop(state);
        write_json(self.directory.join("receipts.json"), bytes).await
    }
}

async fn read_map<T: DeserializeOwned>(path: &Path) -> Result<BTreeMap<String, T>> {
    match tokio::fs::read(path).await {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .with_context(|| format!("invalid persistent node state: {}", path.display())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(BTreeMap::new()),
        Err(error) => {
            Err(error).with_context(|| format!("failed to read node state: {}", path.display()))
        }
    }
}

fn json_bytes<T: Serialize>(value: &T) -> Result<Vec<u8>> {
    let mut bytes = serde_json::to_vec_pretty(value)?;
    bytes.push(b'\n');
    Ok(bytes)
}

async fn write_json(path: PathBuf, bytes: Vec<u8>) -> Result<()> {
    let display_path = path.clone();
    tokio::task::spawn_blocking(move || {
        AtomicFile::new(path, AllowOverwrite).write(|file| file.write_all(&bytes))
    })
    .await
    .context("atomic node state write task failed")?
    .with_context(|| format!("failed to persist node state: {}", display_path.display()))
}
