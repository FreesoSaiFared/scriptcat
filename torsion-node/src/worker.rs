use std::{
    process::Stdio,
    sync::{Arc, Mutex, OnceLock},
    time::Duration,
};

use anyhow::{Context, Result, bail};
#[cfg(windows)]
use command_group::{AsyncCommandGroup, AsyncGroupChild};
use regex::Regex;
use serde::Serialize;
use sha2::{Digest, Sha256};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::Command,
    task::JoinHandle,
    time::{Instant, timeout, timeout_at},
};

use crate::protocol::{WorkerActor, WorkerResult};

pub const MAX_OUTPUT_BYTES: usize = 1024 * 1024;
const OUTPUT_DRAIN_TIMEOUT: Duration = Duration::from_secs(1);

#[cfg(windows)]
type WorkerChild = AsyncGroupChild;
#[cfg(not(windows))]
type WorkerChild = tokio::process::Child;

pub async fn run_worker(actor: &WorkerActor) -> Result<WorkerResult> {
    let (program, arguments) = actor
        .argv
        .split_first()
        .ok_or_else(|| anyhow::anyhow!("worker argv must not be empty"))?;
    if actor.timeout_ms == 0 {
        bail!("worker timeout must be positive");
    }

    let start = timestamp()?;
    let mut command = Command::new(program);
    command
        .args(arguments)
        .current_dir(&actor.cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = spawn_worker(&mut command)
        .with_context(|| format!("failed to start worker executable: {program}"))?;
    let stdout = inner_child(&mut child)
        .stdout
        .take()
        .context("worker stdout was not piped")?;
    let stderr = inner_child(&mut child)
        .stderr
        .take()
        .context("worker stderr was not piped")?;
    let stdout_capture = Arc::new(Mutex::new(BoundedOutput::default()));
    let stderr_capture = Arc::new(Mutex::new(BoundedOutput::default()));
    let stdout_task = tokio::spawn(read_bounded(stdout, Arc::clone(&stdout_capture)));
    let stderr_task = tokio::spawn(read_bounded(stderr, Arc::clone(&stderr_capture)));

    let (exit_code, timed_out) =
        match timeout(Duration::from_millis(actor.timeout_ms), child.wait()).await {
            Ok(status) => (status.context("failed to wait for worker")?.code(), false),
            Err(_) => {
                child
                    .kill()
                    .await
                    .context("failed to terminate timed-out worker")?;
                (None, true)
            }
        };
    let drain_deadline = Instant::now() + OUTPUT_DRAIN_TIMEOUT;
    let (stdout, stderr) = tokio::join!(
        finish_output(stdout_task, stdout_capture, drain_deadline, "stdout"),
        finish_output(stderr_task, stderr_capture, drain_deadline, "stderr"),
    );
    let (stdout, stdout_truncated) = stdout?;
    let (stderr, stderr_truncated) = stderr?;
    let stdout = String::from_utf8_lossy(&stdout).into_owned();
    let stderr = String::from_utf8_lossy(&stderr).into_owned();
    let finish = timestamp()?;
    let test_count = count_tests(&format!("{stdout}\n{stderr}"));

    let hash_input = HashInput {
        command: &actor.argv,
        cwd: &actor.cwd,
        start: &start,
        finish: &finish,
        exit_code,
        stdout: &stdout,
        stderr: &stderr,
        test_count,
        timed_out,
        stdout_truncated,
        stderr_truncated,
    };
    let result_hash = format!("{:x}", Sha256::digest(serde_json::to_vec(&hash_input)?));

    Ok(WorkerResult {
        command: actor.argv.clone(),
        cwd: actor.cwd.clone(),
        start,
        finish,
        exit_code,
        stdout,
        stderr,
        test_count,
        result_hash,
        timed_out,
        stdout_truncated,
        stderr_truncated,
    })
}

#[cfg(windows)]
fn spawn_worker(command: &mut Command) -> std::io::Result<WorkerChild> {
    command.group().kill_on_drop(true).spawn()
}

#[cfg(not(windows))]
fn spawn_worker(command: &mut Command) -> std::io::Result<WorkerChild> {
    command.kill_on_drop(true).spawn()
}

#[cfg(windows)]
fn inner_child(child: &mut WorkerChild) -> &mut tokio::process::Child {
    child.inner()
}

#[cfg(not(windows))]
fn inner_child(child: &mut WorkerChild) -> &mut tokio::process::Child {
    child
}

pub fn count_tests(output: &str) -> u64 {
    static RUST_SUMMARY: OnceLock<Regex> = OnceLock::new();
    static LABELLED_COUNT: OnceLock<Regex> = OnceLock::new();
    static TAP_TEST: OnceLock<Regex> = OnceLock::new();
    let rust_summary = RUST_SUMMARY.get_or_init(|| {
        Regex::new(r"test result: [^.]*\. (\d+) passed; (\d+) failed; (\d+) ignored")
            .expect("valid regex")
    });
    if let Some(captures) = rust_summary.captures_iter(output).last() {
        return (1..=3)
            .filter_map(|index| captures[index].parse::<u64>().ok())
            .fold(0_u64, u64::saturating_add);
    }

    let labelled_count = LABELLED_COUNT.get_or_init(|| {
        Regex::new(r"(?i)(\d+)\s+(passed|failed|skipped|ignored)").expect("valid regex")
    });
    if let Some(line) = output.lines().rev().find(|line| line.contains("Tests")) {
        let count = labelled_count
            .captures_iter(line)
            .filter_map(|capture| capture[1].parse::<u64>().ok())
            .fold(0_u64, u64::saturating_add);
        if count > 0 {
            return count;
        }
    }

    let tap_test =
        TAP_TEST.get_or_init(|| Regex::new(r"(?m)^(?:ok|not ok)\s+\d+").expect("valid regex"));
    tap_test.find_iter(output).count() as u64
}

#[derive(Default)]
struct BoundedOutput {
    bytes: Vec<u8>,
    truncated: bool,
}

async fn read_bounded<R: AsyncRead + Unpin>(
    mut reader: R,
    output: Arc<Mutex<BoundedOutput>>,
) -> Result<()> {
    let mut chunk = [0_u8; 8192];
    loop {
        let count = reader.read(&mut chunk).await?;
        if count == 0 {
            break;
        }
        let mut output = output
            .lock()
            .map_err(|_| anyhow::anyhow!("worker output capture lock was poisoned"))?;
        let remaining = MAX_OUTPUT_BYTES.saturating_sub(output.bytes.len());
        let retained = remaining.min(count);
        output.bytes.extend_from_slice(&chunk[..retained]);
        output.truncated |= retained < count;
    }
    Ok(())
}

async fn finish_output(
    mut task: JoinHandle<Result<()>>,
    output: Arc<Mutex<BoundedOutput>>,
    deadline: Instant,
    stream_name: &str,
) -> Result<(Vec<u8>, bool)> {
    match timeout_at(deadline, &mut task).await {
        Ok(result) => result.with_context(|| format!("worker {stream_name} task failed"))??,
        Err(_) => {
            task.abort();
            let _ = task.await;
            output
                .lock()
                .map_err(|_| anyhow::anyhow!("worker output capture lock was poisoned"))?
                .truncated = true;
        }
    }
    let mut output = output
        .lock()
        .map_err(|_| anyhow::anyhow!("worker output capture lock was poisoned"))?;
    Ok((std::mem::take(&mut output.bytes), output.truncated))
}

fn timestamp() -> Result<String> {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .context("failed to format UTC timestamp")
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HashInput<'a> {
    command: &'a [String],
    cwd: &'a std::path::Path,
    start: &'a str,
    finish: &'a str,
    exit_code: Option<i32>,
    stdout: &'a str,
    stderr: &'a str,
    test_count: u64,
    timed_out: bool,
    stdout_truncated: bool,
    stderr_truncated: bool,
}
