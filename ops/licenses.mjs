import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
let text =
  'Checkpoint dependency notices\n\nIncludes build-time dependencies whose code may be bundled in the browser.\n';
for (const [path, info] of Object.entries(lock.packages)) {
  if (!path || !existsSync(path)) continue;
  text += `\n\n--- ${path.replace(/^node_modules\//, '')} ${info.version ?? ''} (${info.license ?? 'see package'}) ---\n`;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (
      entry.isFile() &&
      /^(license|licence|notice|copying|ofl)(\.|$)/i.test(entry.name)
    )
      text += '\n' + readFileSync(`${path}/${entry.name}`, 'utf8') + '\n';
  }
}
writeFileSync('dist/THIRD_PARTY_LICENSES.txt', text);
