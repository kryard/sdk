# Changelog

All notable changes to `@kryard/sdk` are documented here.

## 0.4.0 — v2.1 delegate-digest resync (BREAKING)

Resyncs the off-chain delegate digest with the deployed **v2.1 `KryardDelegate`**.
The digest scheme changed on-chain, so this release is **breaking**: an SDK <0.4.0
produces signatures the v2.1 contract rejects, and 0.4.0 produces signatures older
delegates reject. **Must ship alongside the v2.1 delegate deployed at
`0xF715155b24A5A0664f9FcF4B2Cbb8a30A2eF9049`.**

### Breaking

- **Auth digest is now EIP-712 typed data, not `personal_sign`.** `delegateDigest(...)`
  returns the raw `keccak256(0x1901 ‖ domainSeparator ‖ structHash)` digest, with the
  EOA as the EIP-712 `verifyingContract`. The user must sign this **raw** 32-byte
  digest with plain ECDSA (viem: `account.sign({ hash: digest })`) — **NOT**
  `signMessage({ raw })` / `toEthSignedMessageHash`. The contract recovers the signer
  from the raw digest directly (no `\x19Ethereum Signed Message` prefix).
  `UserSigner.signDigest` keeps the same signature but its semantics changed to raw ECDSA.
- **New required `deadline` argument (Unix seconds).** Bound into every digest and into
  both on-chain entry points; the contract rejects `block.timestamp > deadline`.
  `deadline: bigint` is now required on `DelegateDigestInput`, `SponsoredExecuteParams`,
  and `SponsorExecuteOptions`. `encodeExecute` / `encodeExecuteWithGasReimbursement` take
  `deadline` as a new argument (after `nonce`), matching the v2.1 ABI.
- **`callsHash` uses full nested EIP-712 `Call[]` hashing** (`keccak256(‖_i hashStruct(Call))`),
  replacing the previous `keccak256(abi.encode(calls))`.
- **`KRYARD_DELEGATE_ABI` `execute` / `executeWithGasReimbursement` gain a `deadline`
  (uint256) parameter** after `nonce`.

### Added

- `domainSeparator(account, chainId)` is now exported.
- `test/parity.test.ts` — byte-identical golden-vector parity against the deployed v2.1
  contract (captured from Foundry), proving the off-chain digest matches
  `KryardDelegate._authorize`.
- **ERC-4337 gas sponsorship (`KryardPaymasterClient`)** — the verifying-paymaster tier,
  distinct from the EIP-7702 relay (`sponsorExecute`/`sponsorCall`). `sponsorUserOperation`
  X-Stamps a v0.7 `UserOperation` to `/public/v1/relay/sponsor_user_op`; on approval it
  returns the `paymasterAndData` (+ validity window) to splice onto the op before a bundler
  sends it, and surfaces a 403 policy denial as a typed `SponsorshipDeniedError` carrying the
  `SponsorshipReasonCode`. Adds pure v0.7 `paymasterAndData` byte-layout helpers
  `buildPaymasterAndData` / `splitPaymasterAndData` / `applyPaymasterAndData` (byte-parity with
  the on-chain paymaster). Purely additive — no change to the 7702 path.

### Migration

```diff
 const signer: UserSigner = {
   address: account.address,
-  signDigest: (digest) => account.signMessage({ message: { raw: digest } }),
+  signDigest: (digest) => account.sign({ hash: digest }),
   // ...
 };

 await sponsorExecute({
   client, signer, chainId, signWith, delegateAddress, calls, nonce,
+  deadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
 });
```
