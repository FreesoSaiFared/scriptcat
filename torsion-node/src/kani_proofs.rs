use crate::config::validate_identifier;

fn allowed_identifier_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':')
}

#[kani::proof]
fn single_ascii_byte_matches_identifier_contract() {
    let byte: u8 = kani::any();
    kani::assume(byte.is_ascii());
    let input = [byte];
    let value = std::str::from_utf8(&input).expect("ASCII is valid UTF-8");

    assert_eq!(
        validate_identifier(value, "node id").is_ok(),
        allowed_identifier_byte(byte)
    );
}

#[kani::proof]
fn identifier_length_boundary_is_exact() {
    let accepted = [b'a'; 128];
    let rejected = [b'a'; 129];
    let accepted = std::str::from_utf8(&accepted).expect("ASCII is valid UTF-8");
    let rejected = std::str::from_utf8(&rejected).expect("ASCII is valid UTF-8");

    assert!(validate_identifier(accepted, "node id").is_ok());
    assert!(validate_identifier(rejected, "node id").is_err());
}

#[kani::proof]
fn path_and_whitespace_bytes_never_become_identifiers() {
    for byte in [b'/', b'\\', b' ', b'\t', b'\n', 0] {
        let input = [byte];
        let value = std::str::from_utf8(&input).expect("selected bytes are valid UTF-8");
        assert!(validate_identifier(value, "node id").is_err());
    }
}
