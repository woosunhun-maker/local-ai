# Privacy-preserving growth pipeline

The pipeline is default-off, proposal-only, and incapable of accepting free-form local memory as outbound data.

1. `compileOutboundDraft` accepts one allowlisted structured performance template with four bounded integers.
2. `createFrozenOutboundRequest` binds canonical payload, SHA-256, nonce, destination, and expiry.
3. The owner iPhone recomputes the payload hash and signs the exact six-line approval message with Secure Enclave P-256.
4. `ApprovalStore.consumeApproved` revalidates the complete proof and expiry atomically.
5. `GrowthCoordinator.dispatchApprovedRequest` creates an immutable correlation receipt and permits at most one dispatch. An in-doubt result is never automatically retried.
6. The external model is stateless, tool-free, and must return the fixed four-string advice contract.
7. `quarantineAdvice` maps the response to an immutable `untrusted_external_advice` proposal with synthetic tests and a required rollback checkpoint.

There is no automatic proposal apply endpoint. Network transport is absent unless the runtime explicitly selects an injected adapter.
