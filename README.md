# @hoox/web3-wallet-worker

[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org/) [![Runtime](https://img.shields.io/badge/Runtime-Bun-black?logo=bun)](https://bun.sh) [![Platform](https://img.shields.io/badge/Platform-Cloudflare%C2%AE%20Workers-orange?logo=cloudflare)](https://workers.cloudflare.com/) [![License](https://img.shields.io/badge/License-CC%20BY%204.0-lightgrey.svg)](https://creativecommons.org/licenses/by/4.0/)

Initializes a Web3 wallet from a private key or mnemonic phrase and returns its address.

## For CLI Users

Use this worker indirectly when you run `hoox` commands:

- `hoox secrets update-cf WALLET_PK_SECRET web3-wallet-worker` — set wallet private key
- `hoox secrets update-cf WALLET_MNEMONIC_SECRET web3-wallet-worker` — set wallet mnemonic

→ [CLI Reference](../../docs/reference/cli-commands.md)

## For Operators

This worker initializes a Web3 wallet from a private key or mnemonic phrase stored in Cloudflare Secrets, returns the resolved wallet address, and sends an initialization notification via the telegram-worker service binding. No swap, DeFi, or transaction signing operations are implemented at this layer. All requests are authenticated via shared internal key — no public endpoints are exposed.

→ [Operator Docs](../../docs/devops/workers/web3-wallet-worker.md)

## Development

```bash
bun test workers/web3-wallet-worker
```
