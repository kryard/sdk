# @kryard/relay-sdk

A thin client for **Kryard's managed EIP-7702 relay**. A user signs a 7702
authorization + a batch digest; Kryard signs, fronts gas, and broadcasts the type-4
transaction — your user gets smart-wallet-grade UX (batched calls, gasless) with no
4337 bundler or custom delegate. Optionally the user pays gas in any **ERC-20**.

Pairs with the on-chain `KryardDelegate` and Kryard's relay routes.

## Install

```bash
npm i @kryard/relay-sdk viem
```

## Quick start

```ts
import { createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { KryardRelayClient, createApiKeyStamper, sponsorExecute, type UserSigner, type Call } from "@kryard/relay-sdk";

// 1. The Kryard relay client (the relayer ORG's API key stamps the request).
const client = new KryardRelayClient({
  baseUrl: "https://api.kryard.com",
  organizationId: process.env.KRYARD_ORG!,
  stamper: createApiKeyStamper({
    apiPublicKey: process.env.KRYARD_API_PUBLIC_KEY!,
    apiPrivateKey: process.env.KRYARD_API_PRIVATE_KEY!,
  }),
});

// 2. Adapt the USER's wallet to the UserSigner interface.
const account = privateKeyToAccount(process.env.USER_PK as Hex);
const wallet = createWalletClient({ account, chain: sepolia, transport: http() });
const signer: UserSigner = {
  address: account.address,
  signDigest: (digest) => account.signMessage({ message: { raw: digest } }),
  async signAuthorization({ contractAddress, chainId }) {
    const a = await wallet.signAuthorization({ account, contractAddress, chainId });
    return { address: a.address, chainId: a.chainId, nonce: a.nonce, r: a.r, s: a.s, yParity: a.yParity ?? 0 };
  },
};

// 3. Sponsor a batch (e.g. an ERC-20 transfer) — gasless for the user.
const calls: Call[] = [{ to: TOKEN, value: 0n, data: transferCalldata }];
const tx = await sponsorExecute({
  client, signer,
  chainId: 11155111,
  signWith: process.env.KRYARD_SIGN_WITH!, // the relayer key
  delegateAddress: KRYARD_DELEGATE,        // deployed KryardDelegate on this chain
  calls,
  nonce: BigInt(Date.now()),               // single-use delegate nonce
});
console.log(tx.id, tx.txHash);

// Poll to completion:
let status = tx;
while (!["confirmed", "failed", "expired"].includes(status.status)) {
  await new Promise((r) => setTimeout(r, 4000));
  status = await client.get(tx.id);
}
```

## ERC-20 gas payment ("pay gas in any token")

Add `gasToken` + `gasTokenAmount` + `relayer` to `sponsorExecute`. The user signs an
exact fee (the relayer can't inflate it); the on-chain `KryardDelegate` transfers that
token amount to the relayer as the batch's last step:

```ts
await sponsorExecute({
  client, signer, chainId, signWith, delegateAddress, calls, nonce,
  gasToken: USDC,
  gasTokenAmount: 50_000n,   // Kryard quotes this off-chain (gas × price × rate × margin)
  relayer: RELAYER_ADDRESS,  // the address the relayer signs with on this chain
});
```

## Custom delegate (delegate-agnostic) — e.g. a sweep

If you use your OWN 7702 delegate (not `KryardDelegate`), build the calldata + any
inner delegate signature yourself, then use `sponsorCall` — the SDK signs only the
7702 authorization and submits, making no assumption about the delegate:

```ts
import { sponsorCall } from "@kryard/relay-sdk";

// You build the call to your delegate (e.g. SweepDelegate.sweep(order, sweepSig)).
const sweepData = encodeFunctionData({ abi: SWEEP_DELEGATE_ABI, functionName: "sweep", args: [order, sweepSig] });

const tx = await sponsorCall({
  client, signer,                 // signer only needs { address, signAuthorization }
  chainId, signWith,
  delegateAddress: SWEEP_DELEGATE, // the 7702 target the user authorizes
  data: sweepData,                 // your pre-built calldata
  // optional ERC-20 accounting (if your call reimburses the relayer in token):
  // gasToken: USDC, gasTokenAmount: skimmedGasInToken,
});
```

`sponsorExecute` (above) is just `sponsorCall` with the KryardDelegate calldata built
for you.

## Lower-level building blocks

- `delegateDigest(...)` — the 32-byte digest the user personal-signs (mirrors the contract).
- `encodeExecute` / `encodeExecuteWithGasReimbursement` — KryardDelegate calldata.
- `buildSponsoredExecute(...)` — assemble a relay submit body from already-signed pieces (pure).
- `KryardRelayClient.submit` / `.get` — the raw relay route, X-Stamp authed.

## License

MIT.
