#!/usr/bin/env node
'use strict';
// Empacota geometria municipal do IBGE em SVG paths simplificados (uma UF por arquivo).
// A correspondência TSE ↔ IBGE é separada e nunca é inferida por igualdade de códigos.
const fs = require('node:fs');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const OUTPUT = path.join(PUBLIC, 'data', 'municipios');
const MAP_PATH = path.join(PUBLIC, 'data', 'municipios-map.json');
const SOURCE_DIR_ARG = process.argv.find((x, i, a) => x === '--source-dir' && a[i + 1]);
const MAPPING_ARG = process.argv.find((x, i, a) => x === '--mapping-file' && a[i + 1]);
const MAPPING_SOURCE_ARG = process.argv.find((x, i, a) => x === '--mapping-source' && a[i + 1]);
const SOURCE_DIR = SOURCE_DIR_ARG ? path.resolve(process.cwd(), process.argv[process.argv.indexOf('--source-dir') + 1]) : null;
const MAPPING_FILE = MAPPING_ARG ? path.resolve(process.cwd(), process.argv[process.argv.indexOf('--mapping-file') + 1]) : MAP_PATH;
const TOLERANCE = Number(process.env.MUNICIPIO_SIMPLIFY_TOLERANCE || 0.35);
const UFS = [
  ['ac','12'],['al','27'],['ap','16'],['am','13'],['ba','29'],['ce','23'],['df','53'],['es','32'],['go','52'],['ma','21'],['mt','51'],['ms','50'],['mg','31'],['pa','15'],['pb','25'],['pr','41'],['pe','26'],['pi','22'],['rj','33'],['rn','24'],['rs','43'],['ro','11'],['rr','14'],['sc','42'],['sp','35'],['se','28'],['to','17'],
];
const SOURCE_BASE = 'https://servicodados.ibge.gov.br/api/v3/malhas/estados';
const LOCALITY_BASE = 'https://servicodados.ibge.gov.br/api/v1/localidades/estados';
function atomicJson(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); const temp = `${file}.tmp-${process.pid}`; fs.writeFileSync(temp, `${JSON.stringify(value)}\n`); fs.renameSync(temp, file); }
async function fetchJson(url) {
  const response = await fetch(url, { headers: { accept: 'application/geo+json,application/json' }, signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const text = await response.text(); try { return JSON.parse(text); } catch { throw new Error(`${url}: JSON inválido.`); }
}
function parseCsv(text) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const parseLine = (line) => { const out = []; let s = ''; let q = false; for (let i = 0; i < line.length; i++) { const c = line[i]; if (c === '"' && line[i + 1] === '"' && q) { s += '"'; i++; } else if (c === '"') q = !q; else if (c === ',' && !q) { out.push(s); s = ''; } else s += c; } out.push(s); return out; };
  const headers = parseLine(lines.shift()).map((x) => normalizeHeader(x));
  return lines.map((line) => Object.fromEntries(parseLine(line).map((v, i) => [headers[i], v.trim()])));
}
function normalizeHeader(s) { return String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, ''); }
function loadCrosswalk(file) {
  if (!file || !fs.existsSync(file)) return { mappings: [], source: null };
  const raw = fs.readFileSync(file, 'utf8');
  if (/\.json$/i.test(file)) {
    let parsed; try { parsed = JSON.parse(raw); } catch { throw new Error(`Crosswalk JSON inválido: ${file}`); }
    const rows = (Array.isArray(parsed) ? parsed : parsed.mappings || []).map((row) => ({
      ibgeCode: String(row.ibgeCode ?? row.ibge ?? row.cd_ibge ?? '').trim(),
      tseCode: String(row.tseCode ?? row.tse ?? row.cd_tse ?? '').trim(),
      uf: String(row.uf ?? row.sigla_uf ?? '').trim().toLowerCase(), name: String(row.name ?? row.municipio ?? row.nome ?? '').trim(),
    })).filter((x) => x.ibgeCode && x.tseCode && x.uf);
    return { mappings: rows, source: Array.isArray(parsed) ? null : (typeof parsed.source === 'string' ? parsed.source : null) };
  }
  return { mappings: parseCsv(raw).map((row) => ({
    ibgeCode: String(row.ibgecode ?? row.ibge ?? row.codigoibge ?? row.cdibge ?? '').trim(),
    tseCode: String(row.tsecode ?? row.tse ?? row.codigotSE ?? row.cdtse ?? '').trim(),
    uf: String(row.uf ?? row.siglauf ?? '').trim().toLowerCase(),
    name: String(row.municipio ?? row.nome ?? row.name ?? '').trim(),
  })).filter((x) => x.ibgeCode && x.tseCode && x.uf), source: null };
}
function isOfficialSourceUrl(value) {
  try {
    const url = new URL(String(value || ''));
    const host = url.hostname.toLowerCase();
    const officialHost = host === 'tse.jus.br' || host.endsWith('.tse.jus.br') || host === 'ibge.gov.br' || host.endsWith('.ibge.gov.br');
    return url.protocol === 'https:' && officialHost;
  } catch { return false; }
}
async function sourceGeoJson(uf, id) {
  if (SOURCE_DIR) {
    const file = path.join(SOURCE_DIR, `${uf}.geojson`);
    if (fs.existsSync(file)) return { data: JSON.parse(fs.readFileSync(file, 'utf8')), source: file };
  }
  const url = `${SOURCE_BASE}/${id}?formato=application/vnd.geo+json&qualidade=minima&intrarregiao=municipio`;
  return { data: await fetchJson(url), source: url };
}
async function sourceNames(uf, id) {
  if (SOURCE_DIR) {
    const file = path.join(SOURCE_DIR, `${uf}.names.json`);
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  try { return await fetchJson(`${LOCALITY_BASE}/${id}/municipios`); } catch (error) { console.warn(`Aviso: nomes oficiais de ${uf} indisponíveis: ${error.message}`); return []; }
}
function flattenCoordinates(geometry, out = []) {
  if (!geometry) return out;
  const walk = (a) => {
    if (!Array.isArray(a)) return;
    if (a.length >= 2 && typeof a[0] === 'number' && typeof a[1] === 'number') out.push([a[0], a[1]]);
    else a.forEach(walk);
  };
  walk(geometry.coordinates); return out;
}
function pointLineDistanceSquared(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  if (dx === 0 && dy === 0) return (p[0] - a[0]) ** 2 + (p[1] - a[1]) ** 2;
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)));
  const x = a[0] + t * dx, y = a[1] + t * dy;
  return (p[0] - x) ** 2 + (p[1] - y) ** 2;
}
function douglasPeucker(points, tolerance) {
  if (points.length <= 4) return points;
  let max = tolerance * tolerance, index = -1;
  for (let i = 1; i < points.length - 1; i++) { const d = pointLineDistanceSquared(points[i], points[0], points[points.length - 1]); if (d > max) { max = d; index = i; } }
  if (index < 0) return [points[0], points[points.length - 1]];
  const left = douglasPeucker(points.slice(0, index + 1), tolerance), right = douglasPeucker(points.slice(index), tolerance);
  return left.slice(0, -1).concat(right);
}
function simplifyRing(ring, tolerance) {
  if (!Array.isArray(ring) || ring.length < 4) return ring || [];
  const closed = ring.length > 1 && ring[0][0] === ring.at(-1)[0] && ring[0][1] === ring.at(-1)[1];
  const points = closed ? ring.slice(0, -1) : ring.slice();
  const simplified = douglasPeucker(points.concat([points[0]]), tolerance);
  const result = simplified.length >= 4 ? simplified : points;
  return result.length && (result[0][0] !== result.at(-1)[0] || result[0][1] !== result.at(-1)[1]) ? [...result, result[0]] : result;
}
function geometryPolygons(geometry) {
  if (geometry?.type === 'Polygon') return [geometry.coordinates];
  if (geometry?.type === 'MultiPolygon') return geometry.coordinates;
  return [];
}
function coordPaths(geometry, project) {
  const polygonStrings = [];
  for (const polygon of geometryPolygons(geometry)) {
    for (const ring of polygon) {
      const pts = simplifyRing(ring.map(project), TOLERANCE);
      if (pts.length < 4) continue;
      let d = `M${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
      for (let i = 1; i < pts.length; i++) d += `L${pts[i][0].toFixed(1)} ${pts[i][1].toFixed(1)}`;
      d += 'Z'; polygonStrings.push(d);
    }
  }
  return polygonStrings.join('');
}
function ringCentroid(points) {
  if (!Array.isArray(points) || points.length < 4) return null;
  let twiceArea = 0, cx = 0, cy = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const [x1, y1] = points[i]; const [x2, y2] = points[i + 1];
    const cross = x1 * y2 - x2 * y1;
    twiceArea += cross; cx += (x1 + x2) * cross; cy += (y1 + y2) * cross;
  }
  if (Math.abs(twiceArea) < 1e-9) return null;
  return { area: twiceArea / 2, cx: cx / (3 * twiceArea), cy: cy / (3 * twiceArea) };
}
function centroid(geometry, project) {
  let weightedX = 0, weightedY = 0, netArea = 0;
  for (const polygon of geometryPolygons(geometry)) {
    const projectedRings = polygon.map((ring) => ringCentroid(ring.map(project)));
    const outer = projectedRings[0];
    if (!outer) continue;
    const outerWeight = Math.abs(outer.area);
    weightedX += outer.cx * outerWeight; weightedY += outer.cy * outerWeight; netArea += outerWeight;
    for (let i = 1; i < projectedRings.length; i++) {
      const hole = projectedRings[i]; if (!hole) continue;
      const holeWeight = Math.abs(hole.area);
      weightedX -= hole.cx * holeWeight; weightedY -= hole.cy * holeWeight; netArea -= holeWeight;
    }
  }
  if (netArea > 1e-9) return { cx: Number((weightedX / netArea).toFixed(1)), cy: Number((weightedY / netArea).toFixed(1)) };
  const coords = flattenCoordinates(geometry);
  if (!coords.length) return { cx: 0, cy: 0 };
  const mean = coords.reduce((acc, coordinate) => { const p = project(coordinate); acc.x += p[0]; acc.y += p[1]; return acc; }, { x: 0, y: 0 });
  return { cx: Number((mean.x / coords.length).toFixed(1)), cy: Number((mean.y / coords.length).toFixed(1)) };
}
function getCode(feature) {
  const raw = feature?.properties?.id ?? feature?.properties?.CD_MUN ?? feature?.properties?.CD_GEOCMU ?? feature?.id ?? '';
  const m = String(raw).match(/\d{6,7}/); return m ? m[0] : '';
}
function buildStateFile(uf, rawGeo, names, mappings, source) {
  const featuresIn = Array.isArray(rawGeo?.features) ? rawGeo.features : [];
  if (!featuresIn.length) throw new Error(`A resposta de ${uf} não tem uma FeatureCollection com features.`);
  const coords = featuresIn.flatMap((f) => flattenCoordinates(f.geometry));
  if (!coords.length) throw new Error(`Sem coordenadas de geometria para ${uf}.`);
  let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
  for (const coordinate of coords) {
    if (!Array.isArray(coordinate) || !Number.isFinite(coordinate[0]) || !Number.isFinite(coordinate[1])) continue;
    minLon = Math.min(minLon, coordinate[0]); maxLon = Math.max(maxLon, coordinate[0]);
    minLat = Math.min(minLat, coordinate[1]); maxLat = Math.max(maxLat, coordinate[1]);
  }
  if (![minLon, maxLon, minLat, maxLat].every(Number.isFinite)) throw new Error(`Coordenadas inválidas para ${uf}.`);
  const pad = 8; const width = 640 - pad * 2, height = 640 - pad * 2;
  const lonSpan = Math.max(0.000001, maxLon - minLon), latSpan = Math.max(0.000001, maxLat - minLat);
  const scale = Math.min(width / lonSpan, height / latSpan);
  const drawWidth = lonSpan * scale, drawHeight = latSpan * scale;
  const ox = (640 - drawWidth) / 2, oy = (640 - drawHeight) / 2;
  const project = ([lon, lat]) => [ox + (lon - minLon) * scale, oy + (maxLat - lat) * scale];
  const nameMap = new Map((names || []).map((r) => [String(r.id), String(r.nome || r.name || '')]));
  const mappingMap = new Map(mappings.filter((m) => m.uf === uf).map((m) => [m.ibgeCode, m]));
  const features = featuresIn.map((feature) => {
    const idIbge = getCode(feature); const map = mappingMap.get(idIbge);
    const officialName = feature.properties?.name || feature.properties?.NM_MUN || feature.properties?.nome || nameMap.get(idIbge) || map?.name || '';
    if (!idIbge) return null;
    const d = coordPaths(feature.geometry, project); const center = centroid(feature.geometry, project);
    return { idIbge, tseCode: map?.tseCode || null, name: officialName, d, ...center };
  }).filter((f) => f && f.d);
  const mapped = features.filter((f) => f.tseCode).length;
  const expected = (names || []).length;
  return {
    schemaVersion: 1, uf, source: { geometry: source, nameSource: 'IBGE Localidades / fonte disponível em build' },
    generatedAt: new Date().toISOString(), viewBox: { x: 0, y: 0, width: 640, height: 640 },
    featureCount: features.length, mappedCount: mapped, mappingCoverage: features.length ? mapped / features.length * 100 : 0,
    localityApiCount: expected || null, simplifyTolerance: TOLERANCE, features,
  };
}
async function main() {
  if (Number(process.versions.node.split('.')[0]) < 18) throw new Error('Node.js 18 ou superior é necessário.');
  const loadedCrosswalk = loadCrosswalk(MAPPING_FILE);
  const mappings = loadedCrosswalk.mappings;
  const mappingSource = MAPPING_SOURCE_ARG ? process.argv[process.argv.indexOf('--mapping-source') + 1] : loadedCrosswalk.source;
  const officialMappingSource = isOfficialSourceUrl(mappingSource) ? mappingSource : null;
  const duplicateTse = new Set(); const seenTse = new Set();
  const duplicateIbgeMapping = new Set(); const seenIbgeMapping = new Set();
  const knownUfs = new Set(UFS.map(([uf]) => uf));
  const invalidMappings = mappings.filter((m) => !knownUfs.has(m.uf) || !/^\d{7}$/.test(m.ibgeCode) || !/^\d+$/.test(m.tseCode));
  for (const m of mappings) {
    const key = `${m.uf}:${m.tseCode}`; if (seenTse.has(key)) duplicateTse.add(key); seenTse.add(key);
    const ibgeKey = `${m.uf}:${m.ibgeCode}`; if (seenIbgeMapping.has(ibgeKey)) duplicateIbgeMapping.add(ibgeKey); seenIbgeMapping.add(ibgeKey);
  }
  if (duplicateTse.size) throw new Error(`Crosswalk possui códigos TSE duplicados no mesmo estado: ${[...duplicateTse].slice(0, 10).join(', ')}`);
  if (duplicateIbgeMapping.size) throw new Error(`Crosswalk possui códigos IBGE duplicados na mesma UF: ${[...duplicateIbgeMapping].slice(0, 10).join(', ')}`);
  if (invalidMappings.length) throw new Error(`Crosswalk possui ${invalidMappings.length} mapeamento(s) inválido(s); verifique UF e códigos municipais antes de gerar a malha.`);
  fs.mkdirSync(OUTPUT, { recursive: true });
  const files = []; const errors = [];
  for (const [uf, id] of UFS) {
    try {
      const [geo, names] = await Promise.all([sourceGeoJson(uf, id), sourceNames(uf, id)]);
      const built = buildStateFile(uf, geo.data, names, mappings, geo.source);
      const file = path.join(OUTPUT, `${uf}.json`); atomicJson(file, built); files.push(built);
      console.log(`✓ ${uf.toUpperCase()}: ${built.featureCount} geometrias · ${built.mappedCount} códigos TSE correspondidos`);
    } catch (error) { errors.push({ uf, message: error.message }); console.error(`✗ ${uf.toUpperCase()}: ${error.message}`); }
    await delay(80);
  }
  const allIds = files.flatMap((f) => f.features.map((feature) => ({ uf: f.uf, idIbge: feature.idIbge })));
  const seenIbge = new Set(); const duplicateIbge = [];
  for (const row of allIds) { if (seenIbge.has(row.idIbge)) duplicateIbge.push(row.idIbge); seenIbge.add(row.idIbge); }
  const foundGeometry = new Set(allIds.map((x) => `${x.uf}:${x.idIbge}`));
  const exceptions = [];
  for (const feature of files.flatMap((f) => f.features.map((x) => ({ ...x, uf: f.uf })))) {
    if (!feature.tseCode) exceptions.push({ uf: feature.uf, ibgeCode: feature.idIbge, name: feature.name || null, reason: 'Sem correspondência TSE ↔ IBGE fornecida' });
  }
  for (const e of errors) exceptions.push({ uf: e.uf, reason: `Geometria não gerada: ${e.message}` });
  for (const code of duplicateIbge) exceptions.push({ ibgeCode: code, reason: 'Código IBGE duplicado entre arquivos de UF' });
  const crosswalkOut = {
    schemaVersion: 1, complete: files.length === UFS.length && exceptions.length === 0 && mappings.length > 0 && Boolean(officialMappingSource),
    source: officialMappingSource,
    generatedAt: new Date().toISOString(), mappingCount: mappings.length,
    expectedGeometryFiles: UFS.length, geometryFilesGenerated: files.length,
    geometries: allIds.length, mappedGeometryCount: files.reduce((sum, file) => sum + Number(file.mappedCount || 0), 0),
    duplicateTseCodes: [...duplicateTse], exceptions,
    mappings: mappings.map((m) => ({ ibgeCode: m.ibgeCode, tseCode: m.tseCode, uf: m.uf, name: m.name || null })),
    note: officialMappingSource ? 'Fonte de correspondência fornecida como URL HTTPS de domínio oficial; a cobertura só é considerada completa quando todas as geometrias têm vínculo sem exceções.' : 'Fonte oficial de correspondência não identificada por URL HTTPS de domínio oficial. Informe --mapping-source com a URL oficial verificável; não foi inferida igualdade entre códigos.',
  };
  atomicJson(MAP_PATH, crosswalkOut);
  const report = { generatedAt: new Date().toISOString(), output: OUTPUT, geometryFilesGenerated: files.length, expectedGeometryFiles: UFS.length, geometryCount: allIds.length, mappingCount: mappings.length, exceptions: exceptions.length, errors };
  atomicJson(path.join(PUBLIC, 'data', 'municipios-build-report.json'), report);
  console.log(`\nCorrespondências TSE ↔ IBGE: ${crosswalkOut.complete ? '100% conferidas' : 'INCOMPLETAS — não presumidas'}`);
  console.log(`Relatório: public/data/municipios-build-report.json`);
  if (errors.length || !crosswalkOut.complete) process.exitCode = 2;
}
main().catch((error) => { console.error(`Erro: ${error.stack || error.message}`); process.exitCode = 1; });
