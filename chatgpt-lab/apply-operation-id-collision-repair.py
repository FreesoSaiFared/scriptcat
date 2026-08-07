from pathlib import Path

path = Path("torsion-node/src/server.rs")
text = path.read_text(encoding="utf-8")
old = '''        match self.store.begin_receipt(&pending).await {
            Ok(BeginReceipt::Claimed) => {}
            Ok(BeginReceipt::Existing(receipt)) => return *receipt,
            Err(error) => {
'''
new = '''        match self.store.begin_receipt(&pending).await {
            Ok(BeginReceipt::Claimed) => {}
            Ok(BeginReceipt::Existing(receipt)) => {
                if receipt.requested_action != request.requested_action {
                    pending.final_status = FinalStatus::Rejected;
                    pending.error = Some(format!(
                        "operation id {} already belongs to {}",
                        request.operation_id,
                        receipt.requested_action.as_str()
                    ));
                    pending.output_evidence = json!({
                        "existingRequestedAction": receipt.requested_action.as_str(),
                    });
                    pending.finished_at = Some(timestamp());
                    return pending;
                }
                return *receipt;
            }
            Err(error) => {
'''
if text.count(old) != 1:
    raise SystemExit(f"expected exactly one operation-claim block, found {text.count(old)}")
path.write_text(text.replace(old, new), encoding="utf-8")
