// Integration smoke (not part of `npm test`): drive the REAL Audiveris through the live
// service with a real scanned score. Requires AUDIVERIS_CMD and a running server:
//   AUDIVERIS_CMD=<path> npm start    then    node test-integration/smoke.mjs <pdf-path>
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

const BASE = process.env.OMR_URL ?? 'http://localhost:8480';
const pdfPath = process.argv[2];
if (!pdfPath) {
  console.error('usage: node test-integration/smoke.mjs <score.pdf>');
  process.exit(2);
}

const form = new FormData();
form.append('score', new Blob([readFileSync(pdfPath)], { type: 'application/pdf' }), basename(pdfPath));
const submitted = await fetch(`${BASE}/jobs`, { method: 'POST', body: form });
if (submitted.status !== 202) {
  console.error('submit failed:', submitted.status, await submitted.text());
  process.exit(1);
}
const { jobId } = await submitted.json();
console.log('job:', jobId);

let manifest;
for (let attempt = 0; attempt < 120; attempt++) {
  await new Promise((resolve) => setTimeout(resolve, 3000));
  manifest = await (await fetch(`${BASE}/jobs/${jobId}`)).json();
  process.stdout.write(`\rstatus: ${manifest.status}   `);
  if (manifest.status === 'done' || manifest.status === 'failed') break;
}
console.log('\nmanifest:', JSON.stringify(manifest, null, 2));
if (manifest.status !== 'done') process.exit(1);

const first = manifest.movements[0];
const bytes = new Uint8Array(
  await (await fetch(`${BASE}/jobs/${jobId}/files/${encodeURIComponent(first.filename)}`)).arrayBuffer(),
);
const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b;
console.log(`downloaded ${first.filename}: ${bytes.length} bytes, ZIP magic: ${isZip}`);
await fetch(`${BASE}/jobs/${jobId}`, { method: 'DELETE' });
const afterDelete = await fetch(`${BASE}/jobs/${jobId}`);
console.log('after delete:', afterDelete.status);
process.exit(isZip && afterDelete.status === 404 ? 0 : 1);
