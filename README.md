# @kiorex/pay-contract

The shared Kiorly Pay adapter contract. Pure TypeScript, no network, no runtime dependencies. Consumed by `kiorex-platform` (Pay) and the Clinic (`billing-platform/payment-gateways`, `TenantPaymentChannel`, front-desk collections) through a **vendored tarball**, exactly like `@kiorex/contracts` (see `kiorex-platform/Docs/CONTRACTS_DISTRIBUTION.md`). It is never published to a registry.

Principle: Kiorly provides software (orchestration, routing, matching, reporting); licensed payment partners process and settle funds; Kiorly never holds funds. Funds-flow, licensing and fee questions are NEEDS_HUMAN (counsel, CBE rules) and are decided nowhere in this package.

Contents: neutral adapter and event types (`types`), bank / IPN file and webhook adapter (`bank-ipn`), config-only wallet skeleton on gateway wallet methods (`wallet`), invoice matching with confidence and review decisions (`matching`), signed single-use amount-locked links and QR plans (`links`), provider ordering with organisation preference and success rate (`routing`), shadow-mode fraud scorer with safety bounds (`fraud`), rollups with CSV / PDF (`rollup`), one AR/EN label set (`labels`).

Release: `npm run pack:local`, then in each consumer run `scripts/vendor-pay-contract.sh`.
