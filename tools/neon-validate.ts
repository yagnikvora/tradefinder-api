// Neon / Postgres connectivity check for the trade journal.  Run: npm run check-neon
//
// EXISTS SO NOBODY HAS TO HANDLE THE CREDENTIAL. The connection string is a live read-write
// credential; it belongs in `api/.env` and nowhere else — not in a chat, not in a log line, not in
// a screenshot. This script reads it from the environment, proves the whole path, and never prints
// it. The only thing it echoes back is the host, because "did I point it at the right project"
// is a real question and the host is the part that answers it without being secret.
//
// It runs the same statements the app runs, in the same order:
//
//   1. connect                 credentials, network, SSL
//   2. create table            the schema, which is created on demand rather than by a migration
//   3. write a row             an INSERT ... ON CONFLICT, the statement every save uses
//   4. read it back            and check the contents survived the JSONB round trip
//   5. clean up               the probe row is deleted; it must not appear in your journal
//   6. count what is stored    so a second machine can confirm it is looking at the same record

import '../src/env.js';
import { closePool, databaseUrl, getPool, probe } from '../src/momentum/journal/postgres.js';

/** The host and database, which are useful. Never the user, password or query string. */
function where(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.pathname}`;
  } catch {
    return 'an unparseable DATABASE_URL';
  }
}

const url = databaseUrl();

if (!url) {
  console.error(
    '\n  DATABASE_URL is not set, so the journal is storing to local disk only.\n\n' +
    '  That is a valid way to run — but it means the record lives on whichever machine\n' +
    '  recorded it, and you have to copy api/.cache/momentum/ by hand to read it elsewhere.\n\n' +
    '  To share it between machines, put your Neon connection string in api/.env:\n\n' +
    '      DATABASE_URL=postgresql://user:password@host/dbname?sslmode=require\n\n' +
    '  Use the POOLED string if Neon gave you both — the host with "-pooler" in it.\n' +
    '  Paste it into the file directly. Do not send it to anyone, and do not commit it:\n' +
    '  api/.env is already in .gitignore for exactly this reason.\n',
  );
  process.exit(1);
}

console.log(`\n  Journal database: ${where(url)}\n`);

const steps = await probe(getPool());
let failed = 0;

for (const s of steps) {
  if (s.ok) console.log(`  [ok]    ${s.step}${s.detail ? ` — ${s.detail}` : ''}`);
  else {
    failed++;
    console.log(`  [FAIL]  ${s.step} — ${s.detail ?? 'no detail'}`);
  }
}

// Anything the probe never reached, because a later step cannot pass if an earlier one failed.
const expected = ['connect', 'create table', 'write a row', 'read it back', 'clean up', 'count what is stored'];
for (const name of expected) {
  if (!steps.some((s) => s.step === name)) console.log(`  [skip]  ${name}`);
}

await closePool();

if (failed) {
  console.error(
    '\n  Not usable yet. The usual causes, in the order worth checking:\n\n' +
    '    connect fails          wrong password, or the string was truncated on paste. Neon strings\n' +
    '                           are long — check the tail survived, especially "?sslmode=require".\n' +
    '    connect times out      an office firewall blocking outbound 5432. Try the pooled host, and\n' +
    '                           if that is also blocked the journal will run on local disk and queue\n' +
    '                           its pushes until it can reach the database.\n' +
    '    SSL error              the string is missing sslmode=require, or a corporate TLS proxy is\n' +
    '                           re-signing the connection. The second one needs the proxy CA added\n' +
    '                           to NODE_EXTRA_CA_CERTS.\n' +
    '    create table fails     the role cannot create objects. Grant it, or create the table once\n' +
    '                           by hand from src/momentum/journal/postgres.ts (the SCHEMA export).\n',
  );
  process.exit(1);
}

console.log(
  '\n  Working. The journal will write to local disk AND to this database, and any machine\n' +
  '  with the same DATABASE_URL reads the same record.\n\n' +
  '    on the recording machine   npm run dev        (as usual — nothing else changes)\n' +
  '    on the reading machine     npm run viewer     (scheduler off; reads, never scans)\n',
);
