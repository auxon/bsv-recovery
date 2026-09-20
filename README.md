# BSV Browser address recovery

`recover-bsvbrowser-address.mjs` finds a BSV Browser "conventional wallet"
address that has disappeared from the app's list, and either gives you its
key (WIF) or sweeps the funds to an address you control.

BSV Browser derives **one receive address per calendar day** (BRC-29 receipt
keys derived from `m/0'/0'` with a date-based key ID). The app only shows
today's address, so a previously-issued one looks lost even though it is not.

The script scans calendar days, matches the address, and prints the matching
date plus the WIF for that key. It never sends your seed phrase anywhere; it
runs on your machine only.

## 1. Setup (one time)

Install [Node.js](https://nodejs.org) 18+, then:

```bash
git clone https://github.com/auxon/bsv-recovery
cd bsv-recovery
npm install
```

## 2. Find the address

```bash
cd bsv-recovery
node recover-bsvbrowser-address.mjs
```

- It prompts: paste your 12/24-word BSV Browser phrase, press Enter (typing
  is hidden).
- It prints your **identity key** first — compare it in the app to confirm
  it is the right wallet.
- It then scans the last 180 days of daily addresses and prints **MATCH**
  with the date, the address, and the **WIF** for that key.

If it says no match, scan further back:

```bash
node recover-bsvbrowser-address.mjs --days 3650
```

Only if you set a BIP39 passphrase on the wallet (rare), add
`--passphrase "..."`.

## 3. Get the funds out

### Option A — import the WIF into any wallet

Copy the printed WIF into a wallet that supports WIF import (for example
ElectrumSV), and send the balance wherever you like. This is the simplest
path.

### Option B — sweep directly (dry run first)

```bash
node recover-bsvbrowser-address.mjs --sweep <your-new-address>
```

This builds the sweep transaction and shows the fee and destination
**without sending**. When you are happy:

```bash
node recover-bsvbrowser-address.mjs --sweep <your-new-address> --broadcast
```

The destination must be a normal mainnet address you control (P2PKH,
starting with 1 or 3).

## Cautions

- **Never share the phrase or the WIF with anyone** — no helper, no
  "support", no developer. Whoever has it owns the funds.
- Run it on **your own machine**, ideally offline except for Option B
  (which needs the network to fetch UTXOs and broadcast).
- Nobody needs to be paid up front; the funds move only with your key. A
  thank-you after recovery is optional.
- If the script finds nothing, stop and re-check the phrase before trying
  anything else — do not paste the phrase into web tools.

## Notes

- `--address` defaults to `1DmvQdyoKSYeZ1jLRmEhN2k9ZHg11m9Tu2`; for a
  different address pass `--address <addr>`.
- `--days` defaults to 180; increase it for older addresses.
- The derivation was verified against BSV Browser's source and its own
  regression tests, including the exact date-keyed key ID — a match is
  trustworthy.