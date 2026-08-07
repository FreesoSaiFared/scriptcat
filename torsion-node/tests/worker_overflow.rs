use torsion_node::worker::count_tests;

#[test]
fn it_saturates_untrusted_test_counts_instead_of_panicking_or_wrapping() {
    let max = u64::MAX;

    let labelled = format!("Tests  {max} passed | {max} failed | 1 skipped");
    assert_eq!(count_tests(&labelled), u64::MAX);

    let rust = format!("test result: ok. {max} passed; {max} failed; 1 ignored");
    assert_eq!(count_tests(&rust), u64::MAX);
}
