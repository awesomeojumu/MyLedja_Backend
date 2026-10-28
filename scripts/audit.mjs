// Fails on a high or critical advisory unless its GHSA id is recorded in docs/QUESTIONS.md with a reason (build plan 2.6).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
let raw;
try {
  raw = execFileSync('npm', ['audit', '--json'], { cwd: root, encoding: 'utf8' });
} catch (e) {
  raw = e.stdout;
}
const report = JSON.parse(raw);
const recorded = readFileSync(resolve(root, 'docs/QUESTIONS.md'), 'utf8');

const advisories = new Map();
for (const vuln of Object.values(report.vulnerabilities ?? {})) {
  for (const via of vuln.via) {
    if (typeof via === 'object' && ['high', 'critical'].includes(via.severity)) advisories.set(via.url, via);
  }
}
const open = [...advisories.values()].filter((a) => !recorded.includes(a.url.split('/').pop()));
for (const a of advisories.values()) {
  const id = a.url.split('/').pop();
  console.log(`${open.includes(a) ? 'NOT RECORDED' : 'recorded'}: ${id} ${a.name} ${a.severity}`);
}
if (open.length) {
  console.error('audit: record each advisory above in docs/QUESTIONS.md with a reason, or upgrade.');
  process.exit(1);
}
console.log('audit: no unrecorded high or critical advisories.');
