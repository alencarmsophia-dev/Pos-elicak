import assert from 'node:assert/strict';
import {
  deriveHourlyActivity, fmtInt, fmtPct, mappingCoverage, normalizeText, pctOf,
  resultMargin, validateHoursDataset, validateResult,
} from '../public/pos-core.mjs';

assert.equal(fmtInt(12345), '12.345');
assert.equal(fmtPct(12.345), '12,35');
assert.equal(pctOf(25, 0), 0);
assert.equal(normalizeText('São Luís'), 'sao luis');

const result = {
  cands: [{ name: 'Candidato A', n: '13', votes: 600, pct: 60 }, { name: 'Candidato B', n: '22', votes: 400, pct: 40 }],
  votes: { total: 1080, valid: 1000, blank: 50, nul: 30 },
  electorate: { total: 1200, present: 1080, abst: 120 },
};
assert.equal(validateResult(result).ok, true);
assert.equal(resultMargin(result).leaderIndex, 0);
assert.equal(resultMargin({ cands: [{ pct: 50 }, { pct: 49.8 }] }).tie, true);
assert.equal(validateResult({ ...result, votes: { ...result.votes, valid: 990 } }).ok, false);

const hours = {
  schemaVersion: 1,
  semantics: 'totalizacao',
  points: [
    { hora: '2026-10-25T16:50:00-03:00', dt: '25/10/2026', secoesApuradas: 10, votosA: 100, votosB: 80, brancos: 10, nulos: 5 },
    { hora: '2026-10-25T17:10:00-03:00', dt: '25/10/2026', secoesApuradas: 15, votosA: 150, votosB: 120, brancos: 12, nulos: 6 },
    { hora: '2026-10-25T18:30:00-03:00', dt: '25/10/2026', secoesApuradas: 20, votosA: 200, votosB: 175, brancos: 14, nulos: 8 },
    { hora: '2026-10-25T19:10:00-03:00', dt: '25/10/2026', secoesApuradas: 25, votosA: 300, votosB: 250, brancos: 16, nulos: 10 },
  ],
};
assert.equal(validateHoursDataset(hours).ok, true);
assert.equal(validateHoursDataset({ schemaVersion: 1, points: [] }).ok, false, 'semantics não deve ser inferido');
const activity = deriveHourlyActivity(hours);
assert.equal(activity.ok, true);
assert.equal(activity.buckets.find((b) => b.id === '17to18').votesA, 50);
assert.equal(activity.buckets.find((b) => b.id === '18to19').votesB, 55);
assert.equal(activity.special.votesA, 100);
assert.equal(activity.special.votesB, 95);
assert.equal(activity.baselineExcluded, true);
assert.equal(activity.hourly.length, 3, 'deve construir a série hora a hora');
assert.equal(activity.timeline[0].marginPP, (100 / 180 * 100) - (80 / 180 * 100));
const customActivity = deriveHourlyActivity(hours, { specialStart: 16, specialEnd: 18, buckets: [{ id: 'first', label: 'Até 18h', from: -Infinity, to: 18 }, { id: 'later', label: 'Após 18h', from: 18, to: Infinity }] });
assert.equal(customActivity.buckets[0].votesA, 50);
assert.equal(customActivity.special.votesA, 50, 'a janela especial deve respeitar a configuração');
assert.equal(validateHoursDataset({ schemaVersion: 1, points: [{ hora: 'bad', secoesApuradas: -1 }] }).ok, false);

const coverage = mappingCoverage([{ idIbge: '1' }, { idIbge: '2', tseCode: 'x' }], { '1': { tseCode: 'a' } });
assert.equal(coverage.total, 2);
assert.equal(coverage.matched, 2);

console.log('PASS: testes de formatação, validação final, margens, faixas horárias, série hora a hora e correspondência.');
