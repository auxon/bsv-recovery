// Recover a BSV Browser "conventional wallet" address from its BIP39 phrase.
//
// BSV Browser derives one receive address per calendar day:
//   root key  = BIP39 seed -> BIP32 m/0'/0'
//   protocol  = [2, '3241645161d8']            (BRC-29)
//   key ID    = base64(YYYY-MM-DD) + ' ' + base64('legacy')
//   address   = P2PKH of KeyDeriver(root).derivePublicKey(protocol, keyID, 'anyone', true)
//
// This scans calendar days for the address, prints the matching day and the
// WIF for that key, and can build (optionally broadcast) a sweep transaction.
//
// Setup:
//   mkdir -p ~/recover && cd ~/recover
//   npm init -y >/dev/null 2>&1 && npm install @bsv/sdk
//
// Usage:
//   node recover-bsvbrowser-address.mjs                          # scan, default target
//   node recover-bsvbrowser-address.mjs --address <addr> --days 365
//   node recover-bsvbrowser-address.mjs --passphrase "..."       # only if one was set
//   node recover-bsvbrowser-address.mjs --sweep <destination>    # build a sweep to a new address
//   node recover-bsvbrowser-address.mjs --sweep <destination> --broadcast
//
// The phrase is read from stdin and never written anywhere. Run this on your
// own offline machine. No third party needs your seed to do this.

import { Mnemonic, HD, KeyDeriver, PrivateKey, PublicKey, P2PKH, Transaction, Utils } from '@bsv/sdk';

const DEFAULT_ADDRESS = '1DmvQdyoKSYeZ1jLRmEhN2k9ZHg11m9Tu2';
const PROTOCOL = [2, '3241645161d8'];
const SUFFIX = Utils.toBase64(Utils.toArray('legacy', 'utf8'));

function parseArgs(argv) {
  const out = { address: DEFAULT_ADDRESS, days: 180, passphrase: '', sweep: null, broadcast: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--address') out.address = argv[++i];
    else if (a === '--days') out.days = Number(argv[++i]);
    else if (a === '--passphrase') out.passphrase = argv[++i] ?? '';
    else if (a === '--sweep') out.sweep = argv[++i];
    else if (a === '--broadcast') out.broadcast = true;
    else if (a === '--help' || a === '-h') { console.log('see header of this file for usage'); process.exit(0); }
    else { console.error(`unknown option: ${a}`); process.exit(1); }
  }
  if (!Number.isInteger(out.days) || out.days < 1 || out.days > 20000) {
    console.error('--days must be an integer between 1 and 20000');
    process.exit(1);
  }
  return out;
}

async function readPhraseFromStdin() {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    const chunks = [];
    for await (const c of stdin) chunks.push(Buffer.from(c));
    return Buffer.concat(chunks).toString('utf8').trim().replace(/\s+/g, ' ');
  }
  process.stdout.write('Paste the 12/24-word BIP39 phrase, then press Enter (input hidden):\n> ');
  return await new Promise((resolve) => {
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    let buf = '';
    const onData = (chunk) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      for (const ch of text) {
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(wasRaw);
          stdin.removeListener('data', onData);
          stdin.pause();
          process.stdout.write('\n');
          resolve(buf.trim().replace(/\s+/g, ' '));
          return;
        }
        if (ch === '\u0003') process.exit(130);
        if (ch === '\u007f' || ch === '\b') buf = buf.slice(0, -1);
        else buf += ch;
      }
    };
    stdin.on('data', onData);
  });
}

export function rootKeyFromPhrase(phrase, passphrase = '') {
  const mnemonic = Mnemonic.fromString(phrase);
  const seed = mnemonic.toSeed(passphrase);
  const hd = HD.fromSeed(seed);
  return { primary: hd.derive("m/0'/0'").privKey, identity: hd.derive("m/0'/0'").privKey.toPublicKey().toString() };
}

export function dateForOffset(offset) {
  const d = new Date(Date.now() - offset * 86400000);
  return d.toISOString().slice(0, 10);
}

export function keyIdForDate(date) {
  return `${Utils.toBase64(Utils.toArray(date, 'utf8'))} ${SUFFIX}`;
}

export function deriveForDate(root, date) {
  const kd = new KeyDeriver(root);
  const keyID = keyIdForDate(date);
  const publicKey = kd.derivePublicKey(PROTOCOL, keyID, 'anyone', true);
  return {
    date,
    keyID,
    publicKey,
    privateKey: kd.derivePrivateKey(PROTOCOL, keyID, 'anyone'),
    address: publicKey.toAddress('mainnet'),
  };
}

export function scan(root, target, days) {
  for (let offset = -1; offset <= days; offset++) {
    const r = deriveForDate(root, dateForOffset(offset));
    if (r.address === target) return r;
  }
  return null;
}

export async function buildSweep(priv, utxos, destination, feePerByte = 2) {
  const tx = new Transaction(2, [], [], 0);
  const sourceScript = new P2PKH().lock(priv.toPublicKey().toAddress('mainnet'));
  for (const u of utxos) {
    tx.addInput({
      sourceTXID: u.txid,
      sourceOutputIndex: u.vout,
      sequence: 0xffffffff,
      unlockingScriptTemplate: new P2PKH().unlock(priv, 'all', false, u.satoshis, sourceScript),
    });
  }
  const total = utxos.reduce((s, u) => s + u.satoshis, 0);
  const size = 10 + utxos.length * 148 + 34 + 34;
  const fee = Math.max(200, Math.ceil(size * feePerByte));
  const out = total - fee;
  if (out <= 0) throw new Error('UTXO total does not cover the fee');
  tx.addOutput({ lockingScript: new P2PKH().lock(destination), satoshis: out });
  await tx.sign();
  return { tx, fee, out };
}

async function fetchUtxos(address) {
  const res = await fetch(`https://api.whatsonchain.com/v1/bsv/main/address/${address}/unspent/all`);
  if (!res.ok) throw new Error(`WhatsOnChain UTXO fetch failed: HTTP ${res.status}`);
  const body = await res.json();
  const rows = body.result ?? body;
  return rows
    .filter((r) => r.isSpentInMempoolTx !== true)
    .map((r) => ({ txid: r.tx_hash, vout: r.tx_pos, satoshis: r.value }));
}

async function broadcast(hex) {
  const res = await fetch('https://api.whatsonchain.com/v1/bsv/main/tx/raw', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ txhex: hex }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`broadcast failed: HTTP ${res.status} ${text}`);
  return text.trim();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const phrase = await readPhraseFromStdin();
  const { primary, identity } = rootKeyFromPhrase(phrase, args.passphrase);
  console.log(`identity key (compare with BSV Browser): ${identity}`);

  const hit = scan(primary, args.address, args.days);
  if (!hit) {
    console.error(`no match for ${args.address} in the last ${args.days} days.`);
    console.error('If you are sure this is the right phrase, re-run with a larger --days (e.g. 3650).');
    process.exit(2);
  }
  const wif = hit.privateKey.toWif();
  console.log(`\nMATCH`);
  console.log(`  date:  ${hit.date}`);
  console.log(`  keyID: ${hit.keyID}`);
  console.log(`  WIF:   ${wif}`);
  console.log('\nYou can import this WIF into any BSV wallet (e.g. ElectrumSV) and spend the funds.');
  console.log('Or sweep here: --sweep <your new address> [--broadcast]');

  if (args.sweep) {
    if (!/^[13][1-9A-HJ-NP-Za-km-z]{25,34}$/.test(args.sweep)) {
      console.error(`--sweep destination does not look like a mainnet P2PKH address: ${args.sweep}`);
      process.exit(1);
    }
    const utxos = await fetchUtxos(args.address);
    if (utxos.length === 0) {
      console.error('no spendable UTXOs found at the address (already swept?)');
      process.exit(3);
    }
    const { tx, fee, out } = await buildSweep(hit.privateKey, utxos, args.sweep);
    const hex = tx.toHex();
    const txid = tx.id('hex');
    console.log(`\nSWEEP`);
    console.log(`  inputs: ${utxos.length} (${utxos.reduce((s, u) => s + u.satoshis, 0)} sats)`);
    console.log(`  fee:    ${fee} sats`);
    console.log(`  to:     ${args.sweep} (${out} sats)`);
    console.log(`  txid:   ${txid}`);
    if (args.broadcast) {
      console.log(`  broadcast result: ${await broadcast(hex)}`);
    } else {
      console.log('  dry run (add --broadcast to send)');
      console.log(`  raw: ${hex}`);
    }
  }
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (invokedDirectly) {
  main().catch((e) => {
    console.error(`error: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  });
}