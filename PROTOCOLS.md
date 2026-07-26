# Getting listed on the Arc ecosystem page

[stabledesk.xyz/ecosystem](https://stabledesk.xyz/ecosystem) is the registry of what is deployed on
Arc. Listing is free, there is no ranking to buy, and the data stays in this repo so anyone can
check it.

## The one rule

**Nothing is listed on a guess.** Every entry is either verified against the chain or confirmed by
the team that operates it. A registry of assumptions would be a fabricated record of an ecosystem,
and every metric attributed to a wrong address would be wrong in a way nobody could see.

That is why each entry carries a `source`:

| `source` | Means |
| --- | --- |
| `canonical` | A deterministic address that is identical on every EVM chain (Permit2, Multicall3, …). |
| `team` | The operator told us these are their contracts. |
| `observed` | We found the contract and classified it from its own behaviour. **Not** a claim about who runs it. |

`verified: true` is set only for `canonical` and `team`. Anything we worked out ourselves stays
unverified and is labelled `observed` on the page.

## Submit a protocol

Open a pull request adding an entry to the `REGISTRY` array in [`protocols.js`](protocols.js):

```js
{
  id: 'your-protocol',            // lowercase, a-z 0-9 and dashes — becomes /protocol?id=…
  name: 'Your Protocol',
  vendor: 'Your Company Ltd',     // null if unattributed
  category: 'payments',           // see CATEGORIES in protocols.js
  desc: 'One sentence on what it does. No marketing copy.',
  links: { site: 'https://…', docs: 'https://…', x: 'https://…', github: 'https://…' },
  contracts: [                    // lowercase, checksummed input is rejected
    '0x0000000000000000000000000000000000000000',
  ],
  networks: ['testnet'],          // omit entirely if the address is the same on both
  source: 'team',
  verified: true,
  added: '2026-07-26',
}
```

The registry validates itself at import time, so a malformed entry fails the boot rather than
serving a broken row. It will reject: a bad `id`, an unknown `category`, an invalid `source`, an
empty `contracts` array, a non-lowercase or malformed address, a duplicate `id`, and — importantly —
**two entries claiming the same contract**, because that would double-count its balance in the
chain total.

Don't have a GitHub account? Send the same fields to
[@getStabledesk](https://x.com/getStabledesk).

### What we check before merging

- Each address returns bytecode on the network you listed it under.
- The contracts belong to the protocol you say they do — from your docs, your repo, or a signed
  message from a deployer address.
- `desc` describes the product in a sentence. It is not a place for a pitch.

### Which contracts to list

List the addresses that **hold user funds** — vaults, pools, escrows, markets. Those are what TVL is
measured from. Routers and periphery contracts that never hold a balance are fine to include for
labelling, and they'll simply show `0`.

Do not list an address you don't control and can't evidence. If you're unsure whether a contract
qualifies, list it and say so in the PR.

## How TVL is measured

Stablecoin balances held by addresses with bytecode, read with `balanceOf`. On a chain where value
is denominated in USDC there is no volatile base asset to price and no LP share maths — so TVL needs
no per-protocol adapter, which is why this registry can stay small and still be accurate.

Consequences worth knowing before you compare our number to yours:

- **Balances held by plain wallets are not counted.** Contract-ness is established with
  `eth_getCode`, never inferred.
- **Assets other than the indexed stablecoins are invisible.** If your protocol holds value in
  something else, our figure will understate it — tell us and we'll say so on your entry.
- **Unattributed value is reported, not hidden.** A contract holding a balance that no entry claims
  appears under *Unnamed contracts* with its value in the chain total. It is never folded into
  someone else's number.

Full write-up: [stabledesk.xyz/methodology](https://stabledesk.xyz/methodology).

## If we got something wrong

Open a PR or tell us. Corrections to your own entry are merged without argument — you know your
contracts better than our classifier does. That includes asking to be **de**listed.
