use tempfile::tempdir;
use torsion_node::{
    protocol::WorkerActor,
    worker::{count_tests, run_worker},
};

#[test]
fn it_counts_common_test_summaries_without_guessing_from_unrelated_numbers() {
    assert_eq!(
        count_tests("test result: ok. 7 passed; 1 failed; 2 ignored"),
        10
    );
    assert_eq!(count_tests("Tests  12 passed | 3 failed | 1 skipped"), 16);
    assert_eq!(count_tests("version 1.97.1"), 0);
}

#[tokio::test]
async fn it_runs_the_registered_argv_directly_and_hashes_the_bounded_result() {
    let cwd = tempdir().unwrap();
    let actor = WorkerActor {
        actor_id: "rust-version".into(),
        cwd: cwd.path().to_path_buf(),
        argv: vec!["rustc".into(), "--version".into()],
        timeout_ms: 10_000,
    };

    let result = run_worker(&actor).await.unwrap();

    assert_eq!(result.command, actor.argv);
    assert_eq!(result.cwd, cwd.path());
    assert_eq!(result.exit_code, Some(0));
    assert!(result.stdout.starts_with("rustc "));
    assert_eq!(result.test_count, 0);
    assert_eq!(result.result_hash.len(), 64);
    assert!(!result.timed_out);
}

#[cfg(unix)]
#[tokio::test]
async fn it_bounds_output_drain_when_a_timed_out_descendant_keeps_the_pipe_open() {
    let cwd = tempdir().unwrap();
    let actor = WorkerActor {
        actor_id: "open-pipe".into(),
        cwd: cwd.path().to_path_buf(),
        argv: vec!["/bin/sh".into(), "-c".into(), "(sleep 5) & sleep 5".into()],
        timeout_ms: 100,
    };

    let started = std::time::Instant::now();
    let result = tokio::time::timeout(std::time::Duration::from_secs(2), run_worker(&actor))
        .await
        .expect("stdout/stderr drain exceeded its post-timeout bound")
        .unwrap();
    assert!(result.timed_out);
    assert!(started.elapsed() < std::time::Duration::from_secs(2));
    assert!(result.stdout_truncated || result.stderr_truncated);
}

#[cfg(windows)]
#[tokio::test]
async fn it_terminates_the_full_windows_worker_process_tree() {
    let cwd = tempdir().unwrap();
    let marker = cwd.path().join("escaped-descendant.txt");
    let child_script = cwd.path().join("child.cmd");
    let parent_script = cwd.path().join("parent.cmd");
    std::fs::write(
        &child_script,
        format!(
            "@echo off\r\nping.exe 127.0.0.1 -n 4 >nul\r\n>\"{}\" echo escaped\r\n",
            marker.display()
        ),
    )
    .unwrap();
    std::fs::write(
        &parent_script,
        format!(
            "@echo off\r\nstart \"\" /B cmd.exe /D /S /C \"\"{}\"\"\r\nping.exe 127.0.0.1 -n 10 >nul\r\n",
            child_script.display()
        ),
    )
    .unwrap();
    let actor = WorkerActor {
        actor_id: "windows-tree".into(),
        cwd: cwd.path().to_path_buf(),
        argv: vec![
            "cmd.exe".into(),
            "/D".into(),
            "/S".into(),
            "/C".into(),
            parent_script.display().to_string(),
        ],
        timeout_ms: 200,
    };

    let started = std::time::Instant::now();
    let result = tokio::time::timeout(std::time::Duration::from_secs(3), run_worker(&actor))
        .await
        .expect("Windows worker tree termination or output drain hung")
        .unwrap();
    assert!(result.timed_out);
    assert!(started.elapsed() < std::time::Duration::from_secs(2));
    tokio::time::sleep(std::time::Duration::from_secs(4)).await;
    assert!(!marker.exists(), "worker descendant survived the timeout");
}
