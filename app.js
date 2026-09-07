// Plesk / iisnode entry point. Not used by anything else.
//
// Plesk's Node.js panel defaults its "Application Startup File" to `app.js` at the application
// root, and iisnode starts exactly that file. The real server is TypeScript compiled to
// `dist/index.js`, so this is the one-line bridge between the two.
//
// WHY THIS FILE RATHER THAN JUST POINTING PLESK AT dist/index.js. That works too, and if you
// prefer it, set the startup file to `dist/index.js` and delete this. This exists because the
// default is `app.js`, a wrong startup path fails as a bare 500 from IIS with nothing in the
// application log to say why, and one file is cheaper than remembering the setting.
//
// `dist/` IS NOT IN GIT — it is a build artefact (see .gitignore). After a Git deploy you have to
// build on the server, from the Node.js panel's "Run Node.js commands" tab:
//
//     npm install --include=dev     # typescript is a devDependency, and Plesk runs in
//                                   # production mode where npm would otherwise skip it
//     npm run build                 # emits dist/
//
// The explicit check below turns "missing build" from an opaque IIS 500 into a message that says
// what to do, because that is the single most likely first-deploy failure.

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(here, 'dist', 'index.js');

if (!existsSync(entry)) {
  console.error(
    '\n  dist/index.js is missing — the TypeScript has not been compiled on this host.\n\n' +
    '  In Plesk: Node.js -> Run Node.js commands, then:\n' +
    '      npm install --include=dev\n' +
    '      npm run build\n\n' +
    '  --include=dev is required because Application Mode is "production", and typescript\n' +
    '  is a devDependency that npm would otherwise skip.\n',
  );
  process.exit(1);
}

await import('./dist/index.js');
