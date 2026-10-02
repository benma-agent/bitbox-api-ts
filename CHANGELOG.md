# Changelog

## Unreleased
- Preserve the sign of positive EIP-712 signed integers supplied as JavaScript numbers.
- Reset unfinished sessions when connecting to firmware v9.28.0 or newer, allowing host
  reconnects while the device remains powered on.

## 0.4.0
- Implement `showMnemonic()`, `changePassword()`, and `bip85AppBip39()` with the Rust/WASM firmware requirements

## 0.3.0
- Add Bitcoin APIs, sandbox actions, and simulator transaction-vector coverage
- Validate Bitcoin and Ethereum ECDSA signatures in Anti-Klepto and direct signing flows

## 0.2.0
- Add Cardano support

## 0.1.0
- Initial release
