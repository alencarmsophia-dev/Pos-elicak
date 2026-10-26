/* Pure helpers for the post-election layer. No DOM, network, storage, or dependencies. */
export const fmtInt = (value) => new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 }).format(Math.round(finite(value)));
export const fmtPct = (value) => new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(finite(value));
export const finite = (value) => {
  const n = typeof value === 'string' ? Number(value.replace(',', '.')) : Number(value);
  return Number.isFinite(n) ? n : 0;
};
export const pctOf = (value, total) => finite(total) > 0 ? (finite(value) / finite(total)) * 100 : 0;
export const normalizeUf = (value) => String(value || '').trim().toLowerCase().slice(0, 2);
export const normalizeText = (value) => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR').trim();

export function validateResult(result) {
  const errors = [];
  if (!result || typeof result !== 'object') return { ok: false, errors: ['Resultado ausente ou inválido.'] };
  const candidates = Array.isArray(result.cands) ? result.cands : Array.isArray(result.candidates) ? result.candidates : [];
  if (candidates.length < 2) errors.push('O resultado não contém os dois candidatos esperados.');
  const candidateVotes = candidates.reduce((sum, c) => sum + Math.max(0, finite(c.votes)), 0);
  const votes = result.votes || {};
  const valid = finite(votes.valid);
  const blank = finite(votes.blank);
  const nul = finite(votes.nul);
  const total = finite(votes.total);
  const electorate = result.electorate || {};
  const present = finite(electorate.present);
  const abst = finite(electorate.abst);
  const electorateTotal = finite(electorate.total);
  const epsilon = Math.max(2, Math.round(Math.max(total, valid, present, electorateTotal) * 0.00001));

  if (valid > 0 && Math.abs(candidateVotes - valid) > epsilon) {
    errors.push(`A soma dos votos dos candidatos (${fmtInt(candidateVotes)}) não fecha com os votos válidos (${fmtInt(valid)}).`);
  }
  if (total > 0 && valid + blank + nul > 0 && Math.abs(valid + blank + nul - total) > epsilon) {
    errors.push('Votos válidos, brancos e nulos não fecham com o comparecimento informado.');
  }
  if (present > 0 && total > 0 && Math.abs(present - total) > epsilon) {
    errors.push('O comparecimento não fecha com o total de votos informado.');
  }
  if (electorateTotal > 0 && present + abst > 0 && Math.abs(present + abst - electorateTotal) > epsilon) {
    errors.push('Comparecimento e abstenção não fecham com o eleitorado informado.');
  }
  if (electorateTotal > 0 && valid + blank + nul + abst > 0 && Math.abs((valid + blank + nul + abst) - electorateTotal) > epsilon) {
    errors.push('Votos válidos, brancos, nulos e abstenção não fecham com o eleitorado total.');
  }
  const pcts = candidates.map((c) => finite(c.pct)).filter((p) => p > 0);
  if (pcts.length >= 2 && Math.abs(pcts.reduce((a, b) => a + b, 0) - 100) > 0.15) {
    errors.push('Os percentuais dos candidatos não somam aproximadamente 100%.');
  }
  return { ok: errors.length === 0, errors, candidateVotes, valid, blank, nul, total, present, abst, electorateTotal };
}

export function validateHoursDataset(dataset) {
  const errors = [];
  if (!dataset || typeof dataset !== 'object') return { ok: false, errors: ['Arquivo JSON inválido.'] };
  if (dataset.schemaVersion !== 1) errors.push('schemaVersion deve ser 1.');
  if (!Array.isArray(dataset.points)) errors.push('O campo points precisa ser uma lista.');
  const points = Array.isArray(dataset.points) ? dataset.points : [];
  let lastTime = -Infinity;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (!p || typeof p !== 'object') { errors.push(`Ponto ${i + 1} inválido.`); continue; }
    const time = parsePointTime(p);
    if (!Number.isFinite(time)) errors.push(`Ponto ${i + 1}: informe hora em formato ISO ou data/hora válida.`);
    else if (time < lastTime) errors.push(`Ponto ${i + 1}: os horários precisam estar em ordem crescente.`);
    if (Number.isFinite(time)) lastTime = time;
    for (const k of ['secoesApuradas', 'votosA', 'votosB', 'brancos', 'nulos']) {
      if (!Number.isFinite(Number(p[k])) || Number(p[k]) < 0) errors.push(`Ponto ${i + 1}: ${k} precisa ser um número não negativo.`);
    }
  }
  if (!['totalizacao', 'votacao'].includes(dataset.semantics)) errors.push('semantics é obrigatório e deve ser "totalizacao" ou "votacao".');
  if (dataset.semantics === 'votacao' && !dataset.officialSource) errors.push('Dados de horário da votação exigem a identificação da fonte oficial.');
  return { ok: errors.length === 0, errors, points };
}

export function parsePointTime(point) {
  const raw = point?.hora ?? point?.timestamp ?? point?.datetime ?? null;
  if (raw == null || raw === '') return NaN;
  if (typeof raw === 'number') return raw < 1e12 ? raw * 1000 : raw;
  const text = String(raw).trim();
  let time = Date.parse(text);
  if (Number.isFinite(time)) return time;
  const m = text.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (m) {
    const date = String(point.dt || point.data || '');
    const parts = date.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (!parts) return NaN;
    // Convert Brasília local wall time to UTC. The São Paulo timezone has been UTC-3 since 2019.
    return Date.UTC(Number(parts[3]), Number(parts[2]) - 1, Number(parts[1]), Number(m[1]) + 3, Number(m[2]), Number(m[3] || 0));
  }
  return NaN;
}

export function hourInBrasilia(epochMs) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(epochMs));
  const values = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return Number(values.hour) + Number(values.minute) / 60;
}

export function deriveHourlyActivity(dataset, config = {}) {
  const check = validateHoursDataset(dataset);
  if (!check.ok || check.points.length < 2) return { ok: check.ok, errors: check.errors, buckets: [], hourly: [], intervals: [], timeline: [], points: [], baselineExcluded: check.points.length === 1 };
  const points = check.points.map((p) => ({ ...p, _time: parsePointTime(p) }));
  const defaultLabels = [
    { id: 'before17', label: 'Antes das 17h', from: -Infinity, to: 17 },
    { id: '17to18', label: '17h–18h', from: 17, to: 18, special: true },
    { id: '18to19', label: '18h–19h', from: 18, to: 19, special: true },
    { id: 'after19', label: 'Após as 19h', from: 19, to: Infinity },
  ];
  const labels = Array.isArray(config.buckets) && config.buckets.length ? config.buckets : defaultLabels;
  const specialStart = Number.isFinite(config.specialStart) ? config.specialStart : 17;
  const specialEnd = Number.isFinite(config.specialEnd) ? config.specialEnd : 19;
  const buckets = labels.map((b) => ({ ...b, votesA: 0, votesB: 0, brancos: 0, nulos: 0, sections: 0, intervals: 0 }));
  const hourlyMap = new Map();
  const intervals = [];
  const special = { votesA: 0, votesB: 0, brancos: 0, nulos: 0, sections: 0, intervals: 0 };
  let invalidDrops = 0;
  // The first point is an accumulated baseline, not an interval of newly-counted votes.
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const curr = points[i];
    const keys = ['votosA', 'votosB', 'brancos', 'nulos', 'secoesApuradas'];
    const deltas = Object.fromEntries(keys.map((k) => [k, finite(curr[k]) - finite(prev[k])]));
    if (Object.values(deltas).some((d) => d < 0)) { invalidDrops++; continue; }
    const hour = hourInBrasilia(curr._time);
    const bucket = buckets.find((b) => hour >= b.from && hour < b.to) || buckets[buckets.length - 1];
    bucket.votesA += deltas.votosA;
    bucket.votesB += deltas.votosB;
    bucket.brancos += deltas.brancos;
    bucket.nulos += deltas.nulos;
    bucket.sections += deltas.secoesApuradas;
    bucket.intervals++;
    const hourIndex = Math.max(0, Math.min(23, Math.floor(hour)));
    if (!hourlyMap.has(hourIndex)) hourlyMap.set(hourIndex, { id: `hour-${hourIndex}`, label: `${String(hourIndex).padStart(2, '0')}h–${String((hourIndex + 1) % 24).padStart(2, '0')}h`, from: hourIndex, to: hourIndex + 1, votesA: 0, votesB: 0, brancos: 0, nulos: 0, sections: 0, intervals: 0, special: hour >= specialStart && hour < specialEnd });
    const hourBucket = hourlyMap.get(hourIndex);
    hourBucket.votesA += deltas.votosA; hourBucket.votesB += deltas.votosB;
    hourBucket.brancos += deltas.brancos; hourBucket.nulos += deltas.nulos;
    hourBucket.sections += deltas.secoesApuradas; hourBucket.intervals++;
    if (hour >= specialStart && hour < specialEnd) {
      special.votesA += deltas.votosA; special.votesB += deltas.votosB;
      special.brancos += deltas.brancos; special.nulos += deltas.nulos;
      special.sections += deltas.secoesApuradas; special.intervals++;
    }
    const elapsedMinutes = Math.max(0, (curr._time - prev._time) / 60000);
    intervals.push({ at: curr._time, hour, elapsedMinutes, ...deltas, total: deltas.votosA + deltas.votosB + deltas.brancos + deltas.nulos, per10Min: elapsedMinutes > 0 ? (deltas.votosA + deltas.votosB + deltas.brancos + deltas.nulos) / elapsedMinutes * 10 : 0 });
  }
  const hourly = [...hourlyMap.values()].sort((a, b) => a.from - b.from);
  const timeline = points.map((p) => {
    const a = finite(p.votosA), b = finite(p.votosB), candidatesTotal = a + b;
    return { at: p._time, hour: hourInBrasilia(p._time), votosA: a, votosB: b, total: a + b + finite(p.brancos) + finite(p.nulos), secoesApuradas: finite(p.secoesApuradas), marginPP: pctOf(a, candidatesTotal) - pctOf(b, candidatesTotal) };
  });
  return { ok: invalidDrops === 0, errors: invalidDrops ? [`${invalidDrops} intervalo(s) com contagens regressivas foram ignorados.`] : [], buckets, hourly, intervals, timeline, special, baselineExcluded: true, invalidDrops, specialStart, specialEnd };
}

export function resultMargin(result) {
  const candidates = Array.isArray(result?.cands) ? result.cands : [];
  if (candidates.length < 2) return { margin: 0, leaderIndex: -1, tie: false };
  const vals = candidates.map((c) => finite(c.pct) || pctOf(c.votes, result?.votes?.valid));
  const a = vals[0] || 0;
  const b = vals[1] || 0;
  return { margin: Math.abs(a - b), leaderIndex: a === b ? -1 : a > b ? 0 : 1, tie: Math.abs(a - b) < 0.5 };
}

export function mappingCoverage(features, mappings) {
  const list = Array.isArray(features) ? features : [];
  const table = mappings && typeof mappings === 'object' ? mappings : {};
  const matched = list.filter((f) => Boolean(table[String(f.idIbge)] || f.tseCode)).length;
  return { total: list.length, matched, percent: list.length ? (matched / list.length) * 100 : 0, missing: list.filter((f) => !(table[String(f.idIbge)] || f.tseCode)).map((f) => f.idIbge) };
}
