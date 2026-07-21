# Kryard SDK — gasless transactions & Turnkey-compatible signing

**Kryard is wallet infrastructure for gasless, sponsored transactions: a
Turnkey-wire-compatible EVM signer and a managed EIP-7702 relay.** A user signs a
7702 authorization and a batch digest; Kryard signs, fronts gas, and broadcasts the
type-4 transaction. Users never hold gas — and can even pay it in any ERC-20 token.
Migrating the signing side from Turnkey is a single `TURNKEY_BASE_URL` swap with zero
client changes.

- **Docs:** https://docs.kryard.com · **Compare:** [Kryard vs Turnkey](https://docs.kryard.com/compare/turnkey) · **FAQ:** https://docs.kryard.com/faq
- **Package:** [`@kryard/sdk`](https://www.npmjs.com/package/@kryard/sdk) (npm) — `viem` peer dep, built-in MIT X-Stamp signer, pure ESM.

## Install

```bash
npm i @kryard/sdk viem
```

## Sponsor a gasless batch

```ts
import { KryardRelayClient, createApiKeyStamper } from "@kryard/sdk";

const client = new KryardRelayClient({
  baseUrl: "https://api.kryard.com",
  organizationId: process.env.KRYARD_ORG!,
  stamper: createApiKeyStamper({
    apiPublicKey: process.env.KRYARD_API_PUBLIC_KEY!,
    apiPrivateKey: process.env.KRYARD_API_PRIVATE_KEY!,
  }),
});

// The user signs a 7702 authorization + a batch digest off-chain (no gas needed);
// Kryard fronts gas and broadcasts the type-4 transaction.
```

Full walkthrough: **[Quickstart](https://docs.kryard.com/relay/quickstart)** ·
Let users pay gas in a token: **[Pay gas in any token](https://docs.kryard.com/relay/erc20-gas)**.

## Why Kryard

- **Gasless UX without a bundler.** A managed EIP-7702 relay — smart-wallet
  UX from a plain EOA, no ERC-4337 bundler and no contract wallet to deploy.
  ([7702 vs 4337](https://docs.kryard.com/concepts/7702-vs-4337))
- **Pay gas in any ERC-20.** The on-chain `KryardDelegate` reimburses the relayer an
  exact, user-signed fee that can't be inflated.
- **Turnkey-wire-compatible.** Same endpoint paths, activity envelope, and `X-Stamp`
  auth — cutover is one env-var swap.
  ([Turnkey compatibility](https://docs.kryard.com/signing/turnkey-compatibility))
- **Open + dependency-light.** MIT X-Stamp signer built in, `viem` peer dependency.

## Turnkey → Kryard

```diff
- TURNKEY_BASE_URL=https://api.turnkey.com
+ TURNKEY_BASE_URL=https://api.kryard.com
```

---

## Two SDK surfaces

Kryard, like Turnkey, has two surfaces — and they map onto two SDK tiers:

| Tier | Auth | What it does | Status |
| --- | --- | --- | --- |
| **Server-side** | API key + `X-Stamp` | create keys, sign, export, drive the relay — from a backend | **shipping** |
| **Client-side** | passkey / OAuth / sessions | embedded wallets in web & mobile | **gated** on the embedded-wallet/auth product |

The current SDKs are **server-side / isomorphic** (the TypeScript package runs in Node
*and* in the browser for the relay's user-signing flow). The client-side embedded-wallet
kits (React, React Native, Swift, Kotlin, Flutter) land once Kryard ships sub-orgs +
passkey/OAuth auth.

## Language coverage

**Phase A — server-side (now):**

| Language | Package | Status |
| --- | --- | --- |
| TypeScript | `@kryard/sdk` (`packages/typescript`) | ✅ available |
| Python | `kryard` (`packages/python`) | planned |
| Go | `packages/go` | planned |
| Rust | `kryard` (`packages/rust`) | planned |

**Phase B — client-side, after embedded-wallet auth ships:** React → React Native →
Swift → Kotlin → Flutter.

## How a language is added

1. The API surface is defined once in [`spec/openapi.yaml`](spec/). The typed client +
   models are **code-generated** from it per language (generator TBD — see
   [`spec/README.md`](spec/README.md)).
2. A thin **hand-written core** sits on top of the generated client — the part that
   can't be generated: the `X-Stamp` stamper, canonical-JSON, the HPKE export decrypt,
   and the relay/EIP-7702 helpers.
3. Every language's tests assert against the shared [`vectors/`](vectors/) — so the Rust
   SDK derives the same Bitcoin address and produces the same X-Stamp as the TypeScript
   one.

So adding a language ≈ generate the client + port the small core + point the tests at
`vectors/`.

## Packages

- **[`packages/typescript`](packages/typescript)** — `@kryard/sdk`. Today: relay
  (`sponsorExecute`/`sponsorCall`), wallets & signing (`createPrivateKey`,
  `signRawPayload`, `signTransaction`), HPKE key export, and the `X-Stamp` stamper.

## Status

Live and proven end-to-end on testnets — Ethereum Sepolia, Base Sepolia, Arbitrum
Sepolia, Optimism Sepolia, Polygon Amoy, and BSC testnet. Mainnet is gated behind a
hardening milestone.

## License

MIT.
