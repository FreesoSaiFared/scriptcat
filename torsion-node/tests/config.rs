use std::fs;

use serde_json::json;
use tempfile::tempdir;
use torsion_node::config::{ChannelConfig, NodeConfig, validate_identifier};
use torsion_node::protocol::CHANNEL_PROTOCOL;

#[test]
fn it_accepts_a_wildcard_for_an_explicit_resident_listener() {
    let repo = tempdir().unwrap();

    let config = NodeConfig::new(repo.path(), "node-a", "ws://0.0.0.0:8642").unwrap();

    assert_eq!(config.listen_url, "ws://0.0.0.0:8642");
}

#[test]
fn it_keeps_the_scriptcat_channel_loopback_only() {
    let repo = tempdir().unwrap();
    fs::write(
        repo.path().join(".torsionfield-channel.json"),
        serde_json::to_vec(&json!({
            "protocolVersion": CHANNEL_PROTOCOL,
            "url": "ws://0.0.0.0:8642",
            "token": "0123456789abcdef0123456789abcdef"
        }))
        .unwrap(),
    )
    .unwrap();

    let error = ChannelConfig::load(repo.path()).unwrap_err();

    assert!(error.to_string().contains("loopback"));
}

#[test]
fn it_preserves_the_loopback_defaults() {
    let repo = tempdir().unwrap();
    fs::write(
        repo.path().join(".torsionfield-channel.json"),
        serde_json::to_vec(&json!({
            "protocolVersion": CHANNEL_PROTOCOL,
            "url": "ws://127.0.0.1:8642",
            "token": "0123456789abcdef0123456789abcdef"
        }))
        .unwrap(),
    )
    .unwrap();

    let channel = ChannelConfig::load(repo.path()).unwrap();
    let node = NodeConfig::new(repo.path(), "node-a", "ws://localhost:8642").unwrap();

    assert_eq!(channel.url, "ws://127.0.0.1:8642");
    assert_eq!(node.listen_url, "ws://localhost:8642");
}

#[test]
fn it_exhaustively_matches_the_single_ascii_byte_identifier_contract() {
    for byte in 0_u8..=127 {
        let input = [byte];
        let value = std::str::from_utf8(&input).unwrap();
        let expected = byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':');
        assert_eq!(
            validate_identifier(value, "node id").is_ok(),
            expected,
            "unexpected classification for ASCII byte {byte}"
        );
    }
}

#[test]
fn it_enforces_the_identifier_length_boundary() {
    assert!(validate_identifier(&"a".repeat(128), "node id").is_ok());
    assert!(validate_identifier(&"a".repeat(129), "node id").is_err());
}
