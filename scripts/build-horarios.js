#!/usr/bin/env node
'use strict';
// Valida e instala uma série real de snapshots horários. Não cria nem interpola pontos.
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const ROOT = path.resolve(__dirname, '..');
function arg(name, fallback) { const i = process.argv.indexOf(name); return i >= 0 && process.argv[i + 1] ? path.resolve(process.cwd(), process.argv[i + 1]) : fallback; }
async function main() {
  const input = arg('--input', null);
  const output = arg('--output', path.join(ROOT, 'public', 'data', 'horarios.json'));
  if (!input) throw new Error('Informe um arquivo real: node scripts/build-horarios.js --input caminho/horarios.json');
  const helpers = await import(pathToFileURL(path.join(ROOT, 'public', 'pos-core.mjs')).href);
  const data = JSON.parse(fs.readFileSync(input, 'utf8'));
  const validation = helpers.validateHoursDataset(data);
  if (!validation.ok) throw new Error(`Série rejeitada:\n${validation.errors.map((e) => ` - ${e}`).join('\n')}`);
  if (!validation.points.length) throw new Error('A série não contém pontos; não será instalada como um histórico útil.');
  if (data.semantics === 'votacao' && (!data.officialSource || !data.officialSource.url)) throw new Error('Para semantics="votacao", informe officialSource com identificação e URL da fonte oficial.');
  const outputData = { ...data, source: data.source || input, installedAt: new Date().toISOString() };
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const tmp = `${output}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(outputData, null, 2)}\n`);
  fs.renameSync(tmp, output);
  console.log(`Série validada e gravada em ${path.relative(ROOT, output)} (${validation.points.length} pontos).`);
  console.log('Nenhum ponto foi criado, interpolado ou modificado numericamente.');
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
