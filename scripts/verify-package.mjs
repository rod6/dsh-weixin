import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const required = [
  'lib/index.js',
  'lib/client.js',
  'bin/dsh-weixin.mjs',
  'cordis.patch.yml',
  'README.md',
  'THIRD_PARTY_NOTICES.md',
];
await Promise.all(required.map((path) => access(resolve(root, path))));

const [client, host, patch] = await Promise.all([
  readFile(resolve(root, 'lib/client.js'), 'utf8'),
  readFile(resolve(root, 'lib/index.js'), 'utf8'),
  readFile(resolve(root, 'cordis.patch.yml'), 'utf8'),
]);
if (!client.includes('id: "@rod6/dsh-weixin"')) {
  throw new Error('client bundle does not register the package loader id');
}
if (!host.includes('dsh-weixin-host')) throw new Error('host bundle does not contain the plugin entry');
if (!patch.includes("name: '@rod6/dsh-weixin'")) throw new Error('bundle patch does not activate the package');
if (/private-bot-token|must-be-rolled-back|dotenv\/config/.test(client + host)) {
  throw new Error('built artifacts contain a test or environment secret marker');
}
console.log('Verified dsh-weixin package artifacts.');
