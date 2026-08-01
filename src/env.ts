// Load api/.env into process.env. Import this FIRST, before anything that reads config.
//
// Done in code rather than with node's --env-file flag on the npm scripts, because
// `tsx watch` does not carry that flag into the child it respawns on a file change: the
// first start had the token and every reload after it did not, so the dials worked until
// the next edit and then reported a missing token with nothing having changed. Loading it
// here means it holds however the process was started — watch mode, plain node, a tool
// script, or a scheduler invoking dist/.
//
// Resolved relative to this file rather than the working directory, so a cron entry or a
// service unit that runs from elsewhere still finds it.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

for (const file of [path.join(here, '..', '.env'), path.join(here, '..', '..', '.env')]) {
  try {
    // Throws when the file isn't there, which is the normal case for a fresh clone.
    process.loadEnvFile(file);
    break;
  } catch { /* try the next candidate */ }
}
