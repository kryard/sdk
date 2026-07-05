/**
 * parity.test.ts — byte-identical parity of the off-chain v2.1 auth digest against
 * the on-chain KryardDelegate.
 *
 * The GOLDEN constants below are captured from Foundry against the real v2.1
 * contract — see `contracts/test/KryardDelegateOffchainParity.t.sol`, which both
 * (a) asserts these exact bytes and (b) proves the deployed-shape contract ACCEPTS
 * a signature over the same digest via a delegated `execute` /
 * `executeWithGasReimbursement`. So GOLDEN == the digest the contract's
 * `_authorize` itself computes.
 *
 * If any of these fail, the off-chain signer is OUT OF SYNC with the contract and
 * MUST NOT be used to sign a v2.1 batch.
 */
import { describe, it, expect } from "vitest";
import { type Hex } from "viem";
import { delegateDigest, domainSeparator, type Call } from "../src/digest.js";

// Fixed vector — MUST equal contracts/test/KryardDelegateOffchainParity.t.sol.
const USER = "0xe05fcC23807536bEe418f142D19fa0d21BB0cfF7" as Hex; // vm.addr(0xA11CE)
const CHAIN_ID = 8453; // Base
const NONCE = 7n;
const DEADLINE = 2_000_000_000n;
const GAS_TOKEN = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Hex; // USDC
const GAS_AMOUNT = 50n;
const RELAYER = "0x000000000000000000000000000000000000bEEF" as Hex;

const EMPTY: Call[] = [];
const ONE: Call[] = [{ to: "0x000000000000000000000000000000000000dEaD" as Hex, value: 0n, data: "0xdeadbeef" as Hex }];
const MULTI: Call[] = [
  { to: "0x000000000000000000000000000000000000dEaD" as Hex, value: 0n, data: "0xdeadbeef" as Hex },
  {
    to: "0x000000000000000000000000000000000000cafE" as Hex,
    value: 1_000_000_000_000_000_000n, // 1 ether
    data: "0xa9059cbb000000000000000000000000000000000000000000000000000000000000cafe0000000000000000000000000000000000000000000000000000000000000539" as Hex,
  },
];

// Golden vectors captured from the v2.1 contract via Foundry (test_logGoldenVectors).
const GOLDEN_DOMAIN_SEPARATOR = "0x34df93af951ea98468a0628e39dd213d51be6d0d1a22dca46b6f9cfa5b0edd77";
const GOLDEN_EXEC_EMPTY = "0x9b823adb1da988aa71c7a135e84663d5634301c16a183c3e2c0f7926d4bf0022";
const GOLDEN_EXEC_ONE = "0xfe90bc7700777c10c28649d0f8a84d79e62cce8477e00c093a329c188a3cb012";
const GOLDEN_EXEC_MULTI = "0x3c400d5d5f06592a3a51c3bc53da723fe501ebce5a6dbf5bbb95686849a9cc99";
const GOLDEN_REIMBURSE_MULTI = "0x4bd6232626c3a555413dfca13dce2c9f40831208504c45414262af80bc3a53ff";

describe("v2.1 digest parity — TS off-chain == KryardDelegate contract (byte-identical)", () => {
  it("domainSeparator matches KryardDelegate.domainSeparator()", () => {
    expect(domainSeparator(USER, CHAIN_ID)).toBe(GOLDEN_DOMAIN_SEPARATOR);
  });

  it("execute — empty batch", () => {
    expect(delegateDigest({ account: USER, chainId: CHAIN_ID, calls: EMPTY, nonce: NONCE, deadline: DEADLINE })).toBe(
      GOLDEN_EXEC_EMPTY,
    );
  });

  it("execute — single call", () => {
    expect(delegateDigest({ account: USER, chainId: CHAIN_ID, calls: ONE, nonce: NONCE, deadline: DEADLINE })).toBe(
      GOLDEN_EXEC_ONE,
    );
  });

  it("execute — multi-call with nested dynamic bytes", () => {
    expect(delegateDigest({ account: USER, chainId: CHAIN_ID, calls: MULTI, nonce: NONCE, deadline: DEADLINE })).toBe(
      GOLDEN_EXEC_MULTI,
    );
  });

  it("executeWithGasReimbursement — multi-call + fee terms", () => {
    expect(
      delegateDigest({
        account: USER,
        chainId: CHAIN_ID,
        calls: MULTI,
        nonce: NONCE,
        deadline: DEADLINE,
        gasToken: GAS_TOKEN,
        gasTokenAmount: GAS_AMOUNT,
        relayer: RELAYER,
      }),
    ).toBe(GOLDEN_REIMBURSE_MULTI);
  });
});
