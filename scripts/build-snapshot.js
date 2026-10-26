#!/usr/bin/env node
'use strict';
// Congela os arquivos oficiais do TSE em snapshots locais. Sem dependências externas.
// Uso: node scripts/build-snapshot.js [--allow-partial] [--municipalities]
const fs = require('node:fs');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');

const ROOT = path.resolve(__dirname, '..');
const OUTPUT = path.join(ROOT, 'public', 'data', 'final');
const BASE = 'https://resultados.tse.jus.br/oficial';
const ELECTION = { president: '6258', governor: '6260' };
const PRESIDENT_UFS = ['ac','al','ap','am','ba','ce','df','es','go','ma','mt','ms','mg','pa','pb','pr','pe','pi','rj','rn','rs','ro','rr','sc','sp','se','to','zz'];
const GOVERNOR_UFS = ['ac','am','df','es','rn','to'];
const GOV_ORDER = {
  ac: ['11','10'], am: ['55','22'], df: ['11','13'], es: ['10','15'], rn: ['44','13'], to: ['44','45'],
};
const PRESIDENT_ORDER = ['13','22'];
const args = new Set(process.argv.slice(2));
const ALLOW_PARTIAL = args.has('--allow-partial');
const INCLUDE_MUNICIPALITIES = args.has('--municipalities');
const MAPPING_PATH = path.resolve(process.cwd(), process.argv.find((x, i, a) => x === '--mapping' && a[i + 1]) ? process.argv[process.argv.indexOf('--mapping') + 1] : path.join(ROOT, 'public', 'data', 'municipios-map.json'));

function num(value) {
  if (value == null || value === '') return 0;
  const n = Number(String(value).replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}
function pct(value, total) { return total > 0 ? value / total * 100 : 0; }
function safeInt(value) { return Math.max(0, Math.floor(num(value))); }
function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file);
}
async function requestJson(url, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(url, { headers: { 'accept': 'application/json', 'user-agent': 'painel-apuracao-pos-eleicao/1.0' }, signal: AbortSignal.timeout(15000) });
      if (!response.ok) {
        const error = new Error(`HTTP ${response.status}`); error.status = response.status;
        if ([403,404,410].includes(response.status)) throw error;
        lastError = error;
      } else {
        const type = response.headers.get('content-type') || '';
        const body = await response.text();
        let data;
        try { data = JSON.parse(body); } catch { throw new Error(`Resposta não é JSON válido (${type || 'content-type ausente'})`); }
        return { data, status: response.status, url, headers: Object.fromEntries(['etag','last-modified','date'].map((k) => [k, response.headers.get(k)]).filter(([,v]) => v)) };
      }
    } catch (error) {
      lastError = error;
      if ([403,404,410].includes(error.status)) throw error;
    }
    if (attempt < attempts) await delay(350 * attempt);
  }
  throw lastError || new Error('Falha de rede desconhecida.');
}
function electionBase(election, uf, cargo) {
  const e6 = `e${String(election).padStart(6, '0')}`;
  return `${BASE}/ele2026/${election}/dados/${uf}/${uf}-c${cargo}-${e6}-u.json`;
}
function flattenCandidates(json, role, uf) {
  const wanted = role === 'gov' ? 3 : 1;
  const cargos = Array.isArray(json?.carg) ? json.carg : [];
  const cargo = cargos.find((c) => Number(c.cd) === wanted) || (cargos.length === 1 ? cargos[0] : null);
  const rows = [];
  for (const aggregate of cargo?.agr || []) for (const party of aggregate.par || []) for (const cand of party.cand || []) {
    rows.push({
      key: String(cand.sqcand || cand.n || ''), seq: num(cand.seq), n: String(cand.n || ''),
      name: String(cand.nmu || cand.nm || '').trim(), party: String(party.sg || '').trim(),
      votes: safeInt(cand.vap), pct: num(cand.pvapn ?? cand.pvap), elected: cand.e === 's',
    });
  }
  const wantedOrder = role === 'gov' ? (GOV_ORDER[uf] || []) : PRESIDENT_ORDER;
  rows.sort((a, b) => {
    const ia = wantedOrder.indexOf(a.n); const ib = wantedOrder.indexOf(b.n);
    if (ia >= 0 && ib >= 0) return ia - ib;
    if (ia >= 0) return -1;
    if (ib >= 0) return 1;
    return a.seq - b.seq;
  });
  return rows;
}
function normalizeEA20(json, role, uf, sourceUrl) {
  if (!json || typeof json !== 'object') throw new Error('Conteúdo EA20 vazio ou inválido.');
  const candidates = flattenCandidates(json, role, uf);
  if (candidates.length < 2) throw new Error(`Esperados dois candidatos; recebidos ${candidates.length}.`);
  const section = json.s || {}; const electorate = json.e || {}; const votes = json.v || {};
  const valid = safeInt(votes.vv);
  for (const cand of candidates) if (!cand.pct && valid) cand.pct = pct(cand.votes, valid);
  return {
    cands: candidates,
    sections: { total: safeInt(section.ts), done: safeInt(section.st), pct: num(section.pstn ?? section.pst) },
    electorate: { total: safeInt(electorate.te), present: safeInt(electorate.c), ppresent: num(electorate.pcn ?? electorate.pc), abst: safeInt(electorate.a), pabst: num(electorate.pan ?? electorate.pa) },
    votes: { total: safeInt(votes.tv), valid, pvalid: num(votes.pvvn ?? votes.pvv), blank: safeInt(votes.vb), pblank: num(votes.pvbn ?? votes.pvb), nul: safeInt(votes.tvn), pnul: num(votes.ptvnn ?? votes.ptvn) },
    final: json.tf === 's', dt: String(json.dt || json.dg || ''), ht: String(json.ht || json.hg || ''), sourceUrl,
    electionId: String(json.ele || ''), cargo: role === 'gov' ? 'Governador' : 'Presidente', uf,
  };
}
function validateRows(rows, expectedKeys, allowPartial) {
  const errors = [];
  const found = new Set(Object.keys(rows));
  for (const key of expectedKeys) if (!found.has(key)) errors.push(`Ausente: ${key}`);
  for (const [key, row] of Object.entries(rows)) {
    if (!row?.result?.final) errors.push(`Não confirmado como final pelo campo tf="s": ${key}`);
    const c = row?.result?.cands || [];
    const candTotal = c.reduce((sum, x) => sum + x.votes, 0);
    if (row?.result?.votes?.valid && Math.abs(candTotal - row.result.votes.valid) > Math.max(2, row.result.votes.valid * 0.00001)) errors.push(`Votos válidos divergentes em ${key}`);
  }
  if (errors.length && !allowPartial) {
    console.error('\nSnapshot não foi publicado porque faltam dados ou a totalização final não pôde ser confirmada:');
    errors.forEach((e) => console.error(` - ${e}`));
    console.error('\nSe deseja produzir um snapshot explicitamente incompleto para inspeção, use --allow-partial. Isso não confirma oficialidade nem conclusão.');
    return { ok: false, errors };
  }
  return { ok: errors.length === 0, errors };
}
async function fetchResult(role, uf) {
  const election = role === 'gov' ? ELECTION.governor : ELECTION.president;
  const cargo = role === 'gov' ? '0003' : '0001';
  const url = electionBase(election, uf, cargo);
  const response = await requestJson(url);
  const result = normalizeEA20(response.data, role, uf, url);
  return { result, status: response.status, responseUrl: response.url, receivedAt: new Date().toISOString() };
}
async function concurrentMap(items, limit, fn) {
  const results = new Array(items.length); let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) { const idx = next++; if (idx >= items.length) break; results[idx] = await fn(items[idx], idx); }
  });
  await Promise.all(workers); return results;
}
async function fetchWithReport(role, uf, failures) {
  try { const row = await fetchResult(role, uf); console.log(`✓ ${role}/${uf}: ${row.result.cands.map((c) => c.votes).join(' × ')} votos · ${row.result.dt} ${row.result.ht}`); return row; }
  catch (error) { failures.push({ role, uf, message: error.message }); console.error(`✗ ${role}/${uf}: ${error.message}`); return null; }
}
async function snapshotTracking(role) {
  const election = role === 'gov' ? ELECTION.governor : ELECTION.president;
  const e6 = `e${String(election).padStart(6, '0')}`;
  const url = `${BASE}/ele2026/${election}/dados/br/br-${e6}-ab.json`;
  try { const result = await requestJson(url); return { data: result.data, sourceUrl: url, downloadedAt: new Date().toISOString() }; }
  catch (error) { console.warn(`Aviso: arquivo de acompanhamento (${role}) indisponível: ${error.message}`); return null; }
}
function loadMapping() {
  if (!fs.existsSync(MAPPING_PATH)) return { complete: false, mappings: [] };
  try { return JSON.parse(fs.readFileSync(MAPPING_PATH, 'utf8')); }
  catch { return { complete: false, mappings: [] }; }
}
function parseCrosswalk(raw) {
  const list = Array.isArray(raw?.mappings) ? raw.mappings : [];
  return list.map((x) => ({
    ibgeCode: String(x.ibgeCode ?? x.ibge ?? '').trim(), tseCode: String(x.tseCode ?? x.tse ?? '').trim(),
    uf: String(x.uf || '').trim().toLowerCase(), name: String(x.name || x.municipio || '').trim(),
  })).filter((x) => x.ibgeCode && x.tseCode && /^[a-z]{2}$/.test(x.uf));
}
async function discoverMunicipalUrl(uf, role, tseCode) {
  const election = role === 'gov' ? ELECTION.governor : ELECTION.president;
  const cargo = role === 'gov' ? '0003' : '0001';
  const e6 = `e${String(election).padStart(6, '0')}`;
  // O TSE alterou padrões de arquivos entre ciclos. Esses padrões são apenas candidatos de sondagem;
  // o relatório registra qual foi realmente aceito pela resposta HTTP, sem assumir que exista.
  const candidates = [
    `${BASE}/ele2026/${election}/dados/${uf}/${tseCode}-${uf}-c${cargo}-${e6}-v.json`,
    `${BASE}/ele2026/${election}/dados/${uf}/${uf}-c${cargo}-${e6}-${tseCode}-v.json`,
    `${BASE}/ele2026/${election}/dados/${uf}/${tseCode}-${uf}-c${cargo}-${e6}-u.json`,
  ];
  for (const url of candidates) {
    try { const response = await requestJson(url, 1); return { url, json: response.data }; }
    catch (error) { if (![403,404,410].includes(error.status)) throw error; }
  }
  return null;
}
async function fetchMunicipalData(role, uf, mappings, outputRoot, failures) {
  const relevant = mappings.filter((m) => m.uf === uf);
  if (!relevant.length) return null;
  const first = relevant[0];
  let pattern;
  try { pattern = await discoverMunicipalUrl(uf, role, first.tseCode); }
  catch (error) { failures.push({ role, uf, municipality: first.name, message: `Sondagem municipal: ${error.message}` }); return null; }
  if (!pattern) { failures.push({ role, uf, message: 'Nenhum padrão municipal testado respondeu com JSON válido. Padrão não confirmado.' }); return null; }
  console.log(`Padrão municipal aceito pelo TSE (${role}/${uf}): ${pattern.url}`);
  const prefix = pattern.url.slice(0, pattern.url.lastIndexOf('/') + 1);
  const filename = pattern.url.slice(prefix.length);
  const patternTemplate = filename.replace(first.tseCode, '__TSE_CODE__');
  const e6 = `e${String(role === 'gov' ? ELECTION.governor : ELECTION.president).padStart(6, '0')}`;
  const cargo = role === 'gov' ? '0003' : '0001';
  const election = role === 'gov' ? ELECTION.governor : ELECTION.president;
  const rows = [];
  await concurrentMap(relevant, 8, async (mapping) => {
    const url = `${prefix}${patternTemplate.replace('__TSE_CODE__', mapping.tseCode)}`;
    try {
      const response = mapping.tseCode === first.tseCode ? { data: pattern.json, url: pattern.url } : await requestJson(url, 2);
      const normalized = normalizeEA20(response.data, role, uf, response.url || url);
      rows.push({ ibgeCode: mapping.ibgeCode, tseCode: mapping.tseCode, name: mapping.name || `Município ${mapping.ibgeCode}`, cands: normalized.cands, sections: normalized.sections, electorate: normalized.electorate, votes: normalized.votes, final: normalized.final, dt: normalized.dt, ht: normalized.ht, sourceUrl: response.url || url });
    } catch (error) { failures.push({ role, uf, municipality: mapping.name || mapping.tseCode, message: error.message }); }
  });
  rows.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  const dataset = { schemaVersion: 1, role, uf, electionCode: election, generatedAt: new Date().toISOString(), source: 'TSE · resultados oficiais', sourcePatternProbed: pattern.url, mappingCount: relevant.length, matchedResults: rows.length, complete: rows.length === relevant.length && rows.every((r) => r.final), municipalities: rows };
  atomicJson(path.join(outputRoot, 'municipalities', `${role}-${uf}.json`), dataset);
  return dataset;
}

async function main() {
  if (!Number.isFinite(Number(process.versions.node.split('.')[0])) || Number(process.versions.node.split('.')[0]) < 18) throw new Error('Node.js 18 ou superior é necessário (fetch nativo).');
  fs.mkdirSync(OUTPUT, { recursive: true });
  const oldMunicipalSummary = path.join(OUTPUT, 'municipalities-pres-summary.json');
  if (fs.existsSync(oldMunicipalSummary)) fs.unlinkSync(oldMunicipalSummary);
  // Um build novo não deve deixar resultados municipais antigos parecerem atuais.
  const oldMunicipalDirectory = path.join(OUTPUT, 'municipalities');
  if (fs.existsSync(oldMunicipalDirectory)) fs.rmSync(oldMunicipalDirectory, { recursive: true, force: true });
  console.log('Baixando snapshots diretamente das URLs de resultado estadual já usadas pelo painel.');
  console.log('Nota: a execução do script não substitui a conferência de oficialidade e dos totais no relatório.');
  const failures = [];
  const presidentItems = [{ role: 'pres', uf: 'br' }, ...PRESIDENT_UFS.map((uf) => ({ role: 'pres', uf }))];
  const presidentRowsList = await concurrentMap(presidentItems, 6, async (item) => ({ ...item, data: await fetchWithReport(item.role, item.uf, failures) }));
  const presidentRows = Object.fromEntries(presidentRowsList.filter((x) => x.data).map((x) => [x.uf, x.data]));
  const governorRowsList = await concurrentMap(GOVERNOR_UFS.map((uf) => ({ role: 'gov', uf })), 4, async (item) => ({ ...item, data: await fetchWithReport(item.role, item.uf, failures) }));
  const governorRows = Object.fromEntries(governorRowsList.filter((x) => x.data).map((x) => [x.uf, x.data]));
  const presNormalized = { national: presidentRows.br?.result || null, states: Object.fromEntries(Object.entries(presidentRows).filter(([uf]) => uf !== 'br').map(([uf, row]) => [uf, row.result])) };
  const govNormalized = { states: Object.fromEntries(Object.entries(governorRows).map(([uf, row]) => [uf, row.result])) };
  const presValidation = validateRows(presidentRows, ['br', ...PRESIDENT_UFS], ALLOW_PARTIAL);
  const govValidation = validateRows(governorRows, GOVERNOR_UFS, ALLOW_PARTIAL);
  const tracking = await Promise.all([snapshotTracking('pres'), snapshotTracking('gov')]);
  let municipalCounts = { generated: 0, missing: 0 };
  const presidentMunicipalDatasets = {};
  if (INCLUDE_MUNICIPALITIES) {
    const mappingRaw = loadMapping();
    const mappings = parseCrosswalk(mappingRaw);
    if (!mappingRaw.complete || !mappings.length) {
      console.warn(`A correspondência TSE ↔ IBGE em ${MAPPING_PATH} está ausente/incompleta. Nenhum resultado municipal foi tentado.`);
      failures.push({ role: 'municipal', uf: '*', message: 'Crosswalk TSE ↔ IBGE incompleto; resultados municipais não consultados.' });
    } else {
      const allUfs = [...new Set(mappings.map((m) => m.uf))];
      for (const role of ['pres', 'gov']) {
        const targetUfs = role === 'pres' ? allUfs : GOVERNOR_UFS;
        for (const uf of targetUfs) {
          const data = await fetchMunicipalData(role, uf, mappings, OUTPUT, failures);
          if (data) {
            municipalCounts.generated += data.matchedResults; municipalCounts.missing += data.mappingCount - data.matchedResults;
            if (role === 'pres') presidentMunicipalDatasets[uf] = data;
          }
        }
      }
    }
  }
  const generatedAt = new Date().toISOString();
  const stateFailures = failures.filter((failure) => failure.role !== 'municipal');
  const municipalFailures = failures.filter((failure) => failure.role === 'municipal');
  const allComplete = presValidation.ok && govValidation.ok && !stateFailures.length && !Object.values(presidentRows).some((x) => !x.result.final) && !Object.values(governorRows).some((x) => !x.result.final);
  const finalStamp = (row) => row?.result ? { date: row.result.dt || null, time: row.result.ht || null, timeZone: 'America/Sao_Paulo', sourceUrl: row.result.sourceUrl || null } : null;
  const presidentMunicipalRows = Object.entries(presidentMunicipalDatasets).flatMap(([uf, dataset]) => dataset.municipalities.map((row) => ({ ...row, uf })));
  const expectedMunicipalCount = Object.values(presidentMunicipalDatasets).reduce((sum, dataset) => sum + Number(dataset.mappingCount || 0), 0);
  const municipalityUfsExpected = PRESIDENT_UFS.filter((uf) => uf !== 'zz').length;
  const municipalitiesSummary = { schemaVersion: 1, role: 'pres', generatedAt, source: 'TSE · resultados oficiais', complete: Object.keys(presidentMunicipalDatasets).filter((uf) => uf !== 'zz').length === municipalityUfsExpected && presidentMunicipalRows.length === expectedMunicipalCount && presidentMunicipalRows.every((row) => row.final), statesReceived: Object.keys(presidentMunicipalDatasets).filter((uf) => uf !== 'zz').length, statesExpected: municipalityUfsExpected, expectedCount: expectedMunicipalCount, matchedResults: presidentMunicipalRows.length, municipalities: presidentMunicipalRows };
  if (INCLUDE_MUNICIPALITIES && presidentMunicipalRows.length) atomicJson(path.join(OUTPUT, 'municipalities-pres-summary.json'), municipalitiesSummary);
  const manifest = {
    schemaVersion: 1, ready: Object.keys(presidentRows).length > 0 || Object.keys(governorRows).length > 0,
    complete: allComplete, generatedAt, source: 'Tribunal Superior Eleitoral (TSE)', electionCycle: 'ele2026', electionCodes: ELECTION,
    totalizationTimestamp: { presidentNational: finalStamp(presidentRows.br), governorsByUf: Object.fromEntries(Object.entries(governorRows).map(([uf, row]) => [uf, finalStamp(row)])), note: 'Carimbos dt/ht publicados no snapshot EA20 do TSE; devem ser lidos como marca temporal da fonte, não como comprovação independente do instante em que a última seção foi concluída.' },
    files: { president: 'pres.json', governor: 'gov.json', presidentTracking: 'track-pres.json', governorTracking: 'track-gov.json', presidentMunicipalSummary: 'municipalities-pres-summary.json' },
    counts: { presidentFilesReceived: Object.keys(presidentRows).length, presidentFilesExpected: presidentItems.length, governorFilesReceived: Object.keys(governorRows).length, governorFilesExpected: GOVERNOR_UFS.length, municipalitiesReceived: municipalCounts.generated, municipalFailures: municipalCounts.missing },
    verification: { stateResultsFinal: presValidation.ok && govValidation.ok && !stateFailures.length, failures: stateFailures.length, errors: [...presValidation.errors, ...govValidation.errors, ...stateFailures], municipalities: { complete: municipalitiesSummary.complete, failures: municipalFailures.length, errors: municipalFailures } },
    note: allComplete ? 'Todos os arquivos estaduais previstos responderam e indicaram totalização final pelo campo tf="s". A completude municipal é separada.' : 'Snapshot estadual incompleto ou finalização não confirmada. Não trate este pacote como verificado sem revisar verification.errors.',
  };
  const canWrite = allComplete || ALLOW_PARTIAL;
  if (canWrite) {
    if (presNormalized.national || Object.keys(presNormalized.states).length) atomicJson(path.join(OUTPUT, 'pres.json'), { schemaVersion: 1, meta: manifest, ...presNormalized });
    if (Object.keys(govNormalized.states).length) atomicJson(path.join(OUTPUT, 'gov.json'), { schemaVersion: 1, meta: manifest, ...govNormalized });
    if (tracking[0]) atomicJson(path.join(OUTPUT, 'track-pres.json'), tracking[0]);
    if (tracking[1]) atomicJson(path.join(OUTPUT, 'track-gov.json'), tracking[1]);
    atomicJson(path.join(OUTPUT, 'manifest.json'), manifest);
  } else {
    console.error('\nNenhum snapshot de presidente/governador foi sobrescrito: conjunto incompleto ou totalização final não confirmada. Use --allow-partial somente para análise explícita de dados incompletos.');
    manifest.ready = false;
    atomicJson(path.join(OUTPUT, 'manifest.json'), manifest);
  }
  const report = {
    generatedAt, output: OUTPUT, published: canWrite, complete: allComplete,
    president: { received: Object.keys(presidentRows).length, expected: presidentItems.length },
    governors: { received: Object.keys(governorRows).length, expected: GOVERNOR_UFS.length },
    municipalResults: municipalCounts, failures, verificationErrors: manifest.verification.errors, municipalitySummary: { statesReceived: municipalitiesSummary.statesReceived, statesExpected: municipalitiesSummary.statesExpected, complete: municipalitiesSummary.complete, expectedCount: expectedMunicipalCount, matchedResults: presidentMunicipalRows.length },
  };
  atomicJson(path.join(OUTPUT, 'build-report.json'), report);
  console.log(`\nRelatório: ${path.relative(ROOT, path.join(OUTPUT, 'build-report.json'))}`);
  console.log(`Manifesto completo: ${allComplete ? 'SIM' : 'NÃO'}`);
  if (!allComplete) process.exitCode = 2;
}
main().catch((error) => { console.error(`Erro: ${error.stack || error.message}`); process.exitCode = 1; });
