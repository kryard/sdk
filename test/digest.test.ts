import { describe, it, expect } from "vitest";
import { decodeFunctionData, type Hex } from "viem";
import {
  delegateDigest,
  callsHash,
  encodeExecute,
  encodeExecuteWithGasReimbursement,
  type Call,
} from "../src/digest.js";
import { KRYARD_DELEGATE_ABI } from "../src/abi.js";

const ACCOUNT = "0x00000000000000000000000000000000000A11cE" as Hex;
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Hex;
const RELAYER = "0x000000000000000000000000000000000000bEEF" as Hex;
const calls: Call[] = [{ to: "0x000000000000000000000000000000000000dEaD" as Hex, value: 0n, data: "0xdeadbeef" as Hex }];

describe("delegateDigest", () => {
  it("is a deterministic 32-byte hash", () => {
    const d1 = delegateDigest({ account: ACCOUNT, chainId: 1, calls, nonce: 7n });
    const d2 = delegateDigest({ account: ACCOUNT, chainId: 1, calls, nonce: 7n });
    expect(d1).toBe(d2);
    expect(d1).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("changes with the gas-reimbursement terms (relayer can't alter them)", () => {
    const plain = delegateDigest({ account: ACCOUNT, chainId: 1, calls, nonce: 7n });
    const token = delegateDigest({ account: ACCOUNT, chainId: 1, calls, nonce: 7n, gasToken: USDC, gasTokenAmount: 50n, relayer: RELAYER });
    expect(plain).not.toBe(token);
  });

  it("binds chainId, nonce, and account", () => {
    const base = delegateDigest({ account: ACCOUNT, chainId: 1, calls, nonce: 7n });
    expect(base).not.toBe(delegateDigest({ account: ACCOUNT, chainId: 8453, calls, nonce: 7n }));
    expect(base).not.toBe(delegateDigest({ account: ACCOUNT, chainId: 1, calls, nonce: 8n }));
    expect(base).not.toBe(delegateDigest({ account: RELAYER, chainId: 1, calls, nonce: 7n }));
  });

  it("callsHash is deterministic and changes with the batch", () => {
    expect(callsHash(calls)).toBe(callsHash(calls));
    expect(callsHash(calls)).not.toBe(callsHash([{ ...calls[0], value: 1n }]));
  });
});

describe("encode", () => {
  it("encodeExecute round-trips via decodeFunctionData", () => {
    const data = encodeExecute(calls, 7n, "0xabcd" as Hex);
    const { functionName, args } = decodeFunctionData({ abi: KRYARD_DELEGATE_ABI, data });
    expect(functionName).toBe("execute");
    expect((args as readonly unknown[])[1]).toBe(7n);
  });

  it("encodeExecuteWithGasReimbursement carries the token terms", () => {
    const data = encodeExecuteWithGasReimbursement(calls, 7n, "0xabcd" as Hex, USDC, 50n, RELAYER);
    const { functionName, args } = decodeFunctionData({ abi: KRYARD_DELEGATE_ABI, data });
    expect(functionName).toBe("executeWithGasReimbursement");
    expect((args as readonly unknown[])[4]).toBe(50n);
  });
});
