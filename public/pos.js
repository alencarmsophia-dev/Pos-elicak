/* Pós-eleição: camada isolada. Não altera app.js, o mapa estadual ou o motor ao vivo. */
import { CANDIDATES, GOV_CANDIDATES, GOV_UFS } from './app.js';
import {
  deriveHourlyActivity, finite, fmtInt, fmtPct, normalizeText, normalizeUf,
  pctOf, resultMargin, validateHoursDataset, validateResult,
} from './pos-core.mjs';

(() => {
  'use strict';
  const STATE_NAMES = {
    ac: 'Acre', al: 'Alagoas', ap: 'Amapá', am: 'Amazonas', ba: 'Bahia', ce: 'Ceará', df: 'Distrito Federal',
    es: 'Espírito Santo', go: 'Goiás', ma: 'Maranhão', mt: 'Mato Grosso', ms: 'Mato Grosso do Sul', mg: 'Minas Gerais',
    pa: 'Pará', pb: 'Paraíba', pr: 'Paraná', pe: 'Pernambuco', pi: 'Piauí', rj: 'Rio de Janeiro', rn: 'Rio Grande do Norte',
    rs: 'Rio Grande do Sul', ro: 'Rondônia', rr: 'Roraima', sc: 'Santa Catarina', sp: 'São Paulo', se: 'Sergipe',
    to: 'Tocantins', zz: 'Exterior',
  };
  const REGIONS = {
    Norte: ['ac', 'ap', 'am', 'pa', 'ro', 'rr', 'to'],
    Nordeste: ['al', 'ba', 'ce', 'ma', 'pb', 'pe', 'pi', 'rn', 'se'],
    'Centro-Oeste': ['df', 'go', 'mt', 'ms'],
    Sudeste: ['es', 'mg', 'rj', 'sp'],
    Sul: ['pr', 'rs', 'sc'],
    Exterior: ['zz'],
  };
  const PRES_UFS = Object.keys(STATE_NAMES);
  const HOUR_BUCKET_CONFIG = {
    specialStart: 17,
    specialEnd: 19,
    buckets: [
      { id: 'before17', label: 'Antes das 17h', from: -Infinity, to: 17 },
      { id: '17to18', label: '17h–18h', from: 17, to: 18, special: true },
      { id: '18to19', label: '18h–19h', from: 18, to: 19, special: true },
      { id: 'after19', label: 'Após as 19h', from: 19, to: Infinity },
    ],
  };
  const HOUR_WINDOW_LABEL = `${String(HOUR_BUCKET_CONFIG.specialStart).padStart(2, '0')}h–${String(HOUR_BUCKET_CONFIG.specialEnd).padStart(2, '0')}h`;
  const DEFAULT_HOURS = {
    schemaVersion: 1, semantics: 'totalizacao', timeZone: 'America/Sao_Paulo',
    window: { start: '17:00', end: '19:00', officiallyVerified: false }, source: null, officialSource: null, points: [],
  };
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const jsonClone = (value) => JSON.parse(JSON.stringify(value));
  const isTV = new URLSearchParams(location.search).has('tv');
  const rootStyles = getComputedStyle(document.documentElement);
  let presidentSnapshot = null;
  let governorSnapshot = null;
  let municipalitySummaryData = null;
  let municipalitySummaryRequested = false;
  let snapshotManifest = null;
  let hoursData = jsonClone(DEFAULT_HOURS);
  let hoursImportedInSession = false;
  let selectedAnalysisRole = 'pres';
  let selectedGovUf = 'ac';
  let municipalContext = null;
  let municipalGeometry = null;
  let municipalResults = null;
  let municipalMappings = null;
  let municipalRowsCache = null;
  let municipalZoom = { scale: 1, x: 0, y: 0, base: null };
  let municipalPointer = null;
  const municipalPointers = new Map();
  let municipalPinch = null;
  let municipalMoved = false;
  let bulletinSelections = { final: true, composition: true, states: false, regions: false, municipalities: false, hours: false, governors: false };
  const selectedBulletinGovUfs = new Set(GOV_UFS);
  let currentBulletin = null;
  let previousFocus = null;
  const resultCache = new Map();

  function currentRoute() {
    const parts = String(location.hash || '').replace(/^#/, '').toLowerCase().split('/').filter(Boolean);
    const role = parts[0] === 'gov' ? 'gov' : 'pres';
    const uf = normalizeUf(parts[1]);
    return { role, uf: STATE_NAMES[uf] ? uf : null };
  }
  function activeSnapshot(role = selectedAnalysisRole) { return role === 'gov' ? governorSnapshot : presidentSnapshot; }
  function activeResult(role = selectedAnalysisRole, uf = null) {
    const snapshot = activeSnapshot(role);
    if (!snapshot) return null;
    return role === 'pres' ? snapshot.national || null : (snapshot.states?.[uf || selectedGovUf] || null);
  }
  function candidateProfiles(result, role = selectedAnalysisRole, uf = selectedGovUf) {
    const candidates = Array.isArray(result?.cands) ? result.cands : [];
    return candidates.map((cand, idx) => {
      let profile;
      if (role === 'gov') {
        const list = GOV_CANDIDATES[uf] || [];
        profile = list.find((g) => String(g.n) === String(cand.n) || normalizeText(g.name) === normalizeText(cand.name));
      } else {
        profile = CANDIDATES[String(cand.n)];
      }
      const cssColor = getComputedStyle(document.documentElement).getPropertyValue(`--cand-${idx}`).trim();
      const light = matchMedia('(prefers-color-scheme: light)').matches;
      const color = profile ? (light ? profile.colorLight : profile.colorDark) : cssColor || (idx === 0 ? '#d91b2b' : '#1a4fd1');
      return { ...cand, idx, color, photo: profile?.photo || '', displayName: profile?.name || cand.name || `Candidato ${idx + 1}`, party: profile?.party || cand.party || '' };
    });
  }
  function currentTotal(result) { return finite(result?.votes?.total) || finite(result?.electorate?.present) || finite(result?.votes?.valid); }
  function sectionPercent(result) {
    const direct = result?.sections?.pct;
    if (direct !== null && direct !== undefined && direct !== '' && Number.isFinite(Number(direct)) && Number(direct) > 0) return Number(direct);
    const total = finite(result?.sections?.total); const done = finite(result?.sections?.done);
    return total > 0 && done >= 0 ? pctOf(done, total) : null;
  }
  function candidateShare(cand, result) { return finite(cand?.pct) || pctOf(cand?.votes, result?.votes?.valid); }
  function validDatasetOrMessage(result, label = 'Resultado') {
    if (!result) return { ok: false, message: `${label}: dados finais ainda não gerados.` };
    if (result.final !== true) return { ok: false, message: `${label}: a totalização final não foi confirmada no snapshot (campo final ausente ou diferente de true). Os números foram ocultados.` };
    const validation = validateResult(result);
    if (!validation.ok) return { ok: false, message: `${label}: os totais não passaram na conferência automática. Os números foram ocultados para evitar divulgar um cálculo inconsistente.`, errors: validation.errors };
    return { ok: true, validation };
  }
  function emptyMarkup(message, details = '') {
    return `<div class="pos-empty" role="status"><span class="pos-empty-mark" aria-hidden="true">—</span><p>${esc(message)}</p>${details ? `<small>${esc(details)}</small>` : ''}</div>`;
  }
  function card(title, body, subtitle = '') {
    return `<article class="pos-card"><header class="pos-card-head"><div><h3>${esc(title)}</h3>${subtitle ? `<p>${esc(subtitle)}</p>` : ''}</div><div class="pos-card-head-actions"><button type="button" class="pos-secondary-btn pos-card-share" data-pos-share-card>Compartilhar este gráfico</button><small class="pos-card-share-status" role="status" aria-live="polite"></small></div></header><div class="pos-card-body">${body}</div></article>`;
  }
  function sumResults(results) {
    const usable = results.filter(Boolean);
    if (!usable.length) return null;
    const sums = {
      cands: [], sections: { total: 0, done: 0, pct: 0 }, final: usable.every((r) => r.final === true),
      electorate: { total: 0, present: 0, ppresent: 0, abst: 0, pabst: 0 },
      votes: { total: 0, valid: 0, pvalid: 0, blank: 0, pblank: 0, nul: 0, pnul: 0 },
    };
    const maxCand = Math.max(...usable.map((r) => r.cands?.length || 0));
    for (let i = 0; i < maxCand; i++) {
      const source = usable.find((r) => r.cands?.[i]);
      sums.cands[i] = { ...(source?.cands?.[i] || {}), votes: 0, pct: 0 };
      sums.cands[i].name = source?.cands?.[i]?.name || `Candidato ${i + 1}`;
    }
    for (const r of usable) {
      r.cands?.forEach((c, i) => { if (sums.cands[i]) sums.cands[i].votes += finite(c.votes); });
      for (const key of ['total', 'valid', 'blank', 'nul']) sums.votes[key] += finite(r.votes?.[key]);
      for (const key of ['total', 'present', 'abst']) sums.electorate[key] += finite(r.electorate?.[key]);
      sums.sections.total += finite(r.sections?.total);
      sums.sections.done += finite(r.sections?.done);
    }
    sums.cands.forEach((c) => { c.pct = pctOf(c.votes, sums.votes.valid); });
    sums.votes.pvalid = pctOf(sums.votes.valid, sums.votes.total);
    sums.votes.pblank = pctOf(sums.votes.blank, sums.votes.total);
    sums.votes.pnul = pctOf(sums.votes.nul, sums.votes.total);
    sums.electorate.ppresent = pctOf(sums.electorate.present, sums.electorate.total);
    sums.electorate.pabst = pctOf(sums.electorate.abst, sums.electorate.total);
    sums.sections.pct = pctOf(sums.sections.done, sums.sections.total);
    return sums;
  }
  function progressBar(result, role, uf) {
    const profiles = candidateProfiles(result, role, uf).slice(0, 2);
    const shares = profiles.map((c) => candidateShare(c, result));
    return `<div class="pos-duel-bar" role="img" aria-label="${esc(profiles.map((c, i) => `${c.displayName}: ${fmtPct(shares[i] || 0)}%`).join('; '))}">${profiles.map((c, i) => `<span style="width:${Math.max(0, Math.min(100, shares[i] || 0))}%;background:${esc(c.color)}" title="${esc(c.displayName)} ${fmtPct(shares[i] || 0)}%"></span>`).join('')}</div>`;
  }
  function resultCardBody(result, role, uf) {
    const checked = validDatasetOrMessage(result, 'Resultado final');
    if (!checked.ok) return emptyMarkup(checked.message, checked.errors?.join(' '));
    const profiles = candidateProfiles(result, role, uf).slice(0, 2);
    const difference = Math.abs(finite(profiles[0]?.votes) - finite(profiles[1]?.votes));
    const aPct = candidateShare(profiles[0], result);
    const bPct = candidateShare(profiles[1], result);
    const leader = aPct === bPct ? 'Empate percentual' : (aPct > bPct ? profiles[0]?.displayName : profiles[1]?.displayName);
    return `${progressBar(result, role, uf)}<div class="pos-candidate-grid">${profiles.map((c) => `<div class="pos-candidate-stat"><span class="pos-color-key" style="--pos-candidate:${esc(c.color)}"></span><span class="pos-candidate-label">${esc(c.displayName)}</span><strong>${fmtInt(c.votes)}</strong><span>${fmtPct(candidateShare(c, result))}% dos votos válidos</span></div>`).join('')}</div><div class="pos-stat-line"><span>Diferença absoluta</span><strong>${fmtInt(difference)} votos</strong></div><div class="pos-stat-line"><span>Diferença percentual</span><strong>${fmtPct(Math.abs(aPct - bPct))} p.p.</strong></div><p class="pos-card-note">Maior percentual: ${esc(leader)}. Os percentuais dos candidatos usam votos válidos como base.</p>`;
  }
  function compositionCardBody(result) {
    const checked = validDatasetOrMessage(result, 'Composição do eleitorado');
    if (!checked.ok) return emptyMarkup(checked.message, checked.errors?.join(' '));
    const total = finite(result.electorate?.total) || finite(result.votes?.total) + finite(result.electorate?.abst);
    const entries = [
      { label: 'Votos válidos', value: finite(result.votes?.valid), color: 'var(--cand-0)' },
      { label: 'Brancos', value: finite(result.votes?.blank), color: 'var(--muted)' },
      { label: 'Nulos', value: finite(result.votes?.nul), color: 'var(--hairline-strong)' },
      { label: 'Abstenção', value: finite(result.electorate?.abst), color: 'var(--cand-1)' },
    ];
    return `<div class="pos-stack-bar" role="img" aria-label="${esc(entries.map((e) => `${e.label}: ${fmtInt(e.value)} (${fmtPct(pctOf(e.value, total))}%)`).join('; '))}">${entries.map((e) => `<span style="width:${Math.max(0, Math.min(100, pctOf(e.value, total)))}%;background:${e.color}" title="${e.label}: ${fmtPct(pctOf(e.value, total))}%"></span>`).join('')}</div><div class="pos-legend-list">${entries.map((e) => `<div class="pos-legend-row"><span class="pos-legend-dot" style="--pos-candidate:${e.color}"></span><span>${e.label}</span><strong>${fmtInt(e.value)}</strong><small>${fmtPct(pctOf(e.value, total))}%</small></div>`).join('')}</div><p class="pos-card-note">Base dos percentuais: ${fmtInt(total)} eleitores aptos, conforme o snapshot.</p>`;
  }
  function turnoutSingleBody(result) {
    const checked = validDatasetOrMessage(result, 'Comparecimento e abstenção');
    if (!checked.ok) return emptyMarkup(checked.message, checked.errors?.join(' '));
    const total = finite(result.electorate?.total);
    const present = finite(result.electorate?.present);
    const abst = finite(result.electorate?.abst);
    if (!(total > 0)) return emptyMarkup('O total do eleitorado não está disponível para calcular os percentuais.');
    const entries = [
      { label: 'Comparecimento', value: present, pct: finite(result.electorate?.ppresent) || pctOf(present, total), color: 'var(--cand-0)' },
      { label: 'Abstenção', value: abst, pct: finite(result.electorate?.pabst) || pctOf(abst, total), color: 'var(--cand-1)' },
    ];
    return `<div class="pos-stack-bar" role="img" aria-label="${esc(entries.map((e) => `${e.label}: ${fmtInt(e.value)} (${fmtPct(e.pct)}%)`).join('; '))}">${entries.map((e) => `<span style="width:${Math.max(0, Math.min(100, e.pct))}%;background:${e.color}" title="${e.label}: ${fmtPct(e.pct)}%"></span>`).join('')}</div><div class="pos-legend-list">${entries.map((e) => `<div class="pos-legend-row"><span class="pos-legend-dot" style="--pos-candidate:${e.color}"></span><span>${e.label}</span><strong>${fmtInt(e.value)}</strong><small>${fmtPct(e.pct)}%</small></div>`).join('')}</div><p class="pos-card-note">Base: ${fmtInt(total)} eleitores aptos. Percentuais apresentados conforme o snapshot ou calculados a partir dos números absolutos.</p>`;
  }
  function stateRankingBody(snapshot) {
    const states = Object.entries(snapshot?.states || {}).filter(([uf, result]) => uf !== 'zz' && result?.cands?.length >= 2 && validDatasetOrMessage(result).ok);
    if (!states.length) return emptyMarkup('O snapshot ainda não contém resultados por UF.');
    const ordered = states.map(([uf, result]) => {
      const margin = resultMargin(result);
      const profiles = candidateProfiles(result, 'pres', uf);
      const winner = margin.leaderIndex >= 0 ? profiles[margin.leaderIndex] : null;
      return { uf, name: STATE_NAMES[uf] || uf.toUpperCase(), margin: margin.margin, winner, tie: margin.tie, result };
    }).sort((a, b) => b.margin - a.margin);
    const countA = ordered.filter((s) => !s.tie && s.winner?.idx === 0).length;
    const countB = ordered.filter((s) => !s.tie && s.winner?.idx === 1).length;
    return `<p class="pos-card-note">Estados por candidato: ${countA} × ${countB}; empates técnicos (abaixo de 0,50 p.p.): ${ordered.filter((s) => s.tie).length}.</p><div class="pos-ranking">${ordered.map((s) => `<div class="pos-ranking-row"><span class="pos-ranking-place">${s.uf.toUpperCase()}</span><span class="pos-ranking-label">${esc(s.name)}<small>${s.tie ? 'Empate técnico' : esc(s.winner?.displayName || 'Sem vencedor')}</small></span><span class="pos-rank-track"><i style="width:${Math.max(0, Math.min(100, s.margin * 2))}%;background:${esc(s.tie ? 'var(--muted)' : s.winner?.color || 'var(--muted)')}"></i></span><strong>${fmtPct(s.margin)} p.p.</strong></div>`).join('')}</div>`;
  }
  function regionalBody(snapshot) {
    const states = snapshot?.states || {};
    const regions = Object.entries(REGIONS).map(([name, ufs]) => {
      const result = sumResults(ufs.map((uf) => states[uf]).filter((row) => row && validDatasetOrMessage(row).ok));
      return { name, result };
    }).filter((r) => r.result);
    if (!regions.length) return emptyMarkup('Os resultados por região ainda não estão disponíveis.');
    return `<div class="pos-region-list">${regions.map(({ name, result }) => {
      const profiles = candidateProfiles(result, 'pres', null).slice(0, 2);
      return `<div class="pos-region-row"><div class="pos-region-title"><strong>${esc(name)}</strong><span>${fmtInt(result.votes.valid)} válidos</span></div>${profiles.map((c) => `<div class="pos-region-candidate"><span>${esc(c.displayName)}</span><div class="pos-region-track"><i style="width:${Math.max(0, Math.min(100, candidateShare(c, result)))}%;background:${esc(c.color)}"></i></div><strong>${fmtPct(candidateShare(c, result))}%</strong></div>`).join('')}</div>`;
    }).join('')}</div><p class="pos-card-note">Totais regionais agregados a partir dos snapshots estaduais disponíveis. Regiões com estados ausentes podem estar incompletas.</p>`;
  }
  function turnoutBody(snapshot) {
    const states = Object.entries(snapshot?.states || {}).filter(([, result]) => finite(result?.electorate?.total) > 0 && validDatasetOrMessage(result).ok);
    if (!states.length) return emptyMarkup('Comparecimento e abstenção por UF não disponíveis.');
    return `<div class="pos-table-wrap"><table class="pos-table"><thead><tr><th>UF</th><th>Comparecimento</th><th>Abstenção</th></tr></thead><tbody>${states.sort((a, b) => pctOf(b[1].electorate?.abst, b[1].electorate?.total) - pctOf(a[1].electorate?.abst, a[1].electorate?.total)).map(([uf, result]) => `<tr><th>${uf.toUpperCase()} · ${esc(STATE_NAMES[uf] || uf)}</th><td>${fmtInt(result.electorate?.present)} <small>${fmtPct(result.electorate?.ppresent || pctOf(result.electorate?.present, result.electorate?.total))}%</small></td><td>${fmtInt(result.electorate?.abst)} <small>${fmtPct(result.electorate?.pabst || pctOf(result.electorate?.abst, result.electorate?.total))}%</small></td></tr>`).join('')}</tbody></table></div>`;
  }
  function municipalitySummaryBody(snapshot) {
    const sourceRows = Array.isArray(snapshot?.municipalities)
      ? snapshot.municipalities
      : Object.values(snapshot?.municipalities || {}).flatMap((entry) => Array.isArray(entry?.municipalities) ? entry.municipalities : []);
    const rows = sourceRows.filter((row) => row?.final === true && validateResult(row).ok && finite(row.votes?.valid) > 0);
    if (!rows.length) return emptyMarkup('Resultados por município ainda não foram gerados ou validados.', 'A malha do IBGE e a correspondência TSE ↔ IBGE são pré-requisitos; só são exibidos registros finais com totais conferidos.');
    const byCandidate = [0, 0];
    let tieCount = 0;
    const margins = [];
    for (const row of rows) {
      const profiles = (row.cands || []).slice(0, 2);
      if (profiles.length < 2) continue;
      const a = finite(profiles[0].pct) || pctOf(profiles[0].votes, row.votes?.valid);
      const b = finite(profiles[1].pct) || pctOf(profiles[1].votes, row.votes?.valid);
      const margin = Math.abs(a - b);
      if (margin < 0.5) tieCount++;
      else byCandidate[a > b ? 0 : 1]++;
      margins.push({ name: row.name || `Município ${row.ibgeCode || ''}`, margin, diff: Math.abs(finite(profiles[0].votes) - finite(profiles[1].votes)) });
    }
    const top = margins.sort((a, b) => a.diff - b.diff || a.margin - b.margin).slice(0, 10);
    return `<p class="pos-card-note">Municípios com resultado final validado: ${fmtInt(rows.length)}${snapshot?.complete === false ? ` · resumo parcial: ${fmtInt(snapshot.statesReceived || 0)} de ${fmtInt(snapshot.statesExpected || 27)} UFs com dados` : ''} · vitórias por candidato na ordem dos arquivos: ${fmtInt(byCandidate[0])} × ${fmtInt(byCandidate[1])} · margens apertadas (abaixo de 0,50 p.p.): ${fmtInt(tieCount)}.</p><div class="pos-table-wrap"><table class="pos-table"><thead><tr><th>10 municípios com menor diferença em votos</th><th>Diferença em votos</th><th>Margem</th></tr></thead><tbody>${top.map((r) => `<tr><th>${esc(r.name)}</th><td>${fmtInt(r.diff)}</td><td>${fmtPct(r.margin)} p.p.</td></tr>`).join('')}</tbody></table></div>`;
  }
  function hourlyBody() {
    const check = validateHoursDataset(hoursData);
    if (!check.ok) return emptyMarkup('A série horária importada não passou na validação.', check.errors.join(' '));
    if (!check.points.length) return `<div class="pos-empty" role="status"><span class="pos-empty-mark" aria-hidden="true">—</span><p>Histórico de totalização ainda não disponível.</p><small>O painel ao vivo não guardou snapshots anteriores. Importe um JSON com pontos reais; nenhum dado será inventado.</small></div>`;
    if (hoursData.semantics === 'votacao' && !hoursData.officialSource) return emptyMarkup('A fonte para horário da votação não está identificada. A série foi ocultada.');
    const activity = deriveHourlyActivity(hoursData, HOUR_BUCKET_CONFIG);
    if (check.points.length < 2) return emptyMarkup('Há apenas um ponto: ele serve como linha de base e não permite calcular quantos votos entraram por faixa horária.');
    const buckets = activity.buckets || [];
    const maximum = Math.max(1, ...buckets.map((b) => b.votesA + b.votesB + b.brancos + b.nulos));
    const total = buckets.reduce((sum, b) => sum + b.votesA + b.votesB + b.brancos + b.nulos, 0);
    const special = activity.special || { votesA: 0, votesB: 0, brancos: 0, nulos: 0 };
    const specialTotal = special.votesA + special.votesB + special.brancos + special.nulos;
    const hourRole = hoursData.role === 'gov' && GOV_UFS.includes(normalizeUf(hoursData.uf)) ? 'gov' : 'pres';
    const hourUf = hourRole === 'gov' ? normalizeUf(hoursData.uf) : null;
    const configuredHourCandidates = hourRole === 'gov' ? (GOV_CANDIDATES[hourUf] || []).slice(0, 2) : [{ n: '13', name: 'Lula' }, { n: '22', name: 'Flávio Bolsonaro' }];
    const profiles = candidateProfiles({ cands: configuredHourCandidates.map((c) => ({ n: c.n, name: c.name, party: c.party })) }, hourRole, hourUf || selectedGovUf).slice(0, 2);
    const windowVerificationNote = hoursData.window?.officiallyVerified ? '' : `A janela ${HOUR_WINDOW_LABEL} foi informada no pedido e ainda não está confirmada por fonte oficial neste pacote.`;
    return `<p class="pos-card-note">Leitura: ${hoursData.semantics === 'votacao' ? 'horário em que o eleitor votou' : 'votos apurados/divulgados em cada intervalo'} · fuso de referência: horário de Brasília (America/Sao_Paulo). ${windowVerificationNote}</p><div class="pos-highlight-window"><div><span>Janela destacada · ${HOUR_WINDOW_LABEL}</span><strong>${fmtInt(specialTotal)} votos</strong><small>${fmtPct(pctOf(specialTotal, total))}% dos votos contabilizados nesta série</small></div><div><span>${esc(profiles[0]?.displayName || 'Candidato A')}</span><strong>${fmtInt(special.votesA)}</strong><small>${fmtPct(pctOf(special.votesA, special.votesA + special.votesB))}% dos dois candidatos</small></div><div><span>${esc(profiles[1]?.displayName || 'Candidato B')}</span><strong>${fmtInt(special.votesB)}</strong><small>${fmtPct(pctOf(special.votesB, special.votesA + special.votesB))}% dos dois candidatos</small></div></div><div class="pos-hour-bars" role="img" aria-label="Votos apurados por intervalo horário">${buckets.map((b) => { const sum = b.votesA + b.votesB + b.brancos + b.nulos; const isSpecial = b.id === '17to18' || b.id === '18to19'; return `<div class="pos-hour-col ${isSpecial ? 'is-special' : ''}"><div class="pos-hour-column"><i style="height:${Math.max(1, sum / maximum * 100)}%" title="${fmtInt(sum)} votos"></i></div><strong>${fmtInt(sum)}</strong><span>${esc(b.label)}</span><small>${fmtPct(pctOf(sum, total))}%</small></div>`; }).join('')}</div><details class="pos-series-details"><summary>Ver valores exatos por faixa</summary><div class="pos-table-wrap"><table class="pos-table"><thead><tr><th>Faixa horária</th><th>Candidato A</th><th>Candidato B</th><th>Brancos</th><th>Nulos</th><th>Total</th><th>% da série</th></tr></thead><tbody>${buckets.map((b) => { const sum = b.votesA + b.votesB + b.brancos + b.nulos; return `<tr><th>${esc(b.label)}</th><td>${fmtInt(b.votesA)}</td><td>${fmtInt(b.votesB)}</td><td>${fmtInt(b.brancos)}</td><td>${fmtInt(b.nulos)}</td><td>${fmtInt(sum)}</td><td>${fmtPct(pctOf(sum, total))}%</td></tr>`; }).join('')}</tbody></table></div></details><section class="pos-hour-detail pos-hourly-fine"><h4>Visão hora a hora</h4>${hourlyBarsMarkup(activity.hourly)}</section><div class="pos-hour-detail-grid"><section class="pos-hour-detail"><h4>Evolução acumulada dos votos</h4>${timelineSvg(activity.timeline, profiles)}<p class="pos-card-note">Contagem acumulada nos snapshots recebidos.</p></section><section class="pos-hour-detail"><h4>Ritmo estimado por 10 minutos</h4>${rhythmMarkup(activity.intervals)}</section><section class="pos-hour-detail"><h4>Seções apuradas ao longo do tempo</h4>${metricTimelineSvg(activity.timeline, 'secoesApuradas', 'Seções apuradas', 'var(--ink-2)')}</section><section class="pos-hour-detail"><h4>Margem entre candidatos ao longo do tempo</h4>${metricTimelineSvg(activity.timeline, 'marginPP', 'Margem percentual (A − B)', 'var(--cand-0)', true)}</section></div><details class="pos-series-details"><summary>Ver tabela com os números exatos da série</summary><div class="pos-table-wrap"><table class="pos-table"><thead><tr><th>Horário (Brasília)</th><th>Seções</th><th>Candidato A</th><th>Candidato B</th><th>Total observado</th><th>Margem A − B</th></tr></thead><tbody>${activity.timeline.map((p) => `<tr><th>${esc(new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Sao_Paulo' }).format(new Date(p.at)))}</th><td>${fmtInt(p.secoesApuradas)}</td><td>${fmtInt(p.votosA)}</td><td>${fmtInt(p.votosB)}</td><td>${fmtInt(p.total)}</td><td>${fmtPct(p.marginPP)} p.p.</td></tr>`).join('')}</tbody></table></div></details><section class="pos-hour-detail pos-hour-leaders"><h4>Quem liderou em cada faixa</h4><div class="pos-hour-leader-list">${buckets.map((b) => { const margin = Math.abs(pctOf(b.votesA, b.votesA + b.votesB) - pctOf(b.votesB, b.votesA + b.votesB)); const leader = b.votesA === b.votesB ? 'Empate' : b.votesA > b.votesB ? profiles[0]?.displayName : profiles[1]?.displayName; return `<div><span>${esc(b.label)}</span><strong>${esc(leader || 'Sem dados')}</strong><small>Margem ${fmtPct(margin)} p.p.</small></div>`; }).join('')}</div></section>${activity.errors?.length ? `<p class="pos-warning">${esc(activity.errors.join(' '))}</p>` : ''}<p class="pos-card-note">O primeiro ponto foi usado como referência e não conta como votos novos. As faixas refletem o horário dos snapshots recebidos, não o momento em que cada eleitor votou.</p>`;
  }
  function timelineSvg(points, profiles) {
    if (!Array.isArray(points) || points.length < 2) return emptyMarkup('A série precisa de pelo menos dois snapshots para mostrar uma evolução.');
    const width = 640, height = 170, pad = 18;
    const max = Math.max(1, ...points.map((p) => p.total));
    const x = (i) => pad + (width - pad * 2) * i / (points.length - 1);
    const y = (value) => height - pad - (height - pad * 2) * finite(value) / max;
    const poly = (key) => points.map((p, i) => `${x(i).toFixed(1)},${y(p[key]).toFixed(1)}`).join(' ');
    const aColor = profiles[0]?.color || 'var(--cand-0)'; const bColor = profiles[1]?.color || 'var(--cand-1)';
    const totalPoints = points.map((p, i) => `${x(i).toFixed(1)},${y(p.total).toFixed(1)}`).join(' ');
    return `<svg class="pos-hour-line-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Evolução acumulada de votos dos candidatos e total nos snapshots horários"><path d="M${pad} ${pad}V${height - pad}H${width - pad}" fill="none" stroke="var(--hairline-strong)" stroke-width="1"/><polyline points="${totalPoints}" fill="none" stroke="var(--muted)" stroke-width="2" stroke-dasharray="5 5"/><polyline points="${poly("votosA")}" fill="none" stroke="${esc(aColor)}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><polyline points="${poly("votosB")}" fill="none" stroke="${esc(bColor)}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg><div class="pos-line-legend"><span><i style="background:${esc(aColor)}"></i>${esc(profiles[0]?.displayName || 'Candidato A')}</span><span><i style="background:${esc(bColor)}"></i>${esc(profiles[1]?.displayName || 'Candidato B')}</span><span><i style="background:var(--muted)"></i>Total observado</span></div><div class="pos-line-times"><span>${esc(new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' }).format(new Date(points[0].at)))}</span><span>${esc(new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' }).format(new Date(points.at(-1).at)))}</span></div>`;
  }
  function rhythmMarkup(intervals) {
    const rows = (intervals || []).filter((x) => x.elapsedMinutes > 0).slice(-12);
    if (!rows.length) return emptyMarkup('Intervalos insuficientes para calcular ritmo.');
    const max = Math.max(1, ...rows.map((x) => x.per10Min));
    return `<div class="pos-rhythm-list">${rows.map((r) => `<div class="pos-rhythm-row"><span>${esc(new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' }).format(new Date(r.at)))}</span><div><i style="width:${Math.max(1, Math.min(100, r.per10Min / max * 100))}%"></i></div><strong>${fmtInt(r.per10Min)}</strong></div>`).join('')}</div><p class="pos-card-note">Estimativa: diferença entre snapshots dividida pelo tempo decorrido, convertida para votos por 10 minutos. Intervalos com contagem regressiva são ignorados.</p>`;
  }
  function hourlyBarsMarkup(buckets) {
    const rows = Array.isArray(buckets) ? buckets : [];
    if (!rows.length) return emptyMarkup('Não há intervalos suficientes para visão hora a hora.');
    const totals = rows.map((row) => row.votesA + row.votesB + row.brancos + row.nulos);
    const maximum = Math.max(1, ...totals);
    const total = totals.reduce((sum, value) => sum + value, 0);
    return `<div class="pos-hourly-bars" role="img" aria-label="Votos apurados por hora, com intervalos da janela destacada realçados">${rows.map((row, index) => { const sum = totals[index]; return `<div class="pos-hour-col ${row.special ? 'is-special' : ''}"><div class="pos-hour-column"><i style="height:${Math.max(1, sum / maximum * 100)}%" title="${fmtInt(sum)} votos"></i></div><strong>${fmtInt(sum)}</strong><span>${esc(row.label)}</span><small>${fmtPct(pctOf(sum, total))}%</small></div>`; }).join('')}</div>`;
  }
  function metricTimelineSvg(points, key, label, color, signed = false) {
    if (!Array.isArray(points) || points.length < 2) return emptyMarkup('A série precisa de pelo menos dois snapshots.');
    const values = points.map((point) => finite(point[key]));
    const min = signed ? Math.min(0, ...values) : 0;
    const max = Math.max(1, ...values);
    const width = 640, height = 170, pad = 18;
    const x = (i) => pad + (width - pad * 2) * i / (points.length - 1);
    const y = (value) => height - pad - (height - pad * 2) * (value - min) / Math.max(1, max - min);
    const poly = values.map((value, index) => `${x(index).toFixed(1)},${y(value).toFixed(1)}`).join(' ');
    const zeroY = signed ? y(0) : height - pad;
    const firstLabel = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' }).format(new Date(points[0].at));
    const lastLabel = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' }).format(new Date(points.at(-1).at));
    return `<svg class="pos-hour-line-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(label)} ao longo dos snapshots"><title>${esc(label)}</title><path d="M${pad} ${pad}V${height - pad}H${width - pad}" fill="none" stroke="var(--hairline-strong)" stroke-width="1"/><path d="M${pad} ${zeroY.toFixed(1)}H${width - pad}" fill="none" stroke="var(--muted)" stroke-width="1" stroke-dasharray="4 4"/><polyline points="${poly}" fill="none" stroke="${esc(color)}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg><div class="pos-line-times"><span>${esc(firstLabel)} · ${fmtPct(values[0])}${signed ? ' p.p.' : ''}</span><span>${esc(lastLabel)} · ${fmtPct(values.at(-1))}${signed ? ' p.p.' : ''}</span></div>`;
  }
  function governorBody(snapshot) {
    const states = Object.entries(snapshot?.states || {});
    if (!states.length) return emptyMarkup('Os resultados finais de governador ainda não foram gerados.');
    return `<div class="pos-governor-grid">${GOV_UFS.map((uf) => {
      const result = snapshot.states?.[uf];
      if (!result) return `<article class="pos-governor-mini"><h4>${uf.toUpperCase()} · ${esc(STATE_NAMES[uf])}</h4>${emptyMarkup('Sem snapshot para esta UF.')}</article>`;
      const check = validDatasetOrMessage(result, `Governador em ${uf.toUpperCase()}`);
      if (!check.ok) return `<article class="pos-governor-mini"><h4>${uf.toUpperCase()} · ${esc(STATE_NAMES[uf])}</h4>${emptyMarkup(check.message)}</article>`;
      const profiles = candidateProfiles(result, 'gov', uf).slice(0, 2);
      const margin = resultMargin(result);
      return `<article class="pos-governor-mini"><h4>${uf.toUpperCase()} · ${esc(STATE_NAMES[uf])}</h4>${progressBar(result, 'gov', uf)}${profiles.map((c) => `<div class="pos-mini-candidate"><span class="pos-color-key" style="--pos-candidate:${esc(c.color)}"></span><span>${esc(c.displayName)}</span><strong>${fmtPct(candidateShare(c, result))}%</strong><small>${fmtInt(c.votes)} votos</small></div>`).join('')}<p class="pos-card-note">Margem: ${fmtPct(margin.margin)} p.p.</p></article>`;
    }).join('')}</div>`;
  }
  function createUI() {
    if ($('#pos-analysis')) return;
    const stage = $('#stage');
    const footer = $('.broadcast-footer');
    if (!stage || !footer) return;
    const launch = document.createElement('button');
    launch.type = 'button';
    launch.id = 'pos-analysis-launch';
    launch.className = 'pos-analysis-launch hide-on-tv';
    launch.textContent = 'Ver análise completa ↓';
    launch.setAttribute('aria-controls', 'pos-analysis');
    launch.addEventListener('click', () => $('#pos-analysis')?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' }));
    $('.stage-head-row')?.append(launch);

    const section = document.createElement('section');
    section.id = 'pos-analysis';
    section.className = 'pos-analysis hide-on-tv';
    section.setAttribute('aria-labelledby', 'pos-analysis-title');
    section.innerHTML = `
      <header class="pos-section-head">
        <div><p class="pos-eyebrow">PÓS-ELEIÇÃO · ANÁLISE DOS RESULTADOS</p><h2 id="pos-analysis-title">Como foi a eleição</h2><p>Uma camada independente de análise. O placar e o mapa por estados acima permanecem separados e inalterados.</p></div>
        <div class="pos-analysis-tools"><label for="pos-role">Cargo</label><select id="pos-role"><option value="pres">Presidente</option><option value="gov">Governadores</option></select><label for="pos-uf" id="pos-uf-label" hidden>UF</label><select id="pos-uf" hidden>${GOV_UFS.map((uf) => `<option value="${uf}">${uf.toUpperCase()} · ${esc(STATE_NAMES[uf])}</option>`).join('')}</select><button type="button" class="pos-primary-btn" id="pos-generate-bulletin">Gerar boletim</button></div>
      </header>
      <div id="pos-source-status" class="pos-source-status" role="status" aria-live="polite">Verificando snapshots locais…</div>
      <div id="pos-analysis-grid" class="pos-analysis-grid"></div>
      <section class="pos-card pos-hours-card" aria-labelledby="pos-hours-title"><header class="pos-card-head"><div><h3 id="pos-hours-title">Votos apurados por horário</h3><p>Não confundir hora de divulgação/totalização com o momento em que a pessoa votou.</p></div><div class="pos-hours-tools"><button type="button" class="pos-secondary-btn" id="pos-import-hours">Importar série JSON</button><button type="button" class="pos-secondary-btn" id="pos-download-hours-template">Baixar modelo</button><input type="file" id="pos-hours-file" accept=".json,application/json" hidden></div></header><div class="pos-card-body" id="pos-hours-content"></div></section>
      <details class="pos-import-guide"><summary>Como preencher a série horária</summary><p>Importe um JSON de snapshots acumulados com <code>schemaVersion: 1</code>, <code>semantics: "totalizacao"</code> e <code>points</code>. Cada ponto deve conter <code>hora</code>, <code>dt</code>, <code>secoesApuradas</code>, <code>votosA</code>, <code>votosB</code>, <code>brancos</code> e <code>nulos</code>. Os dados importados são processados apenas nesta página e não são enviados a servidor algum.</p><p>Para publicar uma série persistente, valide-a com <code>node scripts/build-horarios.js --input seu-arquivo.json</code> e publique o arquivo produzido em <code>public/data/horarios.json</code>.</p></details>
      <p class="pos-disclaimer">Projeto independente, sem vínculo oficial. Os resultados oficiais são os do TSE. A análise depende dos snapshots locais e pode ficar indisponível até que os dados de origem sejam gerados e conferidos.</p>`;
    footer.parentNode.insertBefore(section, footer);
    const fetchMunicipalitySummary = () => {
      if (municipalitySummaryRequested) return;
      municipalitySummaryRequested = true;
      fetchLocalJson('/data/final/municipalities-pres-summary.json').then((data) => {
        if (data && Array.isArray(data.municipalities)) {
          municipalitySummaryData = data;
          if (selectedAnalysisRole === 'pres') renderAnalysis();
        }
      }).catch(() => {});
    };
    if ('IntersectionObserver' in window) {
      const observer = new IntersectionObserver((entries) => {
        if (entries.some((entry) => entry.isIntersecting)) { observer.disconnect(); fetchMunicipalitySummary(); }
      }, { rootMargin: '350px 0px' });
      observer.observe(section);
    } else fetchMunicipalitySummary();

    const modal = document.createElement('div');
    modal.id = 'pos-bulletin-modal';
    modal.className = 'pos-modal-backdrop';
    modal.hidden = true;
    modal.innerHTML = `<section class="pos-modal" role="dialog" aria-modal="true" aria-labelledby="pos-bulletin-title" tabindex="-1"><header class="pos-modal-head"><div><p class="pos-eyebrow">COMPARTILHAMENTO SOB SEU CONTROLE</p><h2 id="pos-bulletin-title" tabindex="-1">Boletim final</h2></div><button type="button" class="pos-icon-close" id="pos-close-bulletin" aria-label="Fechar boletim">×</button></header><p class="pos-modal-intro">Escolha exatamente o que entra no boletim. Nada será publicado ou enviado automaticamente.</p><div class="pos-bulletin-options"><label><input type="checkbox" data-bulletin-part="final" checked> Resultado final</label><label><input type="checkbox" data-bulletin-part="composition" checked> Válidos, brancos, nulos e abstenção</label><label><input type="checkbox" data-bulletin-part="states"> Vencedor por estado</label><label><input type="checkbox" data-bulletin-part="regions"> Resumo por região</label><label><input type="checkbox" data-bulletin-part="municipalities"> Resumo por município</label><label><input type="checkbox" data-bulletin-part="hours"> Janela horária 17h–19h</label><label><input type="checkbox" data-bulletin-part="governors"> Resultados de governadores</label></div><fieldset id="pos-bulletin-governor-ufs" class="pos-bulletin-ufs" hidden><legend>Quais UFs de governador incluir?</legend>${GOV_UFS.map((uf) => `<label><input type="checkbox" data-bulletin-gov-uf="${uf}" checked> ${uf.toUpperCase()} · ${esc(STATE_NAMES[uf])}</label>`).join('')}</fieldset><div class="pos-bulletin-preview-wrap"><h3>Pré-visualização</h3><pre id="pos-bulletin-preview" class="pos-bulletin-preview"></pre></div><div class="pos-bulletin-actions"><button type="button" class="pos-secondary-btn" id="pos-copy-bulletin">Copiar texto</button><button type="button" class="pos-secondary-btn" id="pos-share-bulletin">Mais opções…</button><a class="pos-secondary-btn pos-share-anchor" id="pos-share-wa" target="_blank" rel="noopener noreferrer">WhatsApp</a><a class="pos-secondary-btn pos-share-anchor" id="pos-share-x" target="_blank" rel="noopener noreferrer">X</a><a class="pos-secondary-btn pos-share-anchor" id="pos-share-fb" target="_blank" rel="noopener noreferrer">Facebook</a><a class="pos-secondary-btn pos-share-anchor" id="pos-share-tg" target="_blank" rel="noopener noreferrer">Telegram</a><button type="button" class="pos-secondary-btn" id="pos-copy-bulletin-link">Copiar link</button><button type="button" class="pos-primary-btn" data-png-size="portrait">Baixar PNG 1080×1350</button><button type="button" class="pos-primary-btn" data-png-size="story">Baixar story 1080×1920</button><button type="button" class="pos-secondary-btn" id="pos-share-bulletin-png">Compartilhar PNG</button></div><p id="pos-bulletin-status" class="pos-status-text" role="status" aria-live="polite"></p><p class="pos-disclaimer">Projeto independente, sem vínculo oficial. O resultado oficial é o do TSE.</p></section>`;
    document.body.append(modal);

    const detailPanel = $('#detail-panel');
    if (detailPanel && !$('#pos-city-trigger')) {
      const trigger = document.createElement('button');
      trigger.type = 'button';
      trigger.className = 'pos-city-trigger';
      trigger.id = 'pos-city-trigger';
      trigger.textContent = 'Ver por cidades';
      trigger.hidden = true;
      trigger.addEventListener('click', () => {
        const route = currentRoute();
        const uf = normalizeUf($('#detail-uf-code')?.textContent);
        if (STATE_NAMES[uf] && uf !== 'zz') openMunicipalView(route.role, route.role === 'gov' ? (GOV_UFS.includes(uf) ? uf : selectedGovUf) : uf);
      });
      const popBody = $('.popover-body', detailPanel);
      if (popBody) popBody.insertAdjacentElement('afterend', trigger);
    }
    createMunicipalOverlay();
    bindUI();
  }
  function createMunicipalOverlay() {
    const mapStage = $('#map-viewport');
    if (!mapStage || $('#pos-municipal-overlay')) return;
    const overlay = document.createElement('section');
    overlay.id = 'pos-municipal-overlay';
    overlay.className = 'pos-municipal-overlay';
    overlay.hidden = true;
    overlay.setAttribute('aria-labelledby', 'pos-municipal-title');
    overlay.innerHTML = `<header class="pos-municipal-head"><div><p class="pos-eyebrow">VISTA MUNICIPAL · CAMADA PÓS-ELEIÇÃO</p><h2 id="pos-municipal-title">Municípios</h2><p id="pos-municipal-subtitle">Geometria e resultados locais, quando disponíveis.</p></div><button type="button" class="pos-secondary-btn" id="pos-back-state">Voltar ao estado</button></header><div class="pos-municipal-toolbar"><label class="pos-city-search-label" for="pos-city-search">Buscar município</label><input id="pos-city-search" type="search" autocomplete="off" placeholder="Digite o nome da cidade…"><label for="pos-city-sort">Ordenar</label><select id="pos-city-sort"><option value="name">Nome</option><option value="votes">Votos</option><option value="margin">Margem</option><option value="pctA">% candidato A</option><option value="pctB">% candidato B</option></select><div class="pos-zoom-controls"><button type="button" id="pos-zoom-in" aria-label="Ampliar mapa">+</button><button type="button" id="pos-zoom-out" aria-label="Reduzir mapa">−</button><button type="button" id="pos-zoom-reset">Repor zoom</button></div></div><div class="pos-municipal-content"><div class="pos-municipal-map-wrap"><svg id="pos-municipal-map" viewBox="0 0 640 640" role="group" aria-label="Mapa municipal. Use Tab e Enter para selecionar um município."><g id="pos-municipal-map-geometry"></g></svg><div id="pos-municipal-tooltip" class="pos-municipal-tooltip" role="status" aria-live="polite"></div></div><aside class="pos-municipal-detail" id="pos-municipal-detail" aria-live="polite">Selecione um município no mapa ou na lista.</aside></div><div class="pos-municipal-list-head"><h3>Municípios do estado</h3><span id="pos-municipal-count">—</span></div><div id="pos-municipal-ranking" class="pos-municipal-ranking"></div><p id="pos-municipal-status" class="pos-card-note" role="status" aria-live="polite"></p></section>`;
    mapStage.append(overlay);
  }
  function bindUI() {
    $('#tab-pres')?.addEventListener('click', () => { selectedAnalysisRole = 'pres'; renderAnalysis(); }, { capture: true });
    $('#tab-gov')?.addEventListener('click', () => { selectedAnalysisRole = 'gov'; if (GOV_UFS.includes(currentRoute().uf)) selectedGovUf = currentRoute().uf; renderAnalysis(); }, { capture: true });
    $('#gov-uf-chips')?.addEventListener('click', (event) => { const chip = event.target.closest('button[data-gov-uf]'); if (chip) { selectedAnalysisRole = 'gov'; if (GOV_UFS.includes(chip.dataset.govUf)) selectedGovUf = chip.dataset.govUf; renderAnalysis(); } }, { capture: true });
    $('#pos-role')?.addEventListener('change', (event) => {
      selectedAnalysisRole = event.target.value === 'gov' ? 'gov' : 'pres';
      if (selectedAnalysisRole === 'gov') selectedGovUf = GOV_UFS.includes(currentRoute().uf) ? currentRoute().uf : selectedGovUf;
      renderAnalysis();
    });
    $('#pos-uf')?.addEventListener('change', (event) => { selectedGovUf = GOV_UFS.includes(event.target.value) ? event.target.value : 'ac'; renderAnalysis(); });
    $('#pos-analysis-grid')?.addEventListener('click', async (event) => {
      const button = event.target.closest('[data-pos-share-card]');
      if (!button) return;
      const target = button.closest('.pos-card');
      const title = target?.querySelector('h3')?.textContent?.trim() || 'Análise da eleição';
      const body = target?.querySelector('.pos-card-body')?.innerText?.trim() || 'Os dados detalhados estão disponíveis no painel.';
      const text = `${title}\n\n${body}\n\nProjeto independente. Resultado oficial: TSE. ${location.href}`;
      const status = target?.querySelector('.pos-card-share-status');
      try {
        if (navigator.share) {
          await navigator.share({ title, text, url: location.href });
          if (status) status.textContent = 'Menu de compartilhamento aberto.';
        } else {
          const copied = await copyText(text);
          if (status) status.textContent = copied ? 'Conteúdo copiado para compartilhar.' : 'Selecione o conteúdo do gráfico e copie manualmente.';
        }
      } catch (error) {
        if (status) status.textContent = error?.name === 'AbortError' ? 'Compartilhamento cancelado.' : 'Compartilhamento indisponível neste navegador.';
      }
    });
    $('#pos-generate-bulletin')?.addEventListener('click', openBulletin);
    $('#pos-close-bulletin')?.addEventListener('click', closeBulletin);
    $('#pos-bulletin-modal')?.addEventListener('click', (event) => { if (event.target.id === 'pos-bulletin-modal') closeBulletin(); });
    $('#pos-bulletin-modal')?.addEventListener('change', (event) => {
      const selectedUf = event.target.dataset.bulletinGovUf;
      if (selectedUf) {
        if (event.target.checked) selectedBulletinGovUfs.add(selectedUf);
        else selectedBulletinGovUfs.delete(selectedUf);
        renderBulletinPreview();
        return;
      }
      const key = event.target.dataset.bulletinPart;
      if (!key) return;
      bulletinSelections[key] = Boolean(event.target.checked);
      if (key === 'governors') { const controls = $('#pos-bulletin-governor-ufs'); if (controls) controls.hidden = !event.target.checked; }
      renderBulletinPreview();
    });
    $('#pos-copy-bulletin')?.addEventListener('click', async () => { const ok = await copyText(buildBulletinText()); setBulletinStatus(ok ? 'Texto copiado.' : 'Não foi possível copiar automaticamente. Selecione o texto da pré-visualização e copie.'); });
    $('#pos-copy-bulletin-link')?.addEventListener('click', async () => { const url = bulletinUrl(); const ok = await copyText(url); setBulletinStatus(ok ? 'Link do boletim copiado.' : url); });
    $('#pos-share-bulletin')?.addEventListener('click', shareBulletinText);
    $('#pos-share-bulletin-png')?.addEventListener('click', shareBulletinPng);
    $$('[data-png-size]').forEach((button) => button.addEventListener('click', () => downloadBulletinPng(button.dataset.pngSize)));
    $('#pos-import-hours')?.addEventListener('click', () => $('#pos-hours-file')?.click());
    $('#pos-hours-file')?.addEventListener('change', importHoursFile);
    $('#pos-download-hours-template')?.addEventListener('click', downloadHoursTemplate);
    $('#pos-city-search')?.addEventListener('input', renderMunicipalRanking);
    $('#pos-city-sort')?.addEventListener('change', renderMunicipalRanking);
    $('#pos-municipal-ranking')?.addEventListener('click', (event) => { const button = event.target.closest('[data-city-select]'); if (button) selectMunicipality(button.dataset.citySelect, true); });
    $('#pos-back-state')?.addEventListener('click', closeMunicipalView);
    $('#pos-zoom-in')?.addEventListener('click', () => setMunicipalZoom(1.3));
    $('#pos-zoom-out')?.addEventListener('click', () => setMunicipalZoom(1 / 1.3));
    $('#pos-zoom-reset')?.addEventListener('click', resetMunicipalZoom);
    $('#pos-municipal-map')?.addEventListener('click', onMunicipalMapClick);
    $('#pos-municipal-map')?.addEventListener('pointerdown', onMunicipalPointerDown);
    $('#pos-municipal-map')?.addEventListener('pointermove', onMunicipalPointerMove);
    $('#pos-municipal-map')?.addEventListener('pointerup', onMunicipalPointerUp);
    $('#pos-municipal-map')?.addEventListener('pointercancel', onMunicipalPointerUp);
    $('#pos-municipal-map')?.addEventListener('pointerleave', hideMunicipalTooltip);
    $('#pos-municipal-map')?.addEventListener('focusin', onMunicipalMapFocus);
    $('#pos-municipal-map')?.addEventListener('keydown', onMunicipalMapKeydown);
    $('#pos-municipal-map')?.addEventListener('wheel', onMunicipalWheel, { passive: false });
    $('#pos-municipal-map')?.addEventListener('pointerover', onMunicipalPointerOver);
    $('#detail-panel')?.addEventListener('transitionend', updateCityTrigger);
    const detailObserver = new MutationObserver(updateCityTrigger);
    if ($('#detail-panel')) detailObserver.observe($('#detail-panel'), { attributes: true, attributeFilter: ['hidden', 'class'] });
    const codeObserver = new MutationObserver(updateCityTrigger);
    if ($('#detail-uf-code')) codeObserver.observe($('#detail-uf-code'), { childList: true, characterData: true, subtree: true });
    window.addEventListener('hashchange', () => { syncRouteSelection(); updateCityTrigger(); });
    window.addEventListener('popstate', () => {
      if (!new URLSearchParams(location.search).has('pos-cidades')) hideMunicipalOverlay(false);
      syncRouteSelection(); updateCityTrigger();
      if (new URLSearchParams(location.search).get('pos') === 'boletim') openBulletin();
      else if ($('#pos-bulletin-modal') && !$('#pos-bulletin-modal').hidden) closeBulletin(false);
    });
    window.addEventListener('keydown', (event) => {
      const modal = $('#pos-bulletin-modal');
      if (event.key === 'Tab' && modal && !modal.hidden) {
        const focusables = $$('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])', modal).filter((el) => !el.hidden && el.getClientRects().length);
        if (focusables.length) {
          const first = focusables[0], last = focusables[focusables.length - 1];
          if (event.shiftKey && (document.activeElement === first || document.activeElement === modal || document.activeElement === $('#pos-bulletin-title'))) { event.preventDefault(); last.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
        }
      }
      if (event.key === 'Escape' && !$('#pos-bulletin-modal')?.hidden) closeBulletin();
      if (event.key === 'Escape' && !$('#pos-municipal-overlay')?.hidden) closeMunicipalView();
    });
    if (new URLSearchParams(location.search).get('pos') === 'boletim') openBulletin(false);
    if (new URLSearchParams(location.search).has('pos-cidades')) {
      const route = currentRoute();
      const uf = normalizeUf(new URLSearchParams(location.search).get('pos-cidades')) || route.uf;
      if (STATE_NAMES[uf] && uf !== 'zz') openMunicipalView(route.role, uf, false);
    }
  }
  function updateCityTrigger() {
    const trigger = $('#pos-city-trigger');
    const code = normalizeUf($('#detail-uf-code')?.textContent);
    const route = currentRoute();
    if (!trigger) return;
    const visible = $('#detail-panel') && !$('#detail-panel').hidden && code && code !== 'zz' && STATE_NAMES[code] && (route.role === 'pres' || GOV_UFS.includes(code));
    trigger.hidden = !visible;
  }
  function syncRouteSelection() {
    const route = currentRoute();
    if (route.role === 'gov') {
      selectedAnalysisRole = 'gov';
      if (GOV_UFS.includes(route.uf)) selectedGovUf = route.uf;
    } else selectedAnalysisRole = 'pres';
    renderAnalysis();
  }
  async function fetchLocalJson(path) {
    try {
      const response = await fetch(path, { cache: 'no-cache', credentials: 'same-origin' });
      if (!response.ok) return null;
      return await response.json();
    } catch { return null; }
  }
  async function loadAnalysisData() {
    const [manifest, president, governor, hours, mapping] = await Promise.all([
      fetchLocalJson('/data/final/manifest.json'), fetchLocalJson('/data/final/pres.json'), fetchLocalJson('/data/final/gov.json'),
      fetchLocalJson('/data/horarios.json'), fetchLocalJson('/data/municipios-map.json'),
    ]);
    snapshotManifest = manifest;
    // Nunca mostrar resultados parciais como finais: exige manifesto presente, pronto e completo.
    const snapshotsBlocked = !manifest || manifest.ready !== true || manifest.complete !== true;
    presidentSnapshot = snapshotsBlocked ? null : president;
    governorSnapshot = snapshotsBlocked ? null : governor;
    if (hours && validateHoursDataset(hours).ok) hoursData = hours;
    municipalMappings = mapping;
    const status = $('#pos-source-status');
    if (status) {
      if (manifest?.ready && manifest?.complete) status.textContent = `Snapshot local disponível · gerado em ${manifest.generatedAt || 'data não informada'} · fonte declarada: ${manifest.source || 'TSE'}.`;
      else if (president || governor) status.textContent = 'Há snapshots locais, mas o manifesto não confirma que todos os dados estejam completos. Cada gráfico valida seus números antes de exibi-los.';
      else status.textContent = 'Dados finais ainda não gerados. A interface está pronta, mas não mostrará resultados inventados. Gere snapshots oficiais para habilitar gráficos e boletins com números.';
    }
    renderAnalysis();
  }
  function renderAnalysis() {
    const role = selectedAnalysisRole;
    const roleSelector = $('#pos-role');
    const ufSelector = $('#pos-uf');
    const ufLabel = $('#pos-uf-label');
    if (roleSelector) roleSelector.value = role;
    if (ufSelector) { ufSelector.hidden = role !== 'gov'; ufSelector.value = selectedGovUf; }
    if (ufLabel) ufLabel.hidden = role !== 'gov';
    const grid = $('#pos-analysis-grid');
    if (!grid) return;
    if (role === 'gov') {
      const result = activeResult('gov', selectedGovUf);
      const snapshot = governorSnapshot;
      const validation = validDatasetOrMessage(result, `Governador em ${selectedGovUf.toUpperCase()}`);
      grid.innerHTML = [
        card('Resultado final', validation.ok ? resultCardBody(result, 'gov', selectedGovUf) : emptyMarkup(validation.message, validation.errors?.join(' ')), `${STATE_NAMES[selectedGovUf]} · segundo turno`),
        card('Composição do eleitorado', validation.ok ? compositionCardBody(result) : emptyMarkup(validation.message)),
        card('Disputas estaduais', governorBody(snapshot), 'Ordem fixa dos candidatos por UF'),
        card('Comparecimento e abstenção', validation.ok ? turnoutSingleBody(result) : emptyMarkup(validation.message), 'Para a UF selecionada'),
      ].join('');
    } else {
      const result = activeResult('pres');
      const validation = validDatasetOrMessage(result, 'Presidente');
      const snapshot = presidentSnapshot;
      grid.innerHTML = [
        card('Resultado final', validation.ok ? resultCardBody(result, 'pres') : emptyMarkup(validation.message, validation.errors?.join(' ')), 'Brasil · presidente'),
        card('Composição do eleitorado', validation.ok ? compositionCardBody(result) : emptyMarkup(validation.message)),
        card('Estados por vencedor e margem', snapshot ? stateRankingBody(snapshot) : emptyMarkup('O ranking por UF depende do snapshot final.'), 'Margem em pontos percentuais'),
        card('Resultado por região', snapshot ? regionalBody(snapshot) : emptyMarkup('O resumo regional depende dos resultados por UF.'), 'Agregado a partir dos snapshots estaduais'),
        card('Municípios', municipalitySummaryData ? municipalitySummaryBody(municipalitySummaryData) : emptyMarkup('Resumo municipal ainda não carregado ou não gerado.', 'O arquivo agregado só é consultado quando a seção de análise fica visível; resultados só aparecem quando houver snapshot local.'), 'Vitórias, margens apertadas e municípios decisivos'),
        card('Comparecimento e abstenção por UF', snapshot ? turnoutBody(snapshot) : emptyMarkup('Os dados de eleitorado por UF ainda não estão disponíveis.'), 'Ordenado pela taxa de abstenção'),
      ].join('');
    }
    const hoursTitle = $('#pos-hours-title');
    if (hoursTitle) hoursTitle.textContent = hoursData.semantics === 'votacao' ? 'Votos por horário de votação' : 'Votos apurados por horário';
    const hoursContent = $('#pos-hours-content');
    if (hoursContent) hoursContent.innerHTML = hourlyBody();
    if (municipalContext && !$('#pos-municipal-overlay')?.hidden) renderMunicipalMap();
    renderBulletinPreview();
  }

  // ----- Boletim: gera texto, link e PNG localmente, somente após ação explícita. -----
  function bulletinSections() {
    const sections = [];
    const result = activeResult(selectedAnalysisRole, selectedAnalysisRole === 'gov' ? selectedGovUf : null);
    const roleLabel = selectedAnalysisRole === 'gov' ? `Governador · ${selectedGovUf.toUpperCase()} · ${STATE_NAMES[selectedGovUf]}` : 'Presidente · Brasil';
    const usable = validDatasetOrMessage(result, roleLabel);
    if (bulletinSelections.final) {
      sections.push(`RESULTADO FINAL — ${roleLabel}`);
      if (usable.ok) {
        const profiles = candidateProfiles(result, selectedAnalysisRole, selectedGovUf).slice(0, 2);
        sections.push(...profiles.map((c) => `${c.displayName} (${c.party || 'partido não informado'}): ${fmtInt(c.votes)} votos · ${fmtPct(candidateShare(c, result))}% dos votos válidos`));
        sections.push(`Diferença: ${fmtInt(Math.abs(finite(profiles[0]?.votes) - finite(profiles[1]?.votes)))} votos · ${fmtPct(Math.abs(candidateShare(profiles[0], result) - candidateShare(profiles[1], result)))} p.p.`);
      } else sections.push('Dados finais ainda não gerados ou totais não validados.');
    }
    if (bulletinSelections.composition) {
      sections.push('COMPOSIÇÃO DO ELEITORADO');
      if (usable.ok) {
        const total = finite(result.electorate?.total) || finite(result.votes?.total) + finite(result.electorate?.abst);
        const entries = [
          ['Votos válidos', result.votes?.valid], ['Brancos', result.votes?.blank], ['Nulos', result.votes?.nul], ['Comparecimento', result.electorate?.present], ['Abstenção', result.electorate?.abst],
        ];
        sections.push(...entries.map(([label, value]) => `${label}: ${fmtInt(value)} (${fmtPct(pctOf(value, label === 'Abstenção' ? total : total))}%)`));
        sections.push(`Eleitorado considerado: ${fmtInt(total)}.`);
      } else sections.push('Dados de composição indisponíveis ou não validados.');
    }
    const snapshot = activeSnapshot(selectedAnalysisRole);
    if (bulletinSelections.states) {
      sections.push('VENCEDOR POR ESTADO');
      const rows = Object.entries(presidentSnapshot?.states || {}).filter(([uf, r]) => uf !== 'zz' && r?.cands?.length > 1 && validDatasetOrMessage(r).ok);
      if (!rows.length) sections.push('Dados por estado indisponíveis.');
      else sections.push(...rows.map(([uf, r]) => {
        const margin = resultMargin(r); const profiles = candidateProfiles(r, 'pres', uf);
        return `${uf.toUpperCase()} ${STATE_NAMES[uf]}: ${margin.tie ? 'empate técnico' : profiles[margin.leaderIndex]?.displayName} · margem ${fmtPct(margin.margin)} p.p.`;
      }));
    }
    if (bulletinSelections.regions) {
      sections.push('RESULTADO POR REGIÃO');
      const regions = Object.entries(REGIONS).map(([name, ufs]) => ({ name, result: sumResults(ufs.map((uf) => presidentSnapshot?.states?.[uf]).filter((r) => r && validDatasetOrMessage(r).ok)) })).filter((x) => x.result);
      if (!regions.length) sections.push('Dados regionais indisponíveis.');
      else sections.push(...regions.map(({ name, result: r }) => `${name}: ${candidateProfiles(r, 'pres').slice(0, 2).map((c) => `${c.displayName} ${fmtInt(c.votes)} (${fmtPct(candidateShare(c, r))}%)`).join(' · ')}`));
    }
    if (bulletinSelections.municipalities) {
      sections.push('RESUMO POR MUNICÍPIO');
      const rows = Array.isArray(municipalitySummaryData?.municipalities)
        ? municipalitySummaryData.municipalities.filter((row) => row?.final === true && validateResult(row).ok && finite(row.votes?.valid) > 0)
        : [];
      if (!rows.length) sections.push('Resultados municipais não gerados ou não validados; nenhum vencedor foi estimado.');
      else {
        const candidateNames = [CANDIDATES['13']?.name || 'Candidato A', CANDIDATES['22']?.name || 'Candidato B'];
        const wins = [0, 0]; let close = 0;
        const decisive = [];
        for (const row of rows) {
          const a = row.cands?.[0]; const b = row.cands?.[1];
          if (!a || !b) continue;
          const aPct = finite(a.pct) || pctOf(a.votes, row.votes?.valid);
          const bPct = finite(b.pct) || pctOf(b.votes, row.votes?.valid);
          const margin = Math.abs(aPct - bPct); const diff = Math.abs(finite(a.votes) - finite(b.votes));
          if (margin < 0.5) close++;
          else wins[aPct > bPct ? 0 : 1]++;
          decisive.push({ name: row.name || `Município ${row.ibgeCode || ''}`, a, b, aPct, bPct, margin, diff });
        }
        sections.push(`Municípios com resultado final validado: ${fmtInt(rows.length)}${municipalitySummaryData.complete === false ? ' (cobertura parcial)' : ''}.`);
        sections.push(`Vitórias: ${candidateNames[0]} ${fmtInt(wins[0])} · ${candidateNames[1]} ${fmtInt(wins[1])} · margens apertadas (<0,50 p.p.): ${fmtInt(close)}.`);
        sections.push('Municípios mais decisivos por diferença absoluta de votos:');
        sections.push(...decisive.sort((a, b) => a.diff - b.diff || a.margin - b.margin).slice(0, 10).map((row) => `${row.name}: ${row.a.name || candidateNames[0]} ${fmtInt(row.a.votes)} (${fmtPct(row.aPct)}%) × ${row.b.name || candidateNames[1]} ${fmtInt(row.b.votes)} (${fmtPct(row.bPct)}%) · diferença ${fmtInt(row.diff)} votos · margem ${fmtPct(row.margin)} p.p.`));
      }
    }
    if (bulletinSelections.hours) {
      sections.push(`JANELA HORÁRIA ${HOUR_WINDOW_LABEL.toUpperCase()}`);
      const hourly = deriveHourlyActivity(hoursData, HOUR_BUCKET_CONFIG);
      if (hourly.ok && hourly.special) {
        const total = hourly.special.votesA + hourly.special.votesB + hourly.special.brancos + hourly.special.nulos;
        sections.push(`${hoursData.semantics === 'votacao' ? 'Votos registrados na janela de votação' : 'Votos apurados nessa janela nos snapshots disponíveis'}: ${fmtInt(total)} (${fmtPct(pctOf(total, (hourly.buckets || []).reduce((sum, b) => sum + b.votesA + b.votesB + b.brancos + b.nulos, 0)))}% da série contabilizada).`);
        sections.push(`Candidato A: ${fmtInt(hourly.special.votesA)}; candidato B: ${fmtInt(hourly.special.votesB)}.`);
        sections.push(`A janela ${HOUR_WINDOW_LABEL} ainda não está confirmada por fonte oficial neste pacote.`);
      } else sections.push('Série horária real indisponível.');
    }
    if (bulletinSelections.governors) {
      sections.push('GOVERNADORES');
      if (!governorSnapshot?.states) sections.push('Snapshots de governador indisponíveis.');
      else if (!selectedBulletinGovUfs.size) sections.push('Nenhuma UF de governador foi selecionada.');
      else sections.push(...[...selectedBulletinGovUfs].filter((uf) => GOV_UFS.includes(uf)).map((uf) => {
        const r = governorSnapshot.states[uf]; if (!r || !validDatasetOrMessage(r).ok) return `${uf.toUpperCase()}: dados finais não disponíveis/validados.`;
        const ps = candidateProfiles(r, 'gov', uf); const margin = resultMargin(r);
        return `${uf.toUpperCase()} ${STATE_NAMES[uf]}: ${ps[margin.leaderIndex]?.displayName || 'Empate técnico'} · ${ps.map((c) => `${c.displayName} ${fmtPct(candidateShare(c, r))}%`).join(' × ')}`;
      }));
    }
    sections.push('');
    sections.push(`Fonte declarada: Tribunal Superior Eleitoral (TSE). Projeto independente, sem vínculo oficial; o resultado oficial é o do TSE.`);
    sections.push(`Gerado neste dispositivo em ${new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Sao_Paulo' }).format(new Date())} (horário de Brasília).`);
    return sections;
  }
  function buildBulletinText() { return bulletinSections().join('\n'); }
  function renderBulletinPreview() {
    const preview = $('#pos-bulletin-preview');
    if (preview && !$('#pos-bulletin-modal')?.hidden) preview.textContent = buildBulletinText();
    if (!$('#pos-bulletin-modal')?.hidden) {
      const text = buildBulletinText(); const url = bulletinUrl();
      const enc = encodeURIComponent(text); const encUrl = encodeURIComponent(url);
      const links = { wa: `https://wa.me/?text=${enc}%0A${encUrl}`, x: `https://twitter.com/intent/tweet?text=${enc}&url=${encUrl}`, fb: `https://www.facebook.com/sharer/sharer.php?u=${encUrl}`, tg: `https://t.me/share/url?url=${encUrl}&text=${enc}` };
      for (const [key, href] of Object.entries(links)) { const link = $(`#pos-share-${key}`); if (link) link.href = href; }
    }
  }
  function openBulletin(pushState = true) {
    const modal = $('#pos-bulletin-modal');
    if (!modal) return;
    previousFocus = document.activeElement;
    modal.hidden = false;
    const govControls = $('#pos-bulletin-governor-ufs'); if (govControls) govControls.hidden = !bulletinSelections.governors;
    document.body.classList.add('pos-modal-open');
    renderBulletinPreview();
    $('#pos-bulletin-title')?.focus();
    if (pushState && new URLSearchParams(location.search).get('pos') !== 'boletim') {
      const url = new URL(location.href); url.searchParams.set('pos', 'boletim');
      history.pushState({ ...(history.state || {}), posBulletin: true }, '', url);
    }
  }
  function closeBulletin(pop = true) {
    const modal = $('#pos-bulletin-modal');
    if (!modal || modal.hidden) return;
    modal.hidden = true;
    document.body.classList.remove('pos-modal-open');
    if (pop && history.state?.posBulletin) { history.back(); }
    else if (new URLSearchParams(location.search).get('pos') === 'boletim') {
      const url = new URL(location.href); url.searchParams.delete('pos');
      history.replaceState({ ...(history.state || {}), posBulletin: false }, '', url);
    }
    previousFocus?.focus?.();
  }
  function setBulletinStatus(message) { const el = $('#pos-bulletin-status'); if (el) el.textContent = message; }
  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; }
    catch {
      const textarea = document.createElement('textarea'); textarea.value = text; textarea.setAttribute('readonly', ''); textarea.style.position = 'fixed'; textarea.style.opacity = '0';
      document.body.append(textarea); textarea.select(); let ok = false;
      try { ok = document.execCommand('copy'); } catch { ok = false; }
      textarea.remove(); return ok;
    }
  }
  function bulletinUrl() {
    const url = new URL(location.href); url.searchParams.set('pos', 'boletim');
    url.hash = selectedAnalysisRole === 'gov' ? `#gov/${selectedGovUf}` : '#pres';
    return url.href;
  }
  async function shareBulletinText() {
    const text = buildBulletinText();
    try {
      if (navigator.share) { await navigator.share({ title: 'Boletim final · Apuração 2026', text, url: bulletinUrl() }); setBulletinStatus('Menu de compartilhamento aberto.'); }
      else { const ok = await copyText(`${text}\n\n${bulletinUrl()}`); setBulletinStatus(ok ? 'Seu aparelho não oferece compartilhamento nativo; texto e link copiados.' : 'Compartilhamento não suportado neste navegador.'); }
    } catch (error) { if (error?.name !== 'AbortError') setBulletinStatus('O compartilhamento foi cancelado ou não ficou disponível.'); }
  }
  async function buildBulletinCanvas(size = 'portrait') {
    const width = 1080, height = size === 'story' ? 1920 : 1350;
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas não disponível neste navegador.');
    const isLight = matchMedia('(prefers-color-scheme: light)').matches;
    const bg = isLight ? '#f6f7f9' : '#07080c'; const ink = isLight ? '#0b0d13' : '#f5f7fa'; const muted = isLight ? '#626978' : '#7f8798';
    ctx.fillStyle = bg; ctx.fillRect(0, 0, width, height);
    // Aurora discreta, sem bibliotecas externas.
    const g = ctx.createLinearGradient(0, 0, width, height); g.addColorStop(0, 'rgba(239,51,64,0.18)'); g.addColorStop(1, 'rgba(59,130,246,0.16)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, width, Math.round(height * 0.36));
    const logo = new Image();
    const logoPath = isLight ? '/img/logo/logo-horizontal-claro.svg' : '/img/logo/logo-horizontal-escuro.svg';
    const logoLoaded = await new Promise((resolve) => { logo.onload = () => resolve(true); logo.onerror = () => resolve(false); logo.src = logoPath; });
    if (logoLoaded) { try { ctx.drawImage(logo, 72, 36, 248, 64); } catch { ctx.fillStyle = ink; ctx.font = '700 36px Geist, Arial, sans-serif'; ctx.fillText('APURAÇÃO 2026', 72, 86); } }
    else { ctx.fillStyle = ink; ctx.font = '700 36px Geist, Arial, sans-serif'; ctx.fillText('APURAÇÃO 2026', 72, 86); }
    ctx.fillStyle = muted; ctx.font = '500 24px Geist, Arial, sans-serif'; ctx.fillText('BOLETIM FINAL · SEGUNDO TURNO', 72, 140);
    const textLines = bulletinSections();
    const maxWidth = width - 144;
    const availableHeight = height - 215 - 132;
    const layoutFor = (fontSize) => {
      const layout = [];
      for (const rawLine of textLines) {
        if (!rawLine) { layout.push({ blank: true, height: fontSize * 0.45 }); continue; }
        const heading = /^[A-ZÁÉÍÓÚÃÕÇ0-9 ·—–:-]{6,}$/.test(rawLine) && rawLine.length < 72;
        const size = heading ? fontSize * 1.08 : fontSize;
        ctx.font = `${heading ? '700' : '500'} ${size}px Geist, Arial, sans-serif`;
        const words = rawLine.split(/\s+/); let line = '';
        for (const word of words) {
          const next = line ? `${line} ${word}` : word;
          if (ctx.measureText(next).width > maxWidth && line) { layout.push({ text: line, heading, size, height: fontSize * 1.36 }); line = word; }
          else line = next;
        }
        if (line) layout.push({ text: line, heading, size, height: fontSize * 1.36 });
        if (heading) layout.push({ blank: true, height: fontSize * 0.28 });
      }
      return layout;
    };
    let fontSize = 24;
    let layout = layoutFor(fontSize);
    while (layout.reduce((sum, line) => sum + line.height, 0) > availableHeight && fontSize > 14) {
      fontSize -= 1;
      layout = layoutFor(fontSize);
    }
    if (layout.reduce((sum, line) => sum + line.height, 0) > availableHeight) {
      throw new Error('O boletim selecionado tem conteúdo demais para caber inteiro nesta imagem. Desmarque algumas seções ou use a saída de texto, que mantém todos os dados.');
    }
    let y = 215;
    for (const line of layout) {
      if (line.blank) { y += line.height; continue; }
      ctx.fillStyle = line.heading ? ink : muted;
      ctx.font = `${line.heading ? '700' : '500'} ${line.size}px Geist, Arial, sans-serif`;
      ctx.fillText(line.text, 72, y);
      y += line.height;
    }
    ctx.fillStyle = muted; ctx.font = '500 18px Geist, Arial, sans-serif';
    ctx.fillText('Projeto independente · Resultado oficial: TSE', 72, height - 72);
    ctx.fillText(new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Sao_Paulo' }).format(new Date()) + ' · Horário de Brasília', 72, height - 42);
    return canvas;
  }
  function canvasBlob(canvas) {
    return new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('Não foi possível gerar a imagem PNG.')), 'image/png'));
  }
  async function downloadBulletinPng(size) {
    try {
      const canvas = await buildBulletinCanvas(size); const blob = await canvasBlob(canvas);
      const url = URL.createObjectURL(blob); const link = document.createElement('a');
      link.href = url; link.download = size === 'story' ? 'boletim-apuracao-2026-story.png' : 'boletim-apuracao-2026.png';
      document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1500);
      setBulletinStatus('PNG gerado localmente.');
    } catch (error) { setBulletinStatus(error?.message || 'Não foi possível gerar o PNG.'); }
  }
  async function shareBulletinPng() {
    try {
      const blob = await canvasBlob(await buildBulletinCanvas('portrait'));
      const file = new File([blob], 'boletim-apuracao-2026.png', { type: 'image/png' });
      if (navigator.canShare?.({ files: [file] }) && navigator.share) {
        await navigator.share({ files: [file], title: 'Boletim final · Apuração 2026', text: 'Projeto independente. Resultado oficial: TSE.' });
        setBulletinStatus('Menu de compartilhamento aberto.');
      } else {
        const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = file.name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1500);
        setBulletinStatus('O compartilhamento de arquivos não é suportado aqui; o PNG foi baixado.');
      }
    } catch (error) { if (error?.name !== 'AbortError') setBulletinStatus(error?.message || 'Não foi possível compartilhar o PNG.'); }
  }

  // ----- Histórico horário: importação é local, sem upload ou persistência automática. -----
  async function importHoursFile(event) {
    const file = event.target.files?.[0]; event.target.value = '';
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) { setHoursStatus('O JSON excede 5 MB e não foi importado.'); return; }
    try {
      const data = JSON.parse(await file.text()); const validation = validateHoursDataset(data);
      if (!validation.ok) { setHoursStatus(`Arquivo rejeitado: ${validation.errors.join(' ')}`); return; }
      hoursData = data; hoursImportedInSession = true; renderAnalysis();
      setHoursStatus(`Série carregada apenas nesta sessão (${fmtInt(data.points.length)} pontos). Nada foi enviado ao servidor.`);
    } catch { setHoursStatus('Não foi possível ler o JSON. Verifique se o arquivo está íntegro.'); }
  }
  function setHoursStatus(message) {
    const target = $('#pos-hours-content');
    if (!target) return;
    let status = $('#pos-hours-import-status');
    if (!status) { status = document.createElement('p'); status.id = 'pos-hours-import-status'; status.className = 'pos-status-text'; status.setAttribute('role', 'status'); target.append(status); }
    status.textContent = message;
  }
  function downloadHoursTemplate() {
    const blob = new Blob([`${JSON.stringify(DEFAULT_HOURS, null, 2)}\n`], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = 'horarios-modelo.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ----- Mapa municipal separado do mapa estadual original. -----
  async function openMunicipalView(role, uf, push = true) {
    role = role === 'gov' ? 'gov' : 'pres'; uf = normalizeUf(uf);
    if (!STATE_NAMES[uf] || uf === 'zz') return;
    if (role === 'gov' && !GOV_UFS.includes(uf)) return;
    municipalContext = { role, uf };
    municipalRowsCache = null;
    const overlay = $('#pos-municipal-overlay');
    if (!overlay) return;
    overlay.hidden = false;
    $('#map')?.classList.add('pos-original-map-hidden');
    $('#ext-btn')?.classList.add('pos-original-map-hidden');
    $('#legend-gradient')?.classList.add('pos-original-map-hidden');
    $('#legend-caption')?.classList.add('pos-original-map-hidden');
    $('#pos-municipal-title').textContent = `Municípios · ${uf.toUpperCase()}`;
    $('#pos-municipal-subtitle').textContent = `${STATE_NAMES[uf]} · ${role === 'gov' ? 'Governador' : 'Presidente'} · dados finais locais, quando disponíveis.`;
    $('#pos-municipal-status').textContent = 'Carregando geometria local do município…';
    $('#pos-municipal-detail').textContent = 'Selecione um município no mapa ou na lista.';
    municipalGeometry = null; municipalResults = null; municipalZoom = { scale: 1, x: 0, y: 0, base: null };
    if (push && !new URLSearchParams(location.search).has('pos-cidades')) {
      const url = new URL(location.href); url.searchParams.set('pos-cidades', uf);
      history.pushState({ ...(history.state || {}), posCities: true, posPreviousUrl: location.pathname + location.search + location.hash }, '', url);
    } else if (push && new URLSearchParams(location.search).get('pos-cidades') !== uf) {
      const url = new URL(location.href); url.searchParams.set('pos-cidades', uf); history.pushState({ ...(history.state || {}), posCities: true }, '', url);
    }
    const [geometry, results, mappings] = await Promise.all([
      fetchLocalJson(`/data/municipios/${uf}.json`), fetchLocalJson(`/data/final/municipalities/${role}-${uf}.json`),
      municipalMappings || fetchLocalJson('/data/municipios-map.json'),
    ]);
    // A navigation can happen while files are loading; discard stale requests.
    if (!municipalContext || municipalContext.uf !== uf || municipalContext.role !== role || overlay.hidden) return;
    municipalGeometry = geometry;
    municipalResults = results;
    municipalMappings = mappings;
    municipalRowsCache = null;
    renderMunicipalMap();
  }
  function closeMunicipalView() {
    if (history.state?.posCities) { history.back(); return; }
    const url = new URL(location.href); url.searchParams.delete('pos-cidades');
    history.replaceState({ ...(history.state || {}), posCities: false }, '', url);
    hideMunicipalOverlay(false);
  }
  function hideMunicipalOverlay(resetHistory = true) {
    const overlay = $('#pos-municipal-overlay'); if (overlay) overlay.hidden = true;
    ['#map', '#ext-btn', '#legend-gradient', '#legend-caption'].forEach((selector) => $(selector)?.classList.remove('pos-original-map-hidden'));
    if (resetHistory && new URLSearchParams(location.search).has('pos-cidades')) {
      const url = new URL(location.href); url.searchParams.delete('pos-cidades');
      history.replaceState({ ...(history.state || {}), posCities: false }, '', url);
    }
    municipalContext = null; municipalGeometry = null; municipalResults = null; municipalRowsCache = null;
  }
  function municipalityRows() {
    if (municipalRowsCache) return municipalRowsCache;
    const features = Array.isArray(municipalGeometry?.features) ? municipalGeometry.features : [];
    const lookup = municipalMappings?.mappings;
    const mappingByIbge = new Map();
    if (Array.isArray(lookup)) {
      for (const item of lookup) mappingByIbge.set(String(item.ibgeCode ?? item.ibge ?? ''), item);
    } else if (lookup && typeof lookup === 'object') {
      for (const [key, item] of Object.entries(lookup)) mappingByIbge.set(String(key), item);
    }
    const rowsFromResults = Array.isArray(municipalResults?.municipalities) ? municipalResults.municipalities : [];
    const resultByTse = new Map(); const resultByIbge = new Map();
    for (const row of rowsFromResults) {
      if (row.tseCode != null && row.tseCode !== '') resultByTse.set(String(row.tseCode), row);
      if (row.ibgeCode != null && row.ibgeCode !== '') resultByIbge.set(String(row.ibgeCode), row);
    }
    municipalRowsCache = features.map((feature) => {
      const mapping = mappingByIbge.get(String(feature.idIbge));
      const tseCode = String(feature.tseCode || mapping?.tseCode || mapping?.tse || '');
      const candidateResult = (tseCode ? resultByTse.get(tseCode) : null) || resultByIbge.get(String(feature.idIbge)) || null;
      const result = candidateResult?.final === true && validateResult(candidateResult).ok ? candidateResult : null;
      const cands = result?.cands || [];
      const a = cands[0] || null; const b = cands[1] || null;
      const pctA = a ? (finite(a.pct) || pctOf(a.votes, result?.votes?.valid)) : 0;
      const pctB = b ? (finite(b.pct) || pctOf(b.votes, result?.votes?.valid)) : 0;
      const margin = Math.abs(pctA - pctB);
      const profile = candidateProfiles({ cands }, municipalContext?.role, municipalContext?.uf);
      const hasMunicipalVotes = Boolean(result && (finite(result?.votes?.valid) > 0 || finite(a?.votes) + finite(b?.votes) > 0));
      const winnerIndex = !hasMunicipalVotes || cands.length < 2 || Math.abs(pctA - pctB) < 0.000001 ? -1 : pctA > pctB ? 0 : 1;
      const isTie = hasMunicipalVotes && cands.length >= 2 && margin < 0.5;
      const winner = winnerIndex >= 0 ? profile[winnerIndex] : null;
      return {
        ...feature, name: feature.name || mapping?.name || `Município ${feature.idIbge}`, tseCode,
        result, cands: profile, pctA, pctB, margin, winnerIndex, winner, tie: isTie,
        votes: finite(result?.votes?.valid) || finite(a?.votes) + finite(b?.votes),
        voteDiff: Math.abs(finite(a?.votes) - finite(b?.votes)),
      };
    });
    return municipalRowsCache;
  }
  function renderMunicipalMap() {
    const map = $('#pos-municipal-map'); const group = $('#pos-municipal-map-geometry');
    if (!map || !group || !municipalContext) return;
    const geometry = municipalGeometry;
    if (!geometry || !Array.isArray(geometry.features) || !geometry.features.length) {
      map.setAttribute('viewBox', '0 0 640 640'); group.innerHTML = '';
      $('#pos-municipal-status').textContent = `A malha municipal de ${municipalContext.uf.toUpperCase()} não está empacotada. Gere-a com node scripts/build-municipios.js em ambiente com rede; o mapa estadual original continua disponível ao voltar.`;
      $('#pos-municipal-count').textContent = '0 municípios'; $('#pos-municipal-ranking').innerHTML = emptyMarkup('Geometria municipal indisponível.');
      $('#pos-municipal-detail').innerHTML = emptyMarkup('Ainda não há mapa municipal para exibir.');
      return;
    }
    const viewBox = geometry.viewBox || { x: 0, y: 0, width: 640, height: 640 };
    map.setAttribute('viewBox', `${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}`);
    municipalZoom.base = { ...viewBox };
    const rows = municipalityRows();
    const paths = rows.map((row) => {
      const d = String(row.d || '');
      if (!d || !/^[MmLlHhVvCcSsQqTtAaZz0-9eE.,\s+\-]+$/.test(d)) return '';
      let fill = 'var(--map-empty)'; let opacity = '';
      if (row.result && row.cands.length >= 2 && row.votes > 0) {
        if (row.tie) { fill = 'url(#pos-municipal-tie-pattern)'; opacity = '0.88'; }
        else if (row.winner) {
          fill = row.winner.color;
          const bands = [{ max: 2, light: 0.30, dark: 0.36 }, { max: 5, light: 0.46, dark: 0.52 }, { max: 10, light: 0.64, dark: 0.68 }, { max: 20, light: 0.80, dark: 0.84 }, { max: Infinity, light: 0.95, dark: 0.96 }];
          const band = bands.find((b) => row.margin < b.max) || bands[bands.length - 1];
          opacity = String(matchMedia('(prefers-color-scheme: light)').matches ? band.light : band.dark);
        }
      }
      const label = `${row.name}; ${row.result && row.votes > 0 ? row.tie ? 'empate técnico' : `à frente: ${row.winner?.displayName || 'sem identificação'}` : 'sem dados finais municipais'}; ${row.result && row.votes > 0 ? `${row.cands[0]?.displayName} ${fmtPct(row.pctA)}% (${fmtInt(row.cands[0]?.votes)} votos), ${row.cands[1]?.displayName} ${fmtPct(row.pctB)}% (${fmtInt(row.cands[1]?.votes)} votos), margem ${fmtPct(row.margin)} p.p., ${sectionPercent(row.result) == null ? 'percentual de seções não informado' : `${fmtPct(sectionPercent(row.result))}% das seções apuradas`}` : 'dados municipais não disponíveis'}`;
      return `<path class="pos-municipality-shape ${row.result && row.votes > 0 ? '' : 'is-empty'}" data-code="${esc(row.idIbge)}" d="${esc(d)}" fill="${esc(fill)}" ${opacity ? `fill-opacity="${opacity}"` : ''} tabindex="0" role="button" aria-label="${esc(label)}" vector-effect="non-scaling-stroke"><title>${esc(label)}</title></path>`;
    }).join('');
    const tieCandidates = municipalContext.role === 'gov' ? (GOV_CANDIDATES[municipalContext.uf] || []) : [{ n: '13', name: 'Lula' }, { n: '22', name: 'Flávio Bolsonaro' }];
    const tieProfiles = candidateProfiles({ cands: tieCandidates.slice(0, 2).map((c) => ({ n: c.n, name: c.name, party: c.party })) }, municipalContext.role, municipalContext.uf);
    group.innerHTML = `<defs><pattern id="pos-municipal-tie-pattern" width="8" height="8" patternTransform="rotate(-45)" patternUnits="userSpaceOnUse"><rect width="4" height="8" fill="${esc(tieProfiles[0]?.color || 'var(--cand-0)')}"></rect><rect x="4" width="4" height="8" fill="${esc(tieProfiles[1]?.color || 'var(--cand-1)')}"></rect></pattern></defs>${paths}`;
    $('#pos-municipal-count').textContent = `${fmtInt(rows.length)} municípios`;
    if (!municipalResults?.municipalities?.length) {
      $('#pos-municipal-status').textContent = 'A geometria está pronta, mas os resultados finais por município ainda não foram gerados. As áreas aparecem na cor neutra; nenhuma vitória foi estimada.';
    } else {
      $('#pos-municipal-status').textContent = `Dados municipais carregados: ${fmtInt(municipalResults.municipalities.length)} registros. Cobertura geométrica: ${fmtInt(rows.length)} municípios. Os municípios sem correspondência ou resultado permanecem neutros.`;
    }
    renderMunicipalRanking();
  }
  function filteredMunicipalRows() {
    const rows = municipalityRows();
    const query = normalizeText($('#pos-city-search')?.value || '');
    const sort = $('#pos-city-sort')?.value || 'name';
    const filtered = rows.filter((row) => !query || normalizeText(row.name).includes(query));
    filtered.sort((a, b) => {
      if (sort === 'votes') return b.votes - a.votes || a.name.localeCompare(b.name, 'pt-BR');
      if (sort === 'margin') return a.margin - b.margin || a.name.localeCompare(b.name, 'pt-BR');
      if (sort === 'pctA') return b.pctA - a.pctA || a.name.localeCompare(b.name, 'pt-BR');
      if (sort === 'pctB') return b.pctB - a.pctB || a.name.localeCompare(b.name, 'pt-BR');
      return a.name.localeCompare(b.name, 'pt-BR');
    });
    return filtered;
  }
  function renderMunicipalRanking() {
    if (!municipalContext) return;
    const rows = filteredMunicipalRows(); const target = $('#pos-municipal-ranking');
    if (!target) return;
    if (!rows.length) { target.innerHTML = emptyMarkup('Nenhum município corresponde à busca.'); return; }
    target.innerHTML = rows.map((row) => `<button type="button" class="pos-municipality-row" data-city-select="${esc(row.idIbge)}"><span class="pos-municipality-name">${esc(row.name)}<small>${row.result ? (row.tie ? 'Empate técnico' : esc(row.winner?.displayName || 'Sem vencedor')) : 'Sem dados finais'}</small></span><span class="pos-city-meter"><i style="width:${Math.max(0, Math.min(100, row.pctA))}%;background:${esc(row.cands[0]?.color || 'var(--muted)')}"></i></span><strong>${row.result ? `${fmtPct(row.pctA)}% × ${fmtPct(row.pctB)}%` : '—'}</strong></button>`).join('');
  }
  function selectMunicipality(id, focusDetail = false) {
    const row = municipalityRows().find((candidate) => String(candidate.idIbge) === String(id));
    if (!row) return;
    $$('#pos-municipal-map-geometry [data-code]').forEach((path) => path.classList.toggle('is-selected', String(path.dataset.code) === String(id)));
    const detail = $('#pos-municipal-detail');
    const profiles = row.cands.slice(0, 2);
    if (!row.result || profiles.length < 2) {
      detail.innerHTML = `<h3>${esc(row.name)}</h3>${emptyMarkup('Resultado municipal final não disponível.')}<p>O código IBGE é ${esc(row.idIbge)}${row.tseCode ? `; código TSE ${esc(row.tseCode)}` : ''}.</p>`;
    } else {
      const turnout = row.result.electorate || {};
      detail.innerHTML = `<h3>${esc(row.name)}</h3><p class="pos-detail-subtitle">${esc(municipalContext.uf.toUpperCase())} · ${row.tie ? 'empate técnico' : `${esc(row.winner?.displayName || 'Vencedor não identificado')} à frente`}</p>${profiles.map((c) => `<div class="pos-municipal-candidate"><img class="pos-municipal-candidate-photo" src="${esc(c.photo || '')}" alt="" loading="lazy" ${c.photo ? '' : 'hidden'}><span class="pos-color-key" style="--pos-candidate:${esc(c.color)}"></span><div><strong>${esc(c.displayName)}</strong><small>${esc(c.party || '')}</small></div><b>${fmtInt(c.votes)} votos</b><span>${fmtPct(candidateShare(c, row.result))}%</span></div>`).join('')}<div class="pos-stat-line"><span>Margem</span><strong>${fmtPct(row.margin)} p.p. · ${fmtInt(row.voteDiff)} votos</strong></div><div class="pos-stat-line"><span>Votos brancos / nulos</span><strong>${fmtInt(row.result.votes?.blank)} / ${fmtInt(row.result.votes?.nul)}</strong></div>${sectionPercent(row.result) == null ? '' : `<div class="pos-stat-line"><span>Seções apuradas</span><strong>${fmtPct(sectionPercent(row.result))}%</strong></div>`}${finite(turnout.total) ? `<div class="pos-stat-line"><span>Comparecimento / abstenção</span><strong>${fmtInt(turnout.present)} / ${fmtInt(turnout.abst)}</strong></div>` : ''}`;
      $$('.pos-municipal-candidate-photo', detail).forEach((image) => image.addEventListener('error', () => { image.hidden = true; }));
    }
    if (focusDetail) detail.focus?.();
  }
  function onMunicipalMapClick(event) {
    if (municipalMoved) { municipalMoved = false; return; }
    const path = event.target.closest('[data-code]'); if (path) selectMunicipality(path.dataset.code, false);
  }
  function onMunicipalMapFocus(event) {
    const path = event.target.closest('[data-code]'); if (path) showMunicipalTooltip(path.dataset.code);
  }
  function onMunicipalMapKeydown(event) {
    const paths = $$('[data-code]', $('#pos-municipal-map-geometry'));
    const current = event.target.closest('[data-code]'); if (!current) return;
    const index = paths.indexOf(current);
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); selectMunicipality(current.dataset.code, false); }
    else if (['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'].includes(event.key)) {
      event.preventDefault(); const delta = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1; paths[(index + delta + paths.length) % paths.length]?.focus();
    }
  }
  function onMunicipalPointerOver(event) { const path = event.target.closest('[data-code]'); if (path) showMunicipalTooltip(path.dataset.code); }
  function showMunicipalTooltip(id) {
    const row = municipalityRows().find((r) => String(r.idIbge) === String(id)); const tooltip = $('#pos-municipal-tooltip');
    if (!row || !tooltip) return;
    tooltip.innerHTML = `<strong>${esc(row.name)}</strong><span>${row.result && row.votes > 0 ? (row.tie ? 'Empate técnico' : esc(row.winner?.displayName || 'Vencedor não identificado')) : 'Sem dados finais'}</span><small>${row.result && row.votes > 0 ? `${esc(row.cands[0]?.displayName || 'Candidato A')}: ${fmtInt(row.cands[0]?.votes)} (${fmtPct(row.pctA)}%) · ${esc(row.cands[1]?.displayName || 'Candidato B')}: ${fmtInt(row.cands[1]?.votes)} (${fmtPct(row.pctB)}%) · margem ${fmtPct(row.margin)} p.p. · ${fmtPct(row.result.sections?.pct)}% das seções` : 'O município permanece neutro até existir resultado local'}</small>`;
    tooltip.classList.add('is-visible');
  }
  function hideMunicipalTooltip() { $('#pos-municipal-tooltip')?.classList.remove('is-visible'); }
  function setMunicipalZoom(multiplier, centerX = null, centerY = null) {
    const base = municipalZoom.base; const map = $('#pos-municipal-map'); if (!base || !map) return;
    const box = map.viewBox.baseVal; const factor = Math.min(15, Math.max(1, municipalZoom.scale * multiplier));
    const center = { x: centerX ?? (box.x + box.width / 2), y: centerY ?? (box.y + box.height / 2) };
    const ratio = factor / municipalZoom.scale;
    const width = base.width / factor; const height = base.height / factor;
    const x = center.x - (center.x - box.x) / ratio; const y = center.y - (center.y - box.y) / ratio;
    municipalZoom.scale = factor; municipalZoom.x = Math.max(base.x - base.width * 2, Math.min(base.x + base.width * 2, x)); municipalZoom.y = Math.max(base.y - base.height * 2, Math.min(base.y + base.height * 2, y));
    map.setAttribute('viewBox', `${municipalZoom.x} ${municipalZoom.y} ${width} ${height}`);
  }
  function resetMunicipalZoom() {
    if (!municipalZoom.base) return;
    municipalZoom.scale = 1; municipalZoom.x = municipalZoom.base.x; municipalZoom.y = municipalZoom.base.y;
    $('#pos-municipal-map')?.setAttribute('viewBox', `${municipalZoom.base.x} ${municipalZoom.base.y} ${municipalZoom.base.width} ${municipalZoom.base.height}`);
  }
  function onMunicipalWheel(event) {
    event.preventDefault();
    const svg = $('#pos-municipal-map'); const rect = svg.getBoundingClientRect(); const vb = svg.viewBox.baseVal;
    const cx = vb.x + (event.clientX - rect.left) / rect.width * vb.width; const cy = vb.y + (event.clientY - rect.top) / rect.height * vb.height;
    setMunicipalZoom(event.deltaY < 0 ? 1.2 : 1 / 1.2, cx, cy);
  }
  function onMunicipalPointerDown(event) {
    if (event.target.closest('[data-code]') && event.pointerType === 'mouse') return;
    const map = event.currentTarget;
    municipalPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    try { map.setPointerCapture(event.pointerId); } catch { /* captura pode não ser suportada */ }
    if (municipalPointers.size >= 2) {
      const [a, b] = [...municipalPointers.values()].slice(-2);
      municipalPointer = null;
      municipalPinch = { distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), scale: municipalZoom.scale };
      municipalMoved = true;
    } else {
      municipalPointer = { x: event.clientX, y: event.clientY, lastX: event.clientX, lastY: event.clientY, pointerId: event.pointerId };
      municipalPinch = null;
      municipalMoved = false;
    }
  }
  function onMunicipalPointerMove(event) {
    if (municipalPointers.has(event.pointerId)) municipalPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (!municipalZoom.base) return;
    const svg = $('#pos-municipal-map');
    if (municipalPointers.size >= 2) {
      const [a, b] = [...municipalPointers.values()].slice(-2);
      const distance = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
      if (!municipalPinch) municipalPinch = { distance, scale: municipalZoom.scale };
      const targetScale = Math.min(15, Math.max(1, municipalPinch.scale * distance / municipalPinch.distance));
      const rect = svg.getBoundingClientRect(); const vb = svg.viewBox.baseVal;
      const midX = (a.x + b.x) / 2; const midY = (a.y + b.y) / 2;
      const worldX = vb.x + (midX - rect.left) / Math.max(1, rect.width) * vb.width;
      const worldY = vb.y + (midY - rect.top) / Math.max(1, rect.height) * vb.height;
      if (Math.abs(targetScale - municipalZoom.scale) > 0.001) setMunicipalZoom(targetScale / municipalZoom.scale, worldX, worldY);
      municipalMoved = true;
      return;
    }
    if (!municipalPointer || municipalPointer.pointerId !== event.pointerId) return;
    const dx = event.clientX - municipalPointer.lastX; const dy = event.clientY - municipalPointer.lastY;
    if (Math.abs(event.clientX - municipalPointer.x) + Math.abs(event.clientY - municipalPointer.y) > 6) municipalMoved = true;
    if (municipalMoved) {
      const rect = svg.getBoundingClientRect(); const vb = svg.viewBox.baseVal;
      municipalZoom.x -= dx / Math.max(1, rect.width) * vb.width; municipalZoom.y -= dy / Math.max(1, rect.height) * vb.height;
      svg.setAttribute('viewBox', `${municipalZoom.x} ${municipalZoom.y} ${vb.width} ${vb.height}`);
    }
    municipalPointer.lastX = event.clientX; municipalPointer.lastY = event.clientY;
  }
  function onMunicipalPointerUp(event) {
    municipalPointers.delete(event.pointerId);
    if (municipalPointers.size === 1) {
      const [pointerId, point] = [...municipalPointers.entries()][0];
      municipalPointer = { x: point.x, y: point.y, lastX: point.x, lastY: point.y, pointerId };
      municipalPinch = null;
    } else if (municipalPointers.size === 0) {
      municipalPointer = null; municipalPinch = null;
    }
  }

  // Run the optional layer defensively; any failure leaves the original panel intact.
  try {
    createUI();
    syncRouteSelection();
    loadAnalysisData().catch(() => {
      const status = $('#pos-source-status'); if (status) status.textContent = 'Não foi possível carregar os dados locais da análise. O painel de apuração original continua separado.';
    });
    updateCityTrigger();
  } catch (error) {
    console.error('[pós-eleição] camada opcional não foi iniciada:', error);
    $('#pos-analysis-launch')?.remove(); $('#pos-analysis')?.remove(); $('#pos-bulletin-modal')?.remove(); $('#pos-municipal-overlay')?.remove();
    $('#pos-city-trigger')?.remove();
  }
})();
