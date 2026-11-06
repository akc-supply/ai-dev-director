/**
 * 파일명: api/material.js
 * 목적: [자재관리 · 2026-10-22 · v0.53.0] 업무 › 자재관리 화면(/apps/material/)과 설정 › 업로드 › 자재관리 탭의 서버.
 *
 * [계산에 쓰는 자료 — 모두 읽기만 한다 (mm_ 표 말고는 쓰지 않는다)]
 *   · 기준점    : mm_base (재무회계팀 8월 말 수불부 기말 재고) + mm_item (자재구분 = 리드타임 · 주매입처) + mm_import (8월 수입자재)
 *   · BOM      : bom_rows (BOM 관리 화면이 쓰는 MES BOM 원본 29열) — 줄 순서와 Level 로 '바로 위 품번'을 잡아 한 단계씩 전개한다
 *   · 단가      : price_rows (BOM 관리 › 매입단가 명세서) — 적용화폐가 원화가 아니면 해외 자재로 본다
 *   · 생산계획  : plan_raw (설정 › 업로드 › 생산계획, MES 생산계획 52열) — 실적이 끝난 다음 날부터 쓴다
 *   · 생산실적  : production_raw (설정 › 업로드 › 생산실적) 만 — [v0.53.35] 자재관리 「제품생산」 업로드는 없앰
 *   · 입고      : mm_raw purchase (입고승인 · 입고확정 · 수입검사완료만 재고에 더함, 나머지는 '입고 진행 중')
 *   · 상품 출고 : mm_raw goods_sales
 *
 * [재고 계산] 추정 재고(기준일) = 8/31 기말 + 입고 + 자체 생산(반제품 · 외주품) − 사용
 *     사용 = 생산실적 × BOM (실적 기간) + 생산계획 × BOM (실적이 끝난 다음 날부터)
 *            BOM 에 없는 자재는 8월 수불부 출고 ÷ 31일, 상품은 실제 상품매출(이후 평균)
 *   소진 예상일 · 발주 권장일(= 소진 예상일 − 리드타임) · 완성품별 부족 자재는 화면(api/material-ui.html)이 기준일마다 다시 계산한다.
 */
const fs = require('fs');
const path = require('path');
const express = require('express');
const { supaFetch_ } = require('../lib/supabase');
const R = require('./material-rules');

const BASE_DATE = '2026-08-31';   // 기준 수불부가 없을 때만 쓰는 기본값 — 실제 기준일은 buildModel 이 mm_base 의 달(base_month)에서 정한다
/* [v0.53.20] 기준일 = 기준 수불부 달의 마지막 날 (예 : base_month '2026-08' → 2026-08-31)
   다음 달 수불부(예 '2026-09')를 기준으로 넣으면 기준일도 9/30 으로 따라가, 9월 입고 · 사용이 두 번 계산되지 않는다 */
function baseDateOf(bm) {
  const m = String(bm || '').match(/^(\d{4})-?(\d{1,2})/); if (!m) return BASE_DATE;
  const y = +m[1], mo = +m[2]; if (!(mo >= 1 && mo <= 12)) return BASE_DATE;
  return new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10);
}
const TTL = 5 * 60 * 1000;
const isAdm = u => !!u && (u.role === 'master' || u.role === 'admin');
const views = u => (Array.isArray(u && u.views) ? u.views : String((u && u.views) || '').split(',').map(s => s.trim()));
const canView = u => isAdm(u) || views(u).indexOf('material') > -1;
const canUpload = u => isAdm(u) || views(u).indexOf('upload') > -1 || views(u).indexOf('material') > -1;

/* ---------------- DB ---------------- */
async function db(method, p, body, prefer) {
  const r = await supaFetch_(method, p, body === undefined ? null : body, prefer ? { Prefer: prefer } : {});
  if (!r.ok) { const e = new Error('DB ' + method + ' ' + String(p).split('?')[0] + ' 실패 (' + r.status + ') ' + String(r.body || r.message).slice(0, 300)); e.status = r.status; e.body = r.body; throw e; }
  if (!r.body) return { data: null, headers: r.headers };
  try { return { data: JSON.parse(r.body), headers: r.headers }; } catch (e) { return { data: null, headers: r.headers }; }
}
const countOf = h => { const m = String((h && h.get && h.get('content-range')) || '').match(/\/(\d+)\s*$/); return m ? +m[1] : -1; };
async function count(table, filter) { const r = await db('GET', table + '?select=id' + (filter ? '&' + filter : '') + '&limit=1', null, 'count=exact'); return countOf(r.headers); }
/* 모두 읽기 (1000줄씩 · 6쪽 동시) — 표가 없으면 missing 표시 */
async function getAll(table, select, filter, order, cntCol) {
  const f = filter ? '&' + filter : '';
  let n;
  try { const r = await db('GET', table + '?select=' + (cntCol || 'id') + f + '&limit=1', null, 'count=exact'); n = countOf(r.headers); }
  catch (e) { if (e.status === 404 || /does not exist|PGRST20/.test(String(e.body || e.message))) { const out = []; out.missing = true; return out; } throw e; }
  if (n <= 0) return [];
  const pages = []; for (let o = 0; o < n; o += 1000) pages.push(o);
  const out = new Array(pages.length);
  for (let i = 0; i < pages.length; i += 6) {
    await Promise.all(pages.slice(i, i + 6).map(async (off, j) => { out[i + j] = (await db('GET', table + '?select=' + select + f + '&order=' + (order || 'id.asc') + '&offset=' + off + '&limit=1000')).data || []; }));
  }
  return [].concat.apply([], out);
}

/* ---------------- 공용 ---------------- */
const K = R.partKey;
const S = v => String(v == null ? '' : v).trim();
const N = v => { const n = Number(String(v == null ? '' : v).replace(/,/g, '')); return isFinite(n) ? n : 0; };
const hasHangul = s => /[가-힣]/.test(s);
const foreignName = s => !!s && /[A-Za-z]{3,}/.test(s) && !hasHangul(s) && !/^VINFAST$/i.test(s.trim()) ? true : (!!s && /ASHIMORI|DAICEL|LIMITED|LTD|INC\.|CORPORATION|GMBH|S\.A/i.test(s) && !hasHangul(s));
const today = () => { const d = new Date(Date.now() + 9 * 3600000); return d.toISOString().slice(0, 10); };
function addTo(map, k, d, q) { if (!q) return; const m = map[k] || (map[k] = {}); m[d] = (m[d] || 0) + q; }
const kstDay = t => { const v = Date.parse(t || ''); return isFinite(v) ? new Date(v + 9 * 3600000).toISOString().slice(0, 10) : ''; };   /* [v0.53.95] 기록을 등록한 한국 날짜 */
const ENG = require('./material-engine');   /* [v0.53.95] MES ↔ 화면 기록 맞춤 (reconcile) */
const toPairs = m => Object.keys(m || {}).sort().map(d => [d, Math.round(m[d] * 1000) / 1000]).filter(p => p[1]);

/* ---------------- BOM : 줄 순서 + Level 로 바로 위 품번을 잡는다 ---------------- */
function buildBom(rows) {
  const info = { rows: rows.length, tops: 0, blocks: 0, dupBlocks: 0, levelBad: 0, depthAgree: 0, depthChecked: 0, depthSelf: 0, levelJump: 0, qtyFromTotal: 0, levels: {}, parents: 0, children: 0, noQty: 0, noQtyRows: [] };
  const CH = {}, NAME = {}, UM = {}, VEND = {}, TOPS = {}, seenTop = {};
  let cur = null, stack = [], occ = 0, occParent = {}, occChildren = {};
  const flush = () => {
    if (!cur) return;
    // 한 품번의 '첫 등장' 묶음만 쓴다 (같은 반제품이 여러 완성품에 나와도 한 번만)
    Object.keys(occChildren).forEach(oid => {
      const p = occParent[oid]; if (CH[p] || !occChildren[oid].length) return;   // 아래가 없는 줄(자재)은 BOM 부모로 치지 않는다
      const m = {}; occChildren[oid].forEach(c => { m[c.k] = (m[c.k] || 0) + c.q; });
      CH[p] = Object.keys(m).map(k => ({ k, q: m[k] }));
    });
    cur = null; stack = []; occParent = {}; occChildren = {};
  };
  rows.forEach(rec => {
    const r = Array.isArray(rec.row) ? rec.row : [];
    const top = K(r[0]); if (!top) return;
    const sub = K(r[8]);
    if (top !== cur) {
      flush(); info.blocks++;
      if (seenTop[top]) { info.dupBlocks++; cur = '__dup__' + top; return; }
      seenTop[top] = true; cur = top; TOPS[top] = { code: S(r[0]), name: S(r[2]) }; NAME[top] = NAME[top] || S(r[2]); UM[top] = UM[top] || S(r[3]);
      occ++; occParent[occ] = top; occChildren[occ] = []; stack = [{ k: top, occ, tot: 1 }];
    }
    if (String(cur).indexOf('__dup__') === 0 || !sub) return;
    let lv = parseInt(String(r[5] == null ? '' : r[5]).replace(/[^\d]/g, ''), 10);
    if (!(lv >= 1)) { lv = 1; info.levelBad++; }
    info.levels[lv] = (info.levels[lv] || 0) + 1;
    if (lv > stack.length) info.levelJump++;   /* [v0.53.29] 계층이 한 칸 넘게 건너뜀 (예 Lv1 다음 Lv3) — 부모를 잘못 잡을 수 있는 줄 */
    while (stack.length > lv) stack.pop();
    const parent = stack[stack.length - 1] || stack[0];
    /* 소요량 : Required Qty(부모 1개당) · 비어 있으면 Total Required Qty(완성품 1개당 누계) ÷ 부모의 누계로 부모 1개당을 구한다
       (예전 : Total 을 그대로 써서 2단 이상에서 부모 수량을 한 번 더 곱할 수 있었다) */
    let q = N(r[12]);
    if (!q) { const tot = N(r[13]); if (tot) { q = lv > 1 && parent.tot ? tot / parent.tot : tot; info.qtyFromTotal++; } else { info.noQty++; q = 0; if (info.noQtyRows.length < 300) info.noQtyRows.push([S(r[0]), S(r[2]), lv, parent.k === K(r[0]) ? '' : parent.k, S(r[8]), S(r[10]), S(r[11])]); } }   /* [v0.53.31] 소요량 빈 줄 목록 (완성품 · 레벨 · 부모 · 자재) */
    const myTot = N(r[13]) || (parent.tot || 1) * q;
    if (lv > 1 && S(r[6])) { info.depthChecked++; if (K(r[6]) === parent.k) info.depthAgree++; if (K(r[6]) === sub) info.depthSelf++; }   /* Deepth Partnumber 가 부모인지 · 자기 자신(들여쓰기 표시)인지 둘 다 센다 */
    occChildren[parent.occ].push({ k: sub, q });
    occ++; occParent[occ] = sub; occChildren[occ] = [];
    stack.length = lv; stack.push({ k: sub, occ, tot: myTot });
    NAME[sub] = NAME[sub] || S(r[10]); UM[sub] = UM[sub] || S(r[11]);
    if (S(r[15])) VEND[sub] = VEND[sub] || S(r[15]);
  });
  flush();
  info.tops = Object.keys(TOPS).length; info.parents = Object.keys(CH).length;
  const kids = {}; Object.values(CH).forEach(l => l.forEach(c => { kids[c.k] = 1; })); info.children = Object.keys(kids).length;
  return { CH, NAME, UM, VEND, TOPS, info };
}
/* 전개 : 바로 아래 품번에 수요를 준다. 단, 아래 품번이 또 BOM 을 가진 반제품이고 따로 생산(계획) 기록이 없으면 그 아래로 내려가 자재에 준다 */
function explode(B, item, qty, sink, own, depth, trail) {
  const ch = B.CH[item]; if (!ch || depth > 8) return;
  ch.forEach(c => {
    if (!c.q) return;
    const amt = qty * c.q;
    // 아래에 BOM 이 있고 따로 생산 기록(계획)이 없으면 '통과 품번' 으로 보고 그 아래 자재로 내려간다 (두 번 세지 않게)
    if (B.CH[c.k] && !own.has(c.k) && trail.indexOf(c.k) < 0 && depth < 8) explode(B, c.k, amt, sink, own, depth + 1, trail.concat(c.k));
    else sink(c.k, amt, depth);
  });
}

/* ---------------- 생산계획 (plan_raw) ---------------- */
function parsePlan(rows) {
  const out = [], info = { rows: rows.length, items: 0, from: null, to: null, months: {} };
  const seen = {};
  rows.forEach(rec => {
    const c = rec.cells || []; const code = S(c[0]); if (!code) return;
    if (/~/.test(code) || /^품목코드/.test(code)) return;
    const y = +rec.plan_year, mo = parseInt(c[51] != null && c[51] !== '' ? c[51] : rec.plan_month, 10); if (!(y > 2000) || !(mo >= 1 && mo <= 12)) return;
    const dim = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    for (let d = 1; d <= dim; d++) {
      const q = N(c[9 + d - 1]); if (!q) continue;
      const ds = y + '-' + (mo < 10 ? '0' : '') + mo + '-' + (d < 10 ? '0' : '') + d;
      out.push({ k: K(code), code, name: S(c[1]), line: S(c[7]) || S(c[6]), fix: S(c[8]), d: ds, q });
      if (!info.from || ds < info.from) info.from = ds; if (!info.to || ds > info.to) info.to = ds;
      info.months[ds.slice(0, 7)] = 1; seen[K(code)] = 1;
    }
  });
  info.items = Object.keys(seen).length; info.months = Object.keys(info.months).sort();
  return { rows: out, info };
}

/* ---------------- 생산실적 (production_raw 보조) ---------------- */
async function legacyProduction(months) {
  if (!months.length) return { rows: [], months: [] };
  const years = Array.from(new Set(months.map(m => m.slice(0, 4))));
  const out = [], got = {};
  for (const y of years) {
    let meta = null;
    try { meta = ((await db('GET', 'production_meta?prod_year=eq.' + y + '&select=header&limit=1')).data || [])[0]; } catch (e) { meta = null; }
    const h = ((meta && meta.header) || []).map(R.hn);
    const at = (names, fb) => { for (const n of names) { const i = h.indexOf(R.hn(n)); if (i > -1) return i; } return fb; };
    const C = { d: at(['등록일자'], 0), code: at(['품목코드[P/T No.]', '품목코드'], 6), name: at(['품목명[Description]'], 7), good: at(['양품수량[Qty]'], 15), div: at(['구분'], 27), cm: at(['Customer Name'], 5) };
    const C2 = { all: at(['생산총수량'], -1), bad: at(['불량수량[Qty]'], -1), cmc: at(['C/M No.'], -1) };   /* [v0.53.34] 대시보드 생산 · 출고에도 쓰도록 */
    const ms = months.filter(m => m.slice(0, 4) === y);
    let rows = [];
    try { rows = await getAll('production_raw', 'row_no,cells', 'prod_year=eq.' + y + '&reg_month=in.(' + ms.join(',') + ')', 'row_no.asc', 'row_no'); } catch (e) { rows = []; }
    rows.forEach(rr => {
      const c = rr.cells || []; const d = R.toDate(c[C.d]); const code = S(c[C.code]); if (!d || !code) return;
      out.push({ row_date: d, part_key: K(code), part_no: code, part_name: S(c[C.name]), qty: N(c[C.good]), qty2: C2.all > -1 ? N(c[C2.all]) : null, qty3: C2.bad > -1 ? N(c[C2.bad]) : null, status: S(c[C.div]), cm_name: S(c[C.cm]), cm_code: C2.cmc > -1 ? S(c[C2.cmc]) : '' });
      got[d.slice(0, 7)] = 1;
    });
  }
  return { rows: out, months: Object.keys(got).sort() };
}

/* ---------------- 모델 (화면 계산 재료) ---------------- */
/* [v0.53.22] 고객사 기준표 — 본 화면 고객사 분석(CustomerAnalysis.gs)과 같은 자료 · 같은 규칙
   품번(AKC품번 · 고객사품번, '#' 뒤 · 기호 빼고 대문자) → 고객사
     HKMC 차종정보 · HKMC 생산계획 (고객사 칸 HMC / KMC → HKMC) · KGM 생산계획 · KGM 프로젝트 → KGM · CKD 판매계획 → CKD
     통합단가(unit_price.customer_group : HKMC · KGM · VF) 로 빈 곳을 채운다 · BIN 품번은 화면에서 VINFAST
   표가 없거나 못 읽으면 빈 기준표 (화면은 품명 · 거래처 글자 규칙으로만 나눈다) */
const custNorm = v => { let c = String(v == null ? '' : v).toUpperCase(); const h = c.indexOf('#'); if (h > -1) c = c.substring(0, h); return c.replace(/[^A-Z0-9]/g, ''); };
async function custMaster() {
  const map = {}, n = { HKMC: 0, KGM: 0, CKD: 0, VINFAST: 0 };
  const put = (code, cu) => { const k = custNorm(code); if (k.length < 5 || !/\d/.test(k) || !cu || map[k]) return; map[k] = cu; n[cu] = (n[cu] || 0) + 1; };
  const SRC = { hkmc_cartype: [c => /KMC|HMC|현대|기아/i.test(String(c[1] || '')) ? 'HKMC' : '', [3, 4]], hkmc_plan: [c => /KMC|HMC|현대|기아/i.test(String(c[1] || '')) ? 'HKMC' : '', [6]],
                kgm_plan: [() => 'KGM', [2, 1]], kgm_project: [() => 'KGM', [3, 2]], ckd_plan: [() => 'CKD', [4, 3]] };
  try {
    const rows = await getAll('integrated_raw', 'sheet_key,cells', 'sheet_key=in.(' + Object.keys(SRC).join(',') + ')', 'id.asc');
    rows.forEach(r => { const d = SRC[r.sheet_key], c = r.cells || []; if (!d) return; const cu = d[0](c); if (cu) d[1].forEach(i => put(c[i], cu)); });
  } catch (e) { n.err = String(e.message || e).slice(0, 120); }
  try {
    const up = await getAll('unit_price', 'material_code,akc,customer_group', '', 'id.asc');
    up.forEach(r => { const g = String(r.customer_group || ''), cu = /HKMC|HMC|KMC/i.test(g) ? 'HKMC' : /KGM/i.test(g) ? 'KGM' : /VF|VINFAST/i.test(g) ? 'VINFAST' : /CKD/i.test(g) ? 'CKD' : ''; if (cu) { put(r.akc, cu); put(r.material_code, cu); } });
  } catch (e) { n.errPrice = String(e.message || e).slice(0, 120); }
  return { map, n };
}
/* [v0.53.57] 품번 변경 규칙 (자재 대체) — 예 : 진영전기 → 신진 하네스 (2026-10-27 생산분부터 · MES REV 01→02 / 03→04)
   규칙 한 줄 = { fg : 완성품 품번, neu : 새 자재 품번, from : 적용일, old : 바꿀 자재 품번 (비우면 BOM 에서 자동으로 찾음), note }
   자동 찾기 : 새 품번의 끝 꼬리(H1 같은 업체 표시)를 뗀 앞부분과 같은 앞부분을 가진, 그 완성품 BOM 안의 다른 자재
     (예 : 새 KACL1800010H1 → 앞부분 KACL1800010 → BOM 의 KACL1800010K-2 (진영))
   적용 : 그 완성품의 생산실적 · 생산계획 · S/L 을 BOM 으로 펼칠 때, 적용일부터는 바꿀 자재 대신 새 자재로 센다 (적용일 전은 그대로)
   저장 : app_props 'mm_subst_rules' (화면 「품번 변경 규칙」 에서 고침) · 처음에는 아래 공문 12줄 */
const SUBST_KEY = 'mm_subst_rules';
/* [v0.53.69] 신진 새 품번 고침 (사용자 화면 캡처 2026-10-31) : KACL1800010H1 → KACL180010H1 (FRT/RH) · KACL1800000H1 → KACL180000H1 (FRT/LH)
 *   새 품번의 앞부분(KACL180010)이 진영 품번(KACL1800010K-2)과 달라 자동 찾기가 안 되므로 바꿀 진영 품번을 적어 둔다 (BOM 에 있는 것만 쓰임) */
const SUBST_FIX = { KACL1800010H1: 'KACL180010H1', KACL1800000H1: 'KACL180000H1' };
const SUBST_OLD = { KACL180010H1: 'KACL1800010K-2, KACL1800010H', KACL180000H1: 'KACL1800000K-2, KACL1800000H' };
const SUBST_DEFAULT = [
  ['BIN70024003AB', 'SAB [VF33/VN&US/FRT/RH]', 'KACL180010H1'], ['BIN70024004AB', 'SAB [VF33/VN&US/FRT/LH]', 'KACL180000H1'],
  ['BIN71024003AB', 'SAB [VF34/VN/FRT/RH]', 'KACL180010H1'], ['BIN71024004AB', 'SAB [VF34/VN/FRT/LH]', 'KACL180000H1'],
  ['BIN71024012AB', 'SAB [VF33&34/EU/RH]', 'KACL180010H1'], ['BIN71024013AB', 'SAB [VF33&34/EU/LH]', 'KACL180000H1'],
  ['BIN71024015AA', 'SAB [VF34s/US/LH]', 'KACL180000H1'], ['BIN71024014AA', 'SAB [VF34s/US/RH]', 'KACL180010H1'],
  ['BIN30024015AA', 'SAB [VF35/FRT/LH]', 'KACL180000H1'], ['BIN30024016AA', 'SAB [VF35/FRT/RH]', 'KACL180010H1'],
  ['BIN80024013AA', 'SAB [VF36/FRT/LH]', 'KACL180000H1'], ['BIN80024014AA', 'SAB [VF36/FRT/RH]', 'KACL180010H1']
].map(([fg, nm, neu]) => ({ fg, fgName: nm, neu, old: SUBST_OLD[neu] || '', from: '2026-10-27', sup: '신진', note: '진영전기 → 신진 하네스 변경 · MES REV 변경 (2026-10-27 생산분부터)' }));
/* [v0.53.103] 리드타임 직접 수정 : app_props 'mm_lead' = { overrides: { 품번키: { d: 일수, by, at, item } } }
   우선순위 = 화면에서 고친 값 → 품목 기준표(mm_item.lead_days · 원자재품목 코드등록 「납기가능일자」) → 기본값(해외 60 · 국내 30일) */
const LEAD_KEY = 'mm_lead';
async function leadOverrides() {
  try { const r = ((await db('GET', 'app_props?select=value&key=eq.' + LEAD_KEY + '&limit=1')).data || [])[0]; const v = r && r.value ? JSON.parse(r.value) : {}; return (v && v.overrides && typeof v.overrides === 'object') ? v.overrides : {}; } catch (e) { return {}; }
}
/* [v0.53.110] 휴면 재고 직접 지정 : app_props 'mm_dorm' = { overrides: { 품번키: { on: true(휴면으로) | false(휴면 아님), by, at } } } — 없으면 엔진 자동 판정 */
const DORM_KEY = 'mm_dorm';
async function dormOverrides() {
  try { const r = ((await db('GET', 'app_props?select=value&key=eq.' + DORM_KEY + '&limit=1')).data || [])[0]; const v = r && r.value ? JSON.parse(r.value) : {}; return (v && v.overrides && typeof v.overrides === 'object') ? v.overrides : {}; } catch (e) { return {}; }
}
/* [v0.53.115] 같은 자재 합치기 : app_props 'mm_alias' = { pairs: [{ from: 합칠 품번, to: 남길 품번(BOM 품번), note, by, at }] }
   같은 부품인데 BOM 과 수불부 · MES 입고의 품번이 달라(예 : BOM EEG010037H-1 · 입고 EEG010037H) 한쪽은 사용만 · 한쪽은 입고만 쌓이던 것을
   계산할 때 한 품번으로 합친다 (수불부 기말 · MES 입고 · 입고 기록 · 무상출고 · BOM 사용 모두) — 운영 자료(표)는 바꾸지 않는다 */
const ALIAS_KEY = 'mm_alias';
async function aliasList() {
  try { const r = ((await db('GET', 'app_props?select=value&key=eq.' + ALIAS_KEY + '&limit=1')).data || [])[0]; const v = r && r.value ? JSON.parse(r.value) : {}; return Array.isArray(v.pairs) ? v.pairs : []; } catch (e) { return []; }
}
async function aliasMap() { const o = {}; (await aliasList()).forEach(p => { const f = R.partKey(p.from), t = R.partKey(p.to); if (f && t && f !== t) o[f] = t; }); return o; }
async function substRules() {
  try {
    const r = ((await db('GET', 'app_props?select=value&key=eq.' + SUBST_KEY + '&limit=1')).data || [])[0];
    if (r && r.value) { const v = JSON.parse(r.value); if (Array.isArray(v)) return v.map(x => { const k = R.partKey(x && x.neu), to = SUBST_FIX[k]; return to ? Object.assign({}, x, { neu: to, old: x.old || SUBST_OLD[to] }) : x; }); }   /* [v0.53.69] 예전에 저장한 규칙의 잘못된 신진 품번도 바로잡아 읽는다 */
  } catch (e) {}
  return SUBST_DEFAULT;
}
/** 규칙을 BOM 에 맞춰 풀어 둠 : SUB[완성품 키] = [{ old 키들, neu 키, from }] · 화면용 풀이(info) */
function substPrepare(rules, B) {
  const SUB = {}, info = [];
  const descend = (fg, out, depth, seen) => { (B.CH[fg] || []).forEach(c => { out.add(c.k); if (B.CH[c.k] && depth < 8 && !seen.has(c.k)) { seen.add(c.k); descend(c.k, out, depth + 1, seen); } }); };
  rules.forEach(r => {
    const fg = R.partKey(r.fg || ''), neu = R.partKey(r.neu || ''), from = String(r.from || '').slice(0, 10);
    if (!fg || !neu || !/^\d{4}-\d{2}-\d{2}$/.test(from)) { info.push(Object.assign({}, r, { ok: false, why: '완성품 · 새 품번 · 적용일을 확인해 주세요' })); return; }
    const all = new Set(); descend(fg, all, 0, new Set());
    let olds = [];
    if (r.old) olds = String(r.old).split(/[,\s]+/).map(x => R.partKey(x)).filter(Boolean);
    else { const base = neu.replace(/H\d*$/i, ''); if (base.length >= 8) olds = [...all].filter(k => k !== neu && k.indexOf(base) === 0); }
    const inBom = olds.filter(k => all.has(k));
    const ok = !!B.CH[fg] && inBom.length > 0;
    if (ok) (SUB[fg] = SUB[fg] || []).push({ olds: new Set(inBom), neu, from });
    info.push(Object.assign({}, r, { fgKey: fg, neuKey: neu, olds: inBom, hasBom: !!B.CH[fg], neuInBom: all.has(neu), ok,
      why: !B.CH[fg] ? 'BOM 에 이 완성품이 없습니다' : !inBom.length ? (r.old ? '바꿀 품번이 이 완성품 BOM 에 없습니다' : '새 품번과 앞부분이 같은 자재가 BOM 에 없습니다 — 바꿀 품번을 직접 넣어 주세요') : '' }));
  });
  /* 펼친 자재 c 를 날짜 d 에 쓸 품번으로 (완성품 top 의 규칙) */
  const sub = (top, c, d) => { const L = SUB[top]; if (!L) return c; for (let i = 0; i < L.length; i++) { const x = L[i]; if (d >= x.from && x.olds.has(c)) return x.neu; } return c; };
  return { SUB, info, sub };
}
/* [v0.53.58] 매입처 이름 하나로 : '진영전기' · '진영전기(주)' · '(주)진영전기' · '㈜진영전기' · '진영전기 주식회사' 처럼 법인 표시 · 띄어쓰기만 다른 것은 같은 회사
   같은 회사의 여러 이름 중 가장 많이 쓰인 것(같으면 더 긴 것)을 화면 이름으로 — 원래 이름은 supRaw 에 남긴다 */
function supKey(n) { return String(n || '').replace(/\(주\)|㈜|\(유\)|㈲|주식회사|유한회사|\(株\)|株式会社|co\.?,?\s*ltd\.?|corp\.?|inc\.?/gi, '').replace(/[\s.,()·\-_]/g, '').toUpperCase(); }
function supUnify(mats) {
  const cnt = {};
  mats.forEach(m => { const n = String(m.sup || '').trim(); if (!n) return; const k = supKey(n); if (!k) return; const c = (cnt[k] = cnt[k] || {}); c[n] = (c[n] || 0) + 1; });
  const pick = {}; Object.keys(cnt).forEach(k => { pick[k] = Object.keys(cnt[k]).sort((a, b) => (cnt[k][b] - cnt[k][a]) || (b.length - a.length) || a.localeCompare(b))[0]; });
  mats.forEach(m => { const n = String(m.sup || '').trim(); if (!n) return; const k = supKey(n); if (pick[k] && pick[k] !== n) { m.supRaw = n; m.sup = pick[k]; } });
  return mats;
}
async function buildModel() {
  const t0 = Date.now();
  const lastBase = ((await db('GET', 'mm_base?select=base_month&order=base_month.desc&limit=1')).data || [])[0];
  if (!lastBase) { const e = new Error('기준 자료(mm_base)가 비어 있습니다. supabase_material_base_2608.sql 을 실행해 주세요.'); e.status = 404; throw e; }
  const baseMonth = lastBase.base_month;
  const BASE_DATE = baseDateOf(baseMonth), baseFrom = BASE_DATE.slice(0, 8) + '01', baseDays = +BASE_DATE.slice(8, 10);   // [v0.53.20] 이 계산의 기준일 (모듈 기본값을 가린다)
  const [base, items, imports, raw, bomRows, priceRows] = await Promise.all([
    getAll('mm_base', 'sheet,part_no,part_key,part_name,supplier,project,unit,open_qty,in_qty,out_qty,end_qty,end_amt,out_price', 'base_month=eq.' + baseMonth),
    getAll('mm_item', 'part_key,part_no,part_name,unit,spec,project,gubun,lead_days,sup_code,sup_name,box_qty,safe_wh,moq,is_import', null, 'part_key.asc', 'part_key'),
    getAll('mm_import', 'part_key,supplier,qty,in_amt'),
    /* [v0.53.20] 과거 이력(2023~)을 올려도 계산에 필요한 것만 : 기준 달 1일부터 (기준 달은 「데이터 점검」 개연성 대조용 · 재고 계산은 기준일 다음 날부터) */
    getAll('mm_raw', 'kind,row_date,part_key,part_no,part_name,cm_code,cm_name,status,part_type,qty', 'active=is.true&kind=in.(purchase,goods_sales)&row_date=gte.' + baseFrom),
    getAll('bom_rows', 'row'),
    getAll('price_rows', 'row')
  ]);
  /* [v0.53.20] 생산계획 : 기준 연도부터 내년까지 (예전 : 2026 · 2027 두 해로 고정 → 2027 하반기에 2028 계획이 빠질 뻔) */
  const Y = +BASE_DATE.slice(0, 4), Y2 = Math.max(Y + 1, +today().slice(0, 4) + 1), years = []; for (let y = Y; y <= Y2; y++) years.push(y);
  let planRaw = [];
  try { planRaw = await getAll('plan_raw', 'plan_year,plan_month,row_no,cells', 'plan_year=in.(' + years.join(',') + ')', 'plan_year.asc,row_no.asc', 'row_no'); } catch (e) { planRaw = []; planRaw.err = String(e.message || e); }

  /* [v0.53.115] 같은 자재 합치기 — 읽은 자료의 품번을 남길 품번으로 (수불부 · 품목 기준표 · 수입 · MES · BOM 아래 자재) */
  const ALI = await aliasMap(), AK = k => (k && ALI[k]) || k, ALINFO = {};
  if (Object.keys(ALI).length) {
    const note = (f, code, name) => { const t = ALI[f], L = ALINFO[t] || (ALINFO[t] = []); let x = L.find(y => y[0] === f); if (!x) { x = [f, '', '']; L.push(x); } x[1] = x[1] || S(code); x[2] = x[2] || S(name); };
    base.forEach(b => { if (ALI[b.part_key]) { note(b.part_key, b.part_no, b.part_name); b.part_key = ALI[b.part_key]; b.part_no = ''; b.part_name = ''; } });   /* 품번 · 품명은 남길 품번 것으로 (합친 품번 글자가 앞에 나오지 않게) */
    items.forEach(i => { if (ALI[i.part_key]) note(i.part_key, i.part_no, i.part_name); });
    imports.forEach(i => { i.part_key = AK(i.part_key); });
    raw.forEach(r => { if (ALI[r.part_key]) { note(r.part_key, r.part_no, r.part_name); r.part_key = ALI[r.part_key]; r.part_no = ''; r.part_name = ''; } });
    Object.keys(ALI).forEach(f => { if (!ALINFO[ALI[f]] || !ALINFO[ALI[f]].some(y => y[0] === f)) note(f, '', ''); });
  }
  const B = buildBom(bomRows);
  if (Object.keys(ALI).length) Object.keys(B.CH).forEach(p => { const m = {}; B.CH[p].forEach(c => { const k = AK(c.k); m[k] = (m[k] || 0) + c.q; }); B.CH[p] = Object.keys(m).map(k => ({ k, q: m[k] })); });   /* BOM 아래 자재도 남길 품번으로 (같은 완성품에 둘 다 있으면 더함) */
  const P = parsePlan(planRaw);
  /* [v0.53.6] VINFAST S/L = 롤링 S/L 화면과 똑같이 (최신 스냅샷 · 베트남 + 인도 통합) — api/material-sl.js */
  let ROLL = null;
  try { ROLL = await require('./material-sl').rolling(db, getAll); } catch (e) { ROLL = { err: String(e.message || e), regions: {}, mats: {} }; }
  /* 단가표 : 품번 → 화폐 · 업체 */
  const PRICE = {};
  priceRows.forEach(rec => { const r = rec.row || []; const k = AK(K(r[3])); if (!k || PRICE[k]) return; PRICE[k] = { cur: S(r[14]) || S(r[13]), vendor: S(r[2]), vcode: S(r[1]) }; });

  /* [v0.53.35] 생산실적 = 「생산실적」 업로드(production_raw · 본 화면)만 쓴다 — 자재관리 「제품생산」 업로드는 없앴다
     (같은 MES 2-1 보고서를 두 곳에서 올리면 자료가 꼬일 수 있어서 · 예전에 올린 mm_raw production 줄은 계산에서 쓰지 않음) */
  const prodMM = [];
  const mmMonths = {}; prodMM.forEach(r => { mmMonths[String(r.row_date).slice(0, 7)] = 1; });
  const wantMonths = []; { const end = today().slice(0, 7); let m = BASE_DATE.slice(0, 7); while (m <= end) { wantMonths.push(m); const [yy, mm] = m.split('-').map(Number); m = mm === 12 ? (yy + 1) + '-01' : yy + '-' + (mm + 1 < 10 ? '0' : '') + (mm + 1); } }
  const legacy = await legacyProduction(wantMonths).catch(() => ({ rows: [], months: [] }));
  const legDays = new Set(legacy.rows.map(r => r.row_date));
  const prodRows = legacy.rows.map(r => Object.assign({ src: 'legacy' }, r));
  const mmUsedDays = new Set(prodRows.filter(r => r.src === 'mm').map(r => r.row_date));
  const prodAug = prodRows.filter(r => r.row_date.slice(0, 7) === BASE_DATE.slice(0, 7));
  const prodAfter = prodRows.filter(r => r.row_date > BASE_DATE);
  // 실적 마지막 날 = 수량이 있는 마지막 날 (오늘을 넘지 않음 · MES 파일에 앞날짜 0 수량 줄이 섞여 있다)
  let actEnd = BASE_DATE; const T0 = today(); prodAfter.forEach(r => { if (r.qty > 0 && r.row_date > actEnd && r.row_date <= T0) actEnd = r.row_date; });

  /* 자재 표 */
  const M = {};
  const mat = k => M[k] || (M[k] = { k, code: '', name: '', unit: '', sup: '', proj: '', sheets: [], s0: null, open: 0, inq: 0, out8: 0, amt: 0, price: 0, inBase: false });
  base.forEach(b => {
    const m = mat(b.part_key); m.inBase = true;
    m.code = m.code || b.part_no; m.name = m.name || S(b.part_name); m.unit = m.unit || S(b.unit); m.sup = m.sup || S(b.supplier); m.proj = m.proj || S(b.project);
    m.s0 = (m.s0 || 0) + N(b.end_qty); m.open += N(b.open_qty); m.inq += N(b.in_qty); m.out8 += N(b.out_qty); m.amt += N(b.end_amt);
    if (N(b.out_price)) m.price = N(b.out_price);
    m.sheets.push([b.sheet, N(b.end_qty), N(b.out_qty), S(b.project)]);
  });
  const ITEM = {}; items.forEach(i => { const k = AK(i.part_key); if (!ITEM[k] || i.part_key === k) ITEM[k] = i; });   /* [v0.53.115] 합친 자재는 남길 품번의 기준표가 먼저 */
  const IMP = {}; imports.forEach(i => { IMP[i.part_key] = i; });

  const RCV = {}, PEND = {}, MADE = {}, SOLD = {}, USEA = {}, USEP = {}, LASTCM = {}, PST = {};   /* PST [v0.53.30] 확정 전 상태별 수량 (데이터 점검) */
  const received = new Set(R.RECEIVED);
  raw.forEach(r => {
    const d = String(r.row_date).slice(0, 10); if (d <= BASE_DATE) return;
    const q = N(r.qty); if (!q) return;
    if (r.kind === 'purchase') {
      const ret = /반품/.test(S(r.part_type)) || /반품/.test(S(r.status));
      const qq = ret ? -Math.abs(q) : q;
      if (!ret && R.EXCLUDED.indexOf(S(r.status)) > -1) return;           // 부적합 · 반려 : 재고에 넣지 않음
      addTo(RCV, r.part_key, d, qq);                                       // 반품은 빼고, 나머지는 모두 재고에 더함
      if (!ret && !received.has(S(r.status))) { addTo(PEND, r.part_key, d, qq); const st = S(r.status) || '(상태 없음)'; const o = PST[st] || (PST[st] = { n: 0, q: 0 }); o.n++; o.q += qq; }   // 그중 확정 전 상태 (확인 대기 — 재고에는 이미 더함 · 따로 표시)
      if (!LASTCM[r.part_key] || d >= LASTCM[r.part_key].d) LASTCM[r.part_key] = { d, name: S(r.cm_name), code: S(r.cm_code) };
      mat(r.part_key); if (!M[r.part_key].code) { M[r.part_key].code = r.part_no; M[r.part_key].name = S(r.part_name); }
    } else if (r.kind === 'goods_sales') addTo(SOLD, r.part_key, d, q);
  });
  /* [v0.53.110] 모품번(완성품) 연결 : 품번 키는 이미 띄어쓰기 · '-' 를 빼고 맞추지만(R.partKey), 자료마다 다른 구분 글자
     (– — ‐ － _ . / 등)가 섞여도 숫자 · 영문만 같으면 BOM 완성품으로 잇는다. BOM 에 똑같은 키가 없을 때만 · 숫자 · 영문이 같은 BOM 완성품이 둘 이상이면 잇지 않는다 */
  const BALIAS = {};
  { const sk = k => String(k || '').toUpperCase().replace(/[^0-9A-Z가-힣]/g, ''), idx = {};
    Object.keys(B.CH).forEach(k => { const s = sk(k); if (s) idx[s] = idx[s] === undefined ? k : null; });
    const link = k => { if (!k || B.CH[k]) return; const a = idx[sk(k)]; if (!a) return; B.CH[k] = B.CH[a]; if (!B.NAME[k] && B.NAME[a]) B.NAME[k] = B.NAME[a]; BALIAS[k] = a; };
    prodRows.forEach(r => link(r.part_key)); P.rows.forEach(p => link(p.k)); Object.keys((ROLL && ROLL.mats) || {}).forEach(link); }
  /* 실적 전개 */
  const SUBR = substPrepare(await substRules(), B), sub = SUBR.sub;   /* [v0.53.57] 품번 변경 규칙 */
  const LEADO = await leadOverrides();   /* [v0.53.103] 화면에서 고친 리드타임 */
  const DORMO = await dormOverrides();   /* [v0.53.110] 화면에서 정한 휴면 */
  const ownA = new Set(prodAfter.map(r => r.part_key));
  prodAfter.forEach(r => {
    if (!r.qty) return;
    addTo(MADE, r.part_key, r.row_date, r.qty);
    explode(B, r.part_key, r.qty, (c, amt) => addTo(USEA, sub(r.part_key, c, r.row_date), r.row_date, amt), ownA, 0, [r.part_key]);
  });
  /* 계획 전개 (실적이 끝난 다음 날부터) */
  const planFuture = P.rows.filter(p => p.d > actEnd);
  const mesEnd = P.info.to || actEnd;
  /* [v0.53.6] 생산계획이 없는 기간의 수요 = 롤링 S/L (최신 · VN + IN 통합)
     · 창 : 완성품에 MES 계획이 있으면 MES 계획 끝 다음 날부터, 없으면 실적 다음 날부터 3개월
     · 창 안의 S/L 수량(O열 · K열 날짜 · FIRM+FRC)은 그 날짜에 그대로
     · 백오더(PAST : L열 · I열 M-2~M-1 · FIRM · 취소 공백)는 창 안 평일에 똑같이 나눠 얹는다
     · 계획 마지막 28일 평균으로 이어 가던 방식은 없앴다 (창이 끝나면 수요 0) */
  const addD = (s, n) => new Date(Date.parse(s + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
  const addM = (s, n) => { const y = +s.slice(0, 4), m = +s.slice(5, 7) - 1 + n, d = +s.slice(8, 10); const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate(); return new Date(Date.UTC(y, m, Math.min(d, last))).toISOString().slice(0, 10); };
  const SL = [], slInfo = { snaps: ROLL.regions || {}, err: ROLL.err || '', items: Object.keys(ROLL.mats || {}).length, used: 0, from: null, to: null, bo: ROLL.boTotal || 0, boUsed: 0, qty: 0, withBom: 0, applied: 0, months: ROLL.months || [] };
  /* [v0.53.44] VINFAST : 완성품마다 「자기」 MES 생산계획이 있는 마지막 날까지는 생산계획, 그다음 날부터는 S/L 오더(VN + IN 합)를 S/L 이 있는 데까지 모두
     (예전 : 생산계획 전체의 끝날 · 3개월까지만 — 제 계획이 먼저 끝난 완성품은 그 사이 수요가 비었다)
     백오더는 지금처럼 그 뒤 3개월 평일에 나눠 재고 계산에 넣고, 자재마다 백오더 몫(BO)을 따로 알려 준다 → 발주계획 자동 채우기에서 넣을지 · 달마다 몇 % 를 고른다 */
  { const planEndOf = {}; P.rows.forEach(p => { if (!planEndOf[p.k] || p.d > planEndOf[p.k]) planEndOf[p.k] = p.d; });
    Object.keys(ROLL.mats || {}).forEach(k => {
      const R0 = ROLL.mats[k];
      if (!B.CH[k]) return;
      slInfo.withBom++;
      const cut = planEndOf[k] && planEndOf[k] > actEnd ? planEndOf[k] : actEnd, end = addM(cut, 3);
      let any = false;
      Object.keys(R0.days).forEach(d => { if (d > cut && R0.days[d]) { SL.push({ k, code: R0.code, d, q: R0.days[d], src: 'S/L' }); slInfo.qty += R0.days[d]; any = true; } });
      if (R0.bo) {
        const wd = []; for (let d = addD(cut, 1); d <= end; d = addD(d, 1)) { const w = new Date(d + 'T00:00:00Z').getUTCDay(); if (w !== 0 && w !== 6) wd.push(d); }
        if (wd.length) {   // 정수로 나눠 합이 백오더와 정확히 같게 : 몫은 모든 평일에, 나머지는 앞쪽 평일에 1개씩 (소수 끝자리는 마지막 날)
          const whole = Math.floor(R0.bo), base = Math.floor(whole / wd.length); let rem = whole - base * wd.length;
          wd.forEach((d, i) => { let q = base + (rem > 0 ? 1 : 0); if (rem > 0) rem--; if (i === wd.length - 1) q += R0.bo - whole; if (q) SL.push({ k, code: R0.code, d, q, src: 'BO' }); });
          slInfo.boUsed += R0.bo; slInfo.qty += R0.bo; any = true;
        }
      }
      if (any) slInfo.applied++;
    });
    SL.forEach(x => { if (!slInfo.from || x.d < slInfo.from) slInfo.from = x.d; if (!slInfo.to || x.d > slInfo.to) slInfo.to = x.d; });
    slInfo.used = SL.length; }
  /* [v0.53.5] 사용 예측은 생산실적 + MES 생산계획만으로 한다. VINFAST S/L 은 주마다 변동이 커서 계산에 넣지 않고
     완성품 상세 그래프에 '참고' 로만 보여 준다 (사용자 판단 2026-10-22) */
  const ownP = new Set(planFuture.map(p => p.k).concat(SL.map(x => x.k)));
  planFuture.forEach(p => explode(B, p.k, p.q, (c, amt) => addTo(USEP, sub(p.k, c, p.d), p.d, amt), ownP, 0, [p.k]));
  const USEBO = {};   /* [v0.53.44] 자재마다 백오더 몫 (날짜별) — 화면이 빼거나 달마다 % 로 다시 나눌 수 있게 */
  SL.forEach(x => explode(B, x.k, x.q, (c, amt) => { const c2 = sub(x.k, c, x.d); addTo(USEP, c2, x.d, amt); if (x.src === 'BO') addTo(USEBO, c2, x.d, amt); }, ownP, 0, [x.k]));   // [v0.53.6] 계획 없는 기간 = 롤링 S/L

  /* 완성품 (계획 또는 실적이 있는 품번 중 BOM 이 있는 것) */
  const PROD = {};
  const prod = (k, code, name) => PROD[k] || (PROD[k] = { k, code, name, line: '', plan: {}, act: {}, sl: {}, kids: null, cat: '' });
  SL.forEach(x => { if (!B.CH[x.k]) return; const p = prod(x.k, x.code, B.NAME[x.k] || ''); p.line = p.line || 'VINFAST S/L'; p.sl[x.d] = (p.sl[x.d] || 0) + x.q; if (x.src === 'BO') p.bo = (p.bo || 0) + x.q; });
  P.rows.forEach(p => { if (!B.CH[p.k]) return; const x = prod(p.k, p.code, p.name || B.NAME[p.k]); x.line = x.line || p.line; if (p.d > actEnd) x.plan[p.d] = (x.plan[p.d] || 0) + p.q; });
  prodAfter.forEach(r => { if (!B.CH[r.part_key]) return; const x = prod(r.part_key, r.part_no, r.part_name || B.NAME[r.part_key]); x.act[r.row_date] = (x.act[r.row_date] || 0) + r.qty; x.cat = x.cat || String(r.status || '').replace(/[()]/g, '').replace('생산', ''); x.line = x.line || S(r.cm_name); });
  /* 자재 목록 마무리 : 기준 자료가 있거나, BOM 수요가 생기면서 품목 기준표 · 입고 기록이 있는 품번 */
  /* [v0.53.36] BOM 으로 쓰는 자재는 수불부 · 품목 기준표 · 입고 기록이 없어도 모두 자재 목록에 넣는다 (상태 '미확인')
     — 예전에는 셋 다 없으면 목록 · 사용량 계산에서 통째로 빠져 어디에도 안 보였다 (누락 위험) */
  let addedNoSrc = 0;
  Object.keys(USEA).concat(Object.keys(USEP)).forEach(k => { if (!M[k]) { mat(k); if (!(ITEM[k] || RCV[k] || PEND[k])) addedNoSrc++; } });
  Object.values(PROD).forEach(x => {
    const v = {}, T1 = today(); explode(B, x.k, 1, (c, amt) => { const c2 = sub(x.k, c, T1); if (M[c2]) v[c2] = (v[c2] || 0) + amt; }, ownP, 0, [x.k]);   /* 오늘 기준 BOM (규칙 반영) */
    x.kids = Object.keys(v).map(c => [c, Math.round(v[c] * 10000) / 10000]);
    x.plan = toPairs(x.plan); x.act = toPairs(x.act); x.sl = toPairs(x.sl);
  });
  const usedIn = {}; Object.values(PROD).forEach(x => x.kids.forEach(([c]) => { (usedIn[c] = usedIn[c] || []).push(x.k); }));
  FIND = { B, M, ITEM, IMP, RCV, PEND, USEA, USEP, PROD, ownP, base };   /* [v0.53.36] 품번 찾기 (데이터 점검) */
  /* [v0.53.27] 자재관리 화면에서 적은 것 (mm_inbound — MES 업로드와 따로 보관되어 MES 를 다시 올려도 그대로 남는다)
     · 입고 확인(kind rcv) = 실제로 들어온 입고 → 그 날짜의 입고로 더한다 (MES 입고와 같은 줄에)
     · 보유수량 맞추기(kind count) = 그날 실제 보유 수량 → 그날부터는 이 수량에서 다시 셈 (엔진 cnt)
     · 입고 예정(kind plan) 은 화면에서만 앞날에 더한다 (여기서는 넣지 않음) · 기준일 이전 날짜는 기준 재고에 이미 들어 있으므로 뺀다 */
  const RCVM = {}, CNT = {}, PLN = {}, LATE = {}, SHIP = {}; let inbErr = '';   /* SHIP [v0.53.111] 협력사 발송 기록 */   /* LATE [v0.53.98] 예정일이 지났는데 MES · 입고 확인이 없는 입고 예정 (계산에는 안 넣음 · 메일 표시용) */   /* PLN [v0.53.29] 입고 예정 (오늘 이후 · MES 반영 안 된 것) → 소진 예상 · 발주 필요일 · 상태에 반영 (대시보드 · 메일 · 자재관리 모두 같게) */
  const mergeAdd = (a, b) => { if (!b) return a; const o = Object.assign({}, a || {}); Object.keys(b).forEach(d => { o[d] = (o[d] || 0) + b[d]; }); return o; };
  try {
    let ib;
    try { ib = await getAll('mm_inbound', 'id,part_key,kind,due,qty,act_date,act_qty,done,created_at,ship_plan,ship_date,ship_no', '', 'id.asc'); }   /* [v0.53.111] 발송 칸 */
    catch (eS) { try { ib = await getAll('mm_inbound', 'id,part_key,kind,due,qty,act_date,act_qty,done,created_at', '', 'id.asc'); }   /* 발송 칸 SQL 전 */
    catch (e0) { ib = (await getAll('mm_inbound', 'id,part_key,due,qty,done', '', 'id.asc')).map(r => Object.assign({ kind: 'plan' }, r)); } }   // v0.53.27 칸이 아직 없으면 모두 입고 예정
    const td = today(), IBR = {};
    ib.forEach(r => { const k = AK(S(r.part_key)); if (!k) return;   /* [v0.53.115] 합친 품번의 입고 기록도 남길 품번으로 */
      if ((r.kind || 'plan') === 'plan' || r.kind === 'rcv') (IBR[k] = IBR[k] || []).push({ id: r.id, kind: r.kind || 'plan', due: String(r.due || '').slice(0, 10), qty: N(r.qty), adate: String(r.act_date || '').slice(0, 10), aqty: r.act_qty == null || r.act_qty === '' ? null : N(r.act_qty), done: !!r.done, cat: kstDay(r.created_at), ship: r.ship_plan || r.ship_date ? { plan: String(r.ship_plan || '').slice(0, 10), date: String(r.ship_date || '').slice(0, 10), no: S(r.ship_no) } : null });
      else if (r.kind === 'count') { const d = String(r.due || '').slice(0, 10); if (d > BASE_DATE && d <= today()) (CNT[k] = CNT[k] || []).push([d, N(r.qty)]); } });
    /* [v0.53.95] MES 매입과 화면 기록(입고 확인 · 입고 예정)을 자동으로 맞춰 같은 입고를 두 번 세지 않는다 (화면 · 메일 · AI 같은 엔진 함수) */
    Object.keys(IBR).forEach(k => { const x = ENG.reconcile(toPairs(RCV[k]), IBR[k], td, BASE_DATE); if (Object.keys(x.rcv).length) RCVM[k] = x.rcv; if (x.pln.length) PLN[k] = x.pln;
      /* [v0.53.111] 아직 안 들어온 입고 예정의 발송 기록 [예정일, 출발 예정일, 실제 출발일, 운송장, 남은 수량] → 메일 · AI */
      const sh = IBR[k].filter(r => r.kind === 'plan' && !r.done && r.ship && Math.abs(x.left[r.id] || 0) > 1e-9).map(r => [r.due, r.ship.plan, r.ship.date, r.ship.no, Math.round(x.left[r.id] * 1000) / 1000]); if (sh.length) SHIP[k] = sh.sort((a, b) => a[0] < b[0] ? -1 : 1);
      const lt = IBR[k].filter(r => r.kind === 'plan' && !r.done && r.due && r.due < td && N(r.qty) > 0 && (x.left[r.id] || 0) > 1e-9).map(r => [r.due, Math.round(x.left[r.id] * 1000) / 1000]); if (lt.length) LATE[k] = lt.sort((a, b) => a[0] < b[0] ? -1 : 1); });
  } catch (e) { inbErr = String(e.message || e).slice(0, 160); }
  /* [v0.53.105] 무상출고요청 (mm_free_req) : 출고 완료 날짜 · 처리 전 요청 수 → 엔진이 무상출고로 쓰는 자재를 휴면으로 보지 않는다 (표가 없으면 건너뜀) */
  const FREE = {};
  try { (await getAll('mm_free_req', 'part_key,status,out_date,supply_date,need_date', 'status=in.(wait,ack,done)', 'id.asc')).forEach(r => { const k = AK(S(r.part_key)); if (!k) return; const f = FREE[k] || (FREE[k] = { d: new Set(), open: 0 }); if (r.status === 'done') { const d = String(r.out_date || r.supply_date || r.need_date || '').slice(0, 10); if (d) f.d.add(d); } else f.open++; });   /* 출고일이 비면 공급 가능일 → 필요일 (재고 반영과 같은 순서) */ } catch (e) {}
  const SUBTO = {}, SUBFROM = {};   /* [v0.53.57] 자재마다 : 이 자재가 바뀌어 나간 곳 · 이 자재가 대신하는 것 */
  SUBR.info.filter(x => x.ok).forEach(x => { x.olds.forEach(o => { const a = (SUBTO[o] = SUBTO[o] || { to: x.neuKey, from: x.from, fgs: [], note: x.note }); a.fgs.push(x.fgKey); }); const b = (SUBFROM[x.neuKey] = SUBFROM[x.neuKey] || { olds: [], from: x.from, fgs: [], note: x.note, sup: x.sup || '' }); x.olds.forEach(o => { if (b.olds.indexOf(o) < 0) b.olds.push(o); }); b.fgs.push(x.fgKey); });
  const mats = Object.values(M).map(m => {
    const it = ITEM[m.k] || {}, pr = PRICE[m.k] || {}, im = IMP[m.k], lc = LASTCM[m.k] || {};
    const supName = R.whSupOf(m.k) || R.whSupOf(m.code) || S(it.sup_name) || S(pr.vendor) || S(B.VEND[m.k]) || S(lc.name) || m.sup;   /* [v0.53.69] 와이어하네스는 품번으로 매입처를 정한다 (신진 · 진영전기) */
    let region = '국내', why = '';
    if (it.is_import) { region = '해외'; why = '품목 기준표 주매입처 · 8월 수입자재'; }
    else if (im) { region = '해외'; why = '8월 수입자재 목록'; }
    else if (pr.cur && !/KRW|원|^₩$/i.test(pr.cur)) { region = '해외'; why = '매입단가 화폐 ' + pr.cur; }
    else if (foreignName(supName)) { region = '해외'; why = '해외 매입처 ' + supName; }
    const leadM = N(it.lead_days), lo = LEADO[m.k] && N(LEADO[m.k].d) > 0 ? LEADO[m.k] : null;
    const txtAll = [m.name, m.proj, S(it.project), S(it.part_name)].join(' ');
    return {
      k: m.k, code: m.code || (it.part_key && it.part_key !== m.k ? '' : S(it.part_no)) || (SUBFROM[m.k] || ALINFO[m.k] ? m.k : ''), name: m.name || S(it.part_name) || B.NAME[m.k] || (SUBFROM[m.k] ? (B.NAME[SUBFROM[m.k].olds[0]] || '') + ' (' + (SUBFROM[m.k].sup || '새 품번') + ')' : ''), unit: m.unit || S(it.unit) || B.UM[m.k] || (SUBFROM[m.k] ? B.UM[SUBFROM[m.k].olds[0]] || '' : ''),
      sup: supName || (SUBFROM[m.k] ? SUBFROM[m.k].sup : ''), substTo: SUBTO[m.k] || null, substFrom: SUBFROM[m.k] || null, supCode: S(it.sup_code) || S(lc.code), proj: m.proj || S(it.project), gubun: S(it.gubun) || (m.sheets.some(s => s[0] === '상품') ? '상품' : ''),
      region, regionWhy: why, jg: /(^|[^A-Z])JG([^A-Z]|$)|\[JG/i.test(txtAll),
      lead: lo ? N(lo.d) : leadM > 0 ? leadM : (region === '해외' ? 60 : 30), leadAssumed: !lo && !(leadM > 0),
      ...(lo ? { leadSrc: 'edit', leadItem: leadM > 0 ? leadM : null, leadBy: S(lo.by), leadAt: S(lo.at) } : {}),
      ...(DORMO[m.k] && typeof DORMO[m.k].on === 'boolean' ? { dormOv: DORMO[m.k].on, dormBy: S(DORMO[m.k].by), dormAt: S(DORMO[m.k].at) } : {}),   /* [v0.53.110] 휴면 직접 지정 (지정한 자재에만) */   /* [v0.53.103] 고친 자재에만 (기준표 값 · 누가 · 언제) */
      safe: N(it.safe_wh), moq: N(it.moq), box: N(it.box_qty),
      ...(FREE[m.k] ? { frd: [...FREE[m.k].d].sort(), fro: FREE[m.k].open } : {}),
      ...(ALINFO[m.k] ? { aliasOf: ALINFO[m.k] } : {}),   /* [v0.53.115] 이 자재로 합친 품번 [키, 품번, 품명] */   /* [v0.53.105] 무상출고 출고일 · 처리 전 요청 수 */
      inBase: m.inBase, s0: m.inBase ? m.s0 : null, open8: m.open, in8: m.inq, out8: m.out8, amt8: m.amt, price: m.price, sheets: m.sheets,
      bom: !!(USEA[m.k] || USEP[m.k] || usedIn[m.k]), usedIn: usedIn[m.k] || [],
      rcv: toPairs(mergeAdd(RCV[m.k], RCVM[m.k])), rcvM: toPairs(RCVM[m.k]), cnt: (CNT[m.k] || []).sort((a, b) => a[0] < b[0] ? -1 : 1), pln: (PLN[m.k] || []).sort((a, b) => a[0] < b[0] ? -1 : 1), pend: toPairs(PEND[m.k]), bo: toPairs(USEBO[m.k]), made: toPairs(MADE[m.k]), sold: toPairs(SOLD[m.k]), useA: toPairs(USEA[m.k]), useP: toPairs(USEP[m.k])
    };
  });

  mats.forEach(m => { if (LATE[m.k]) m.plnLate = LATE[m.k]; if (SHIP[m.k]) m.ship = SHIP[m.k]; });   /* [v0.53.98] 있는 자재에만 · [v0.53.111] 발송 기록 */
  /* 데이터 점검 (개연성) */
  const baseKeys = new Set(base.map(b => b.part_key));
  const childKeys = new Set(); Object.values(B.CH).forEach(l => l.forEach(c => childKeys.add(c.k)));
  const leafKeys = [...childKeys].filter(k => !B.CH[k]);
  const pct = (a, b) => (b ? Math.round(a / b * 1000) / 10 : null);
  const unitBad = [];
  leafKeys.forEach(k => { const a = R.hn(B.UM[k]), b = R.hn((ITEM[k] || {}).unit || (M[k] || {}).unit); if (a && b && a !== b && unitBad.length < 40) unitBad.push([k, (M[k] || {}).code || k, B.NAME[k] || '', B.UM[k], (ITEM[k] || {}).unit || (M[k] || {}).unit]); });
  // 8월 개연성 : 8월 생산실적 × BOM ≈ 8월 수불부 출고 인지
  const AUG = {}; const ownAug = new Set(prodAug.map(r => r.part_key));
  prodAug.forEach(r => explode(B, r.part_key, N(r.qty), (c, amt) => { AUG[c] = (AUG[c] || 0) + amt; }, ownAug, 0, [r.part_key]));
  const cmp = []; const bucket = { ok: 0, low: 0, high: 0, onlyBom: 0, onlyLedger: 0 };
  const outByKey = {}; base.forEach(b => { outByKey[b.part_key] = (outByKey[b.part_key] || 0) + N(b.out_qty); });
  if (prodAug.length) {
    Object.keys(outByKey).forEach(k => {
      const led = outByKey[k], bom = AUG[k] || 0;
      if (!led && !bom) return;
      if (!childKeys.has(k)) { if (led) bucket.onlyLedger++; return; }
      if (!led) { bucket.onlyBom++; return; }
      const ratio = bom / led;
      if (ratio >= 0.8 && ratio <= 1.2) bucket.ok++; else if (ratio < 0.8) bucket.low++; else bucket.high++;
      cmp.push([k, (M[k] || {}).code || k, (M[k] || {}).name || '', Math.round(led), Math.round(bom), Math.round(ratio * 100) / 100]);
    });
    cmp.sort((a, b) => Math.abs(Math.log((b[5] || 0.001))) - Math.abs(Math.log((a[5] || 0.001))));
  }
  const planKeys = new Set(P.rows.map(p => p.k)), prodKeys = new Set(prodAfter.map(r => r.part_key));
  const purKeys = new Set(raw.filter(r => r.kind === 'purchase').map(r => r.part_key));
  const diag = {
    builtAt: new Date().toISOString(), ms: Date.now() - t0, baseMonth, baseDate: BASE_DATE, actEnd,
    tables: { mm_base: base.length, mm_item: items.length, mm_import: imports.length, mm_raw: raw.length, bom_rows: bomRows.missing ? -1 : bomRows.length, price_rows: priceRows.missing ? -1 : priceRows.length, plan_raw: planRaw.length, planErr: planRaw.err || '' },
    bom: Object.assign({}, B.info, { alias: Object.keys(BALIAS).map(k => [k, BALIAS[k]]).slice(0, 40) }, { depthAgreePct: pct(B.info.depthAgree, B.info.depthChecked), depthSelfPct: pct(B.info.depthSelf, B.info.depthChecked), leaf: leafKeys.length, leafInBase: leafKeys.filter(k => baseKeys.has(k)).length, leafInItem: leafKeys.filter(k => ITEM[k]).length, baseUsed: [...baseKeys].filter(k => childKeys.has(k)).length, baseTotal: baseKeys.size, unitBad }),
    plan: Object.assign({}, P.info, { withBom: [...planKeys].filter(k => B.CH[k]).length, futureRows: planFuture.length, noBom: [...planKeys].filter(k => !B.CH[k]).slice(0, 40).map(k => { const p = P.rows.find(x => x.k === k); return [p.code, p.name, p.line]; }) }),
    addedNoSrc,
    prod: { mmRows: prodMM.length, mmMonths: Object.keys(mmMonths).sort(), mmUsedDays: mmUsedDays.size, legacyDays: legDays.size, legacyLast: [...legDays].sort().pop() || '', legacyMonths: legacy.months, legacyRows: legacy.rows.length, items: prodKeys.size, withBom: [...prodKeys].filter(k => B.CH[k]).length, augRows: prodAug.length },
    sl: slInfo,
    purchase: { rows: raw.filter(r => r.kind === 'purchase').length, items: purKeys.size, inBase: [...purKeys].filter(k => baseKeys.has(k)).length, pendSt: Object.keys(PST).map(k => [k, PST[k].n, Math.round(PST[k].q)]).sort((a, b) => b[2] - a[2]), received: R.RECEIVED },
    aug: { checked: cmp.length, bucket, worst: cmp.slice(0, 60) },
    products: Object.keys(PROD).length, materials: mats.length
  };
  /* 상품매출 실적이 덮는 마지막 날 = 올린 파일 기간 끝 (오늘을 넘지 않음) — 그 뒤부터 하루 평균으로 이어 간다 */
  let soldEnd = BASE_DATE;
  try { const ups = (await db('GET', 'mm_upload?select=period_to&kind=eq.goods_sales&status=eq.done&order=period_to.desc&limit=1')).data || []; if (ups[0] && ups[0].period_to) soldEnd = String(ups[0].period_to).slice(0, 10); } catch (e) {}
  if (soldEnd > T0) soldEnd = T0;
  /* [v0.53.98] MES 입고(협력사 매입) 자료 끝 = 올린 파일 기간 끝 (없으면 입고 줄의 마지막 날 · 오늘을 넘지 않음) */
  let rcvEnd = '';
  try { const ups = (await db('GET', 'mm_upload?select=period_to&kind=eq.purchase&status=eq.done&order=period_to.desc&limit=1')).data || []; if (ups[0] && ups[0].period_to) rcvEnd = String(ups[0].period_to).slice(0, 10); } catch (e) {}
  if (!rcvEnd) raw.forEach(r => { const d = String(r.row_date || '').slice(0, 10); if (r.kind === 'purchase' && d > rcvEnd) rcvEnd = d; });
  if (rcvEnd > T0) rcvEnd = T0;
  const CM = await custMaster();
  return { ok: true, custMap: CM.map, custStat: CM.n, baseDate: BASE_DATE, baseMonth: BASE_DATE.slice(0, 7), baseDays, actEnd, soldEnd, rcvEnd, mesEnd, slEnd: slInfo.to, planEnd: [P.info.to, slInfo.to].filter(Boolean).sort().pop() || null, today: today(), materials: supUnify(mats), products: Object.values(PROD), subst: SUBR.info, diag };
}
/* [v0.53.1] 빠르게 · 늘 최신으로
   · 계산 결과(모델)를 서버 메모리에 한 벌 두고 모든 사람이 같은 것을 받는다 (사람 · 컴퓨터마다 따로 계산하지 않음)
   · 낡은 결과를 주지 않는 두 겹 장치
     ① 저장 신호 : 서버를 거치는 모든 저장(자재관리 업로드 · BOM 관리 수정 · 생산계획 · 생산실적 업로드)은 바뀐 표 이름을 알린다(lib/events).
        재료 표가 바뀌면 세대(GEN)를 올려 예전 결과를 버리고, 3초 뒤 미리 다시 계산해 둔다 → 다음 사람은 기다리지 않는다
     ② 지문 대조 : 요청마다 재료 표의 줄 수 · 마지막 번호를 확인해(가벼운 조회) 계산할 때와 다르면 다시 계산한다
        (SQL 편집기처럼 서버를 거치지 않은 변경도 잡는다)
   · 브라우저 : ETag = 결과 버전. 화면은 늘 서버에 확인하고(no-cache), 바뀐 게 없으면 304 로 내려받기를 건너뛴다 */
const WATCH = /^(mm_base|mm_item|mm_import|mm_raw|mm_upload|bom_rows|price_rows|plan_raw|production_raw|production_meta|sl_full|sl_snapshot)$/;
const FP_TABLES = [['mm_inbound', 'updated_at'], ['mm_free_req', 'updated_at'], ['integrated_raw', 'id'], ['unit_price', 'id'], ['mm_base', 'id'], ['mm_item', 'part_key', true], ['mm_import', 'id'], ['mm_upload', 'id'], ['mm_raw', 'id'], ['bom_rows', 'id'], ['price_rows', 'id'], ['plan_raw', 'row_no', true], ['production_raw', 'row_no', true], ['production_meta', 'prod_year', true], ['sl_full', 'id'], ['sl_snapshot', 'id']];
let CACHE = null, BUILDING = null, GEN = 0, WARM = null, FIND = null;
/* [v0.53.36] 품번 찾기 : 어떤 품번이 자재관리에 왜 보이는지 / 안 보이는지 (자료마다 있는지 · 이름 · 인플레이터 · OPW · 와이어하네스 판정) */
const HW_FIND = /(^|[^A-Z])(NUT|BOLT|BRKT|BRACKET|WASHER|SCREW|HOLDER|CAP|COVER|PIN|CLIP|RING|TAPE|SHIM|SPACER|PLATE|STUD)([^A-Z]|$)/i;
async function findPart(q) {
  await model(false);
  const F = FIND; if (!F) throw new Error('계산 자료가 아직 없습니다. 잠시 뒤 다시 해 주세요.');
  const raw = String(q || '').trim(); if (!raw) throw new Error('품번을 넣어 주세요.');
  const key = K(raw), all = new Set(Object.keys(F.M).concat(Object.keys(F.B.CH), Object.keys(F.ITEM), Object.keys(F.PROD)));
  Object.values(F.B.CH).forEach(l => l.forEach(c => all.add(c.k)));
  const hit = all.has(key) ? key : null;
  const core = key.replace(/[^A-Z0-9]/g, '');
  const similar = [...all].filter(k => k !== key && (k.replace(/[^A-Z0-9]/g, '').indexOf(core.slice(0, 9)) === 0 || k.indexOf(key) > -1 || key.indexOf(k) === 0 && k.length >= 8)).slice(0, 12)
    .map(k => ({ k, name: (F.M[k] && F.M[k].name) || F.B.NAME[k] || (F.ITEM[k] && F.ITEM[k].part_name) || '' }));
  if (!hit) return { q: raw, key, found: false, similar };
  const k = hit, m = F.M[k], it = F.ITEM[k], parents = [];
  Object.keys(F.B.CH).forEach(t => { const c = F.B.CH[t].find(x => x.k === k); if (c) parents.push({ k: t, name: F.B.NAME[t] || '', q: c.q }); });
  const baseRows = (F.base || []).filter(b => b.part_key === k).map(b => ({ sheet: b.sheet, name: S(b.part_name), end: N(b.end_qty) }));
  const names = { 수불부: baseRows[0] ? baseRows[0].name : '', 품목기준표: it ? S(it.part_name) : '', BOM: F.B.NAME[k] || '' };
  const nm = (m && m.name) || names.수불부 || names.품목기준표 || names.BOM || '';
  const infName = /INFLATOR|인플레이터/i.test(nm), hw = (nm.match(HW_FIND) || [])[2] || '';
  const mat = (CACHE && CACHE.data.materials || []).find(x => x.k === k) || null;
  return {
    q: raw, key: k, found: true, similar,
    names, nameUsed: nm,
    inMaterials: !!mat, children: (F.B.CH[k] || []).length, ownPlan: F.ownP.has(k), parents: parents.slice(0, 30), parentCount: parents.length,
    inBase: baseRows.length > 0, baseRows, inItem: !!it, item: it ? { lead: N(it.lead_days), imp: !!it.is_import, sup: S(it.sup_name) } : null,
    rcv: Object.keys(F.RCV[k] || {}).length, pend: Object.keys(F.PEND[k] || {}).length, useA: Object.keys(F.USEA[k] || {}).length, useP: Object.keys(F.USEP[k] || {}).length,
    product: F.PROD[k] ? { plan: Object.keys(F.PROD[k].plan || {}).length, act: Object.keys(F.PROD[k].act || {}).length } : null,
    inf: { nameHas: infName, hwWord: hw, key: /^K?A[A-E][A-Z]26\d{4}[A-Z]$/.test(k.replace(/[^A-Z0-9]/g, '')), result: /^K?A[A-E][A-Z]26\d{4}[A-Z]$/.test(k.replace(/[^A-Z0-9]/g, '')) },   /* [v0.53.36] 주요 인플레이터 = 품번 규칙 */
    region: mat ? mat.region : '', regionWhy: mat ? mat.regionWhy : ''
  };
}
try {
  require('../lib/events').onChange(t => {
    if (!WATCH.test(String(t || ''))) return;
    GEN++;
    clearTimeout(WARM); WARM = setTimeout(() => { model().catch(() => {}); }, 3000);   // 미리 다시 계산
  });
} catch (e) {}
async function fpOne(t, col, countOnly) {
  try {
    const r = await db('GET', t + '?select=' + col + (countOnly ? '' : '&order=' + col + '.desc') + '&limit=1', null, 'count=exact');
    return t + ':' + countOf(r.headers) + ':' + (countOnly ? '' : (((r.data || [])[0] || {})[col] || ''));
  } catch (e) { return t + ':x'; }
}
let FP_RUN = null;
async function fingerprint() {
  if (FP_RUN) return FP_RUN;   // 같은 순간 몰린 요청은 확인 하나를 같이 기다린다 (끝난 결과를 다시 쓰지는 않는다)
  FP_RUN = (async () => (await Promise.all(FP_TABLES.map(x => fpOne(x[0], x[1], x[2])))).join('|'))().finally(() => { FP_RUN = null; });
  return FP_RUN;
}
/* [v0.53.98] 계산 결과는 한국 날짜가 같을 때만 다시 쓴다 — 오늘 날짜로 정하는 값(입고 예정 · 지연 · 실적 끝 · 품번 변경 규칙)이 있어서
   자료가 안 바뀐 채 날이 바뀌어도(주말 · 연휴 · 아침 자동 메일) 그날 기준으로 새로 계산한다 */
async function model(force) {
  const fp = await fingerprint(), day = today();
  if (!force && CACHE && CACHE.gen === GEN && CACHE.fp === fp && CACHE.day === day) return CACHE;
  if (BUILDING && BUILDING.gen === GEN && BUILDING.fp === fp && BUILDING.day === day && !force) return BUILDING.p;
  const gen = GEN;
  const p = buildModel().then(d => {
    d.ver = require('crypto').createHash('sha1').update(fp + '#' + gen + '#' + d.diag.builtAt).digest('hex').slice(0, 16);
    /* [v0.53.3] 나눠 받기 : 자재 · 완성품 한 개마다 지문(h)을 붙인다. 화면은 지문이 바뀐 것만 새로 받고 나머지는 저장해 둔 것을 쓴다 */
    const H = o => require('crypto').createHash('sha1').update(JSON.stringify(o)).digest('base64').slice(0, 12);
    const meta = Object.assign({}, d); delete meta.materials; delete meta.products;
    const M = {}, P = {}; d.materials.forEach(m => { M[m.k] = m; }); d.products.forEach(x => { P[x.k] = x; });
    const manifest = JSON.stringify({ success: true, ver: d.ver, meta, m: d.materials.map(m => [m.k, H(m)]), p: d.products.map(x => [x.k, H(x)]) });
    const c = { gen, fp, day, data: d, body: JSON.stringify(d), ver: d.ver, at: Date.now(), manifest, M, P };
    if (gen === GEN) CACHE = c;   // 계산 중에 또 바뀌었으면 담아 두지 않는다 (다음 요청이 다시 계산)
    return c;
  }).finally(() => { if (BUILDING && BUILDING.p === p) BUILDING = null; });
  BUILDING = { gen, fp, day, p };
  return p;
}
const RAWC = {};
/* [v0.53.20] from = 'YYYY-MM' 이면 그 달부터만 (화면 기본 = 최근 12개월) · 없으면 모든 자료(과거 이력 포함)
   → 과거 이력(2023~)을 올려도 대시보드 · 협력사 화면이 처음부터 무겁게 모두 받지 않는다 */
async function rawCached(kind, from) {
  from = /^\d{4}-\d{2}$/.test(String(from || '')) ? from : '';
  const fp = (await Promise.all([fpOne('mm_upload', 'id'), fpOne('mm_raw', 'id')].concat(kind === 'production' ? [fpOne('production_raw', 'row_no', true), fpOne('production_meta', 'prod_year', true)] : []))).join('|');
  const key = kind + '|' + from, c = RAWC[key];
  if (c && c.fp === fp && c.gen === GEN && c.day === today()) return c;   /* [v0.53.98] 날이 바뀌면 다시 (달 목록이 오늘 기준) */
  const gen = GEN;
  const rows = await getAll('mm_raw', 'row_date,cm_code,cm_name,part_no,part_name,project,part_type,status,qty,qty2,qty3,amount,amount_total,doc_no', 'active=is.true&kind=eq.' + kind + (from ? '&row_date=gte.' + from + '-01' : ''), 'row_date.asc,id.asc');
  /* 과거 자료가 더 있는지 (화면의 '과거 자료까지 불러오기' 안내용) */
  let older = 0; if (from) { try { older = await count('mm_raw', 'active=is.true&kind=eq.' + kind + '&row_date=lt.' + from + '-01'); } catch (e) { older = 0; } }
  /* [v0.53.35] 대시보드 제품생산 = 생산실적(production_raw) 만 (재고 계산과 같은 자료) */
  let all = rows.map(r => [String(r.row_date).slice(0, 10), r.cm_code || '', r.cm_name || '', r.part_no || '', r.part_name || '', r.project || '', r.part_type || '', r.status || '', N(r.qty), N(r.qty2), N(r.qty3), N(r.amount), N(r.amount_total), r.doc_no || '']);
  if (kind === 'production') {
    const ms = []; { const end = today().slice(0, 7); let m = from || '2023-01'; while (m <= end) { ms.push(m); const [yy, mm] = m.split('-').map(Number); m = mm === 12 ? (yy + 1) + '-01' : yy + '-' + (mm + 1 < 10 ? '0' : '') + (mm + 1); } }
    const L = await legacyProduction(ms).catch(() => ({ rows: [] })), ld = new Set(L.rows.map(r => r.row_date));
    all = L.rows.map(r => [r.row_date, r.cm_code || '', r.cm_name || '', r.part_no || '', r.part_name || '', '', '', r.status || '', N(r.qty), r.qty2 === null || r.qty2 === undefined ? N(r.qty) + N(r.qty3) : N(r.qty2), N(r.qty3), 0, 0, ''])
      .sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);   /* 예전 자재관리 제품생산 줄은 쓰지 않음 */
  }
  const body = JSON.stringify({ success: true, kind, from, older: Math.max(0, older), rows: all.length !== undefined ? all : rows.map(r => [String(r.row_date).slice(0, 10), r.cm_code || '', r.cm_name || '', r.part_no || '', r.part_name || '', r.project || '', r.part_type || '', r.status || '', N(r.qty), N(r.qty2), N(r.qty3), N(r.amount), N(r.amount_total), r.doc_no || '']) });
  const out = { fp, gen, day: today(), body, ver: require('crypto').createHash('sha1').update(fp + '#' + gen + '#' + key + '#' + today()).digest('hex').slice(0, 16) };
  if (gen === GEN) RAWC[key] = out;
  return out;
}
function sendVer(req, res, c) {
  const tag = '"' + c.ver + '"';
  res.setHeader('Cache-Control', 'private, no-cache');
  res.setHeader('ETag', tag);
  if (String(req.headers['if-none-match'] || '') === tag) return res.status(304).end();
  res.type('json').send(c.body);
}

/* ---------------- 업로드 (교체형) ---------------- */
const JOBS = {};   // id → { kind, header, label, min, max }
async function uploadStart(u, b) {
  const kind = String(b.kind || ''); if (!R.KINDS[kind]) throw new Error('알 수 없는 자료 종류입니다.');
  const header = Array.isArray(b.header) ? b.header : [];
  if (kind === 'production') throw new Error('자재관리 「제품생산」 업로드는 없앴습니다. 같은 MES 2-1 자료를 본 화면 「생산실적」 탭에서 올려 주세요.');   /* [v0.53.35] */
  let got = R.detectKind(header);
  if (kind === 'ovs_ship' && got === 'goods_sales') got = 'ovs_ship';   /* [v0.53.34] 제품 매출 목록형 (줄 내용은 첫 묶음에서 확인) */
  if (got !== kind) throw new Error('이 파일은 「' + R.KINDS[kind].label + '」 자료가 아닙니다.' + (got ? ' (「' + R.KINDS[got].label + '」 자료로 보입니다 — 그 탭에서 올려 주세요)' : ' 머리글을 확인해 주세요.'));
  const label = b.label && b.label.from ? b.label : null;
  // 예전에 끝나지 못한 업로드가 남긴 줄을 치운다
  await db('DELETE', 'mm_raw?kind=eq.' + kind + '&active=is.false', null, 'return=minimal');
  const rec = (await db('POST', 'mm_upload', [{ kind, file_name: String(b.fileName || '').slice(0, 200), label: label ? label.text : null, period_from: label ? label.from : null, period_to: label ? label.to : null, status: 'loading', uploaded_by: u.id, uploaded_name: u.name || u.id }], 'return=representation')).data[0];
  JOBS[rec.id] = { kind, header, label, min: null, max: null, n: 0, skip: 0, at: Date.now() };
  return { id: rec.id };
}
async function uploadChunk(u, b) {
  const j = JOBS[b.id]; if (!j) throw new Error('업로드 작업을 찾지 못했습니다. 처음부터 다시 올려 주세요.');
  const rows = Array.isArray(b.rows) ? b.rows : [];
  /* [v0.53.34] 상품매출 ↔ 제품 매출 목록은 머리글이 같다 → 첫 묶음의 창고 이름으로 확인 (완제품 창고가 절반 넘으면 제품 매출) */
  if (!j.n && rows.length && (j.kind === 'goods_sales' || j.kind === 'ovs_ship') && !R.detectKind(j.header).startsWith('ovs')) {
    const fg = R.fgRatio(j.header, rows) >= 0.5;
    if (j.kind === 'goods_sales' && fg) throw new Error('이 파일은 완제품 창고에서 나간 「제품 매출」 자료입니다. 상품매출이 아니라 「해외출고」 탭에서 올려 주세요.');
    if (j.kind === 'ovs_ship' && !fg) throw new Error('이 파일은 「상품매출」 자료로 보입니다 (완제품 창고가 아님). 상품매출 탭에서 올려 주세요.');
  }
  const m = R.mapRows(j.kind, j.header, rows, j.label);
  j.skip += m.skipped;
  const ins = m.rows.map(r => Object.assign({ kind: j.kind, upload_id: +b.id, active: false }, r));
  ins.forEach(r => { if (!r.row_date) return; if (!j.min || r.row_date < j.min) j.min = r.row_date; if (!j.max || r.row_date > j.max) j.max = r.row_date; });
  for (let i = 0; i < ins.length; i += 500) await db('POST', 'mm_raw', ins.slice(i, i + 500), 'return=minimal');
  j.n += ins.length; j.at = Date.now();
  return { inserted: ins.length, skipped: m.skipped, total: j.n };
}
async function uploadFinish(u, b) {
  const j = JOBS[b.id]; if (!j) throw new Error('업로드 작업을 찾지 못했습니다.');
  if (!j.n) throw new Error('넣을 줄이 없습니다.');
  const from = [j.label && j.label.from, j.min].filter(Boolean).sort()[0];
  const to = [j.label && j.label.to, j.max].filter(Boolean).sort().pop();
  const del = await db('DELETE', 'mm_raw?kind=eq.' + j.kind + '&active=is.true&row_date=gte.' + from + '&row_date=lte.' + to, null, 'return=minimal,count=exact');
  const deleted = Math.max(0, countOf(del.headers));
  await db('PATCH', 'mm_raw?upload_id=eq.' + (+b.id), { active: true }, 'return=minimal');
  await db('PATCH', 'mm_upload?id=eq.' + (+b.id), { status: 'done', period_from: from, period_to: to, rows_in: j.n, rows_deleted: deleted, rows_skipped: j.skip, finished_at: new Date().toISOString() }, 'return=minimal');
  delete JOBS[b.id]; GEN++; clearTimeout(WARM); WARM = setTimeout(() => { model().catch(() => {}); }, 1500);
  return { kind: j.kind, from, to, inserted: j.n, deleted, skipped: j.skip };
}
async function uploadCancel(u, b) {
  const id = +b.id; if (!id) return { ok: true };
  await db('DELETE', 'mm_raw?upload_id=eq.' + id + '&active=is.false', null, 'return=minimal');
  await db('PATCH', 'mm_upload?id=eq.' + id + '&status=eq.loading', { status: 'failed', message: String(b.reason || '').slice(0, 300), finished_at: new Date().toISOString() }, 'return=minimal');
  delete JOBS[id];
  return { ok: true };
}
async function uploadList() {
  const list = (await db('GET', 'mm_upload?select=id,kind,file_name,label,period_from,period_to,status,rows_in,rows_deleted,rows_skipped,uploaded_name,created_at,finished_at&order=id.desc&limit=60')).data || [];
  const cover = {};
  for (const k of R.ORDER) {
    const a = ((await db('GET', 'mm_raw?select=row_date&kind=eq.' + k + '&active=is.true&order=row_date.asc&limit=1')).data || [])[0];
    const z = ((await db('GET', 'mm_raw?select=row_date&kind=eq.' + k + '&active=is.true&order=row_date.desc&limit=1')).data || [])[0];
    cover[k] = { from: a ? a.row_date : null, to: z ? z.row_date : null, rows: a ? await count('mm_raw', 'kind=eq.' + k + '&active=is.true') : 0 };
  }
  return { list, cover };
}

/* ---------------- 연결 ---------------- */
function mount(app, deps) {
  const { userFromRequest_ } = deps;
  const J = express.json({ limit: '30mb' });
  const fail = (res, e) => {
    const missing = e && (e.status === 404 || /does not exist|PGRST20|schema cache/.test(String(e.body || e.message)));
    res.status(missing ? 503 : 400).json({ success: false, message: missing ? '자재관리 표가 없습니다. Supabase 에서 supabase_material.sql 과 supabase_material_base_2608.sql 을 실행해 주세요. (' + String(e.message || e).slice(0, 160) + ')' : String((e && e.message) || e) });
  };
  async function who(req, res, up) {
    const u = await userFromRequest_(req);
    if (!u) { res.status(401).json({ success: false, message: '로그인이 필요합니다. 본 화면에서 다시 로그인해 주세요.' }); return null; }
    if (!(up ? canUpload(u) : canView(u))) { res.status(403).json({ success: false, message: up ? '업로드 권한이 없습니다.' : '자재관리 화면 권한이 없습니다. 계정 관리에서 권한을 받아 주세요.' }); return null; }
    return u;
  }
  app.get(['/apps/material', '/apps/material/'], async (req, res) => {
    if (!req.path.endsWith('/')) return res.redirect('/apps/material/');
    res.setHeader('Cache-Control', 'no-store');
    const u = await userFromRequest_(req);
    const box = t => '<!DOCTYPE html><meta charset="utf-8"><body style="font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f1f5f9;color:#334155"><div style="text-align:center">' + t + '</div></body>';
    if (!u) return res.type('html').send(box('<b>로그인이 필요합니다.</b><p>본 화면에서 다시 로그인해 주세요.</p>'));
    if (!canView(u)) return res.type('html').send(box('<b>자재관리 화면 권한이 없습니다.</b><p>계정 관리에서 \'자재관리\' 권한을 받아 주세요.</p>'));
    const html = fs.readFileSync(path.join(__dirname, 'material-ui.html'), 'utf8').replace('/*__ME__*/null', JSON.stringify({ id: u.id, name: u.name, role: u.role, dept: u.dept || '' }).replace(/</g, '\\u003c'));
    res.type('html').send(html);
  });
  /* [v0.53.9] 화면 번역 사전 (영어 · 일본어 · 중국어) — public/i18n-sub.js 가 바탕 사전으로 쓰고, 번역 DB(i18n_dict)가 그 위에 덮는다 */
  app.get('/apps/material/i18n-dict.js', (req, res) => { res.setHeader('Cache-Control', 'no-cache'); let d = {}; try { d = JSON.parse(fs.readFileSync(path.join(__dirname, 'material-i18n.json'), 'utf8')); } catch (e) {} res.type('application/javascript').send('window.__AKC_SUB_DICT__ = ' + JSON.stringify(d).replace(/</g, '\\u003c') + ';'); });
  app.get('/apps/material/engine.js', (req, res) => { res.setHeader('Cache-Control', 'no-cache'); res.type('application/javascript').send(fs.readFileSync(path.join(__dirname, 'material-engine.js'), 'utf8')); });
  app.get('/apps/material/rules.js', (req, res) => { res.setHeader('Cache-Control', 'no-cache'); res.type('application/javascript').send(fs.readFileSync(path.join(__dirname, 'material-rules.js'), 'utf8')); });
  app.get('/apps/material/api/model', async (req, res) => {
    const u = await who(req, res); if (!u) return;
    try { sendVer(req, res, await model(req.query.refresh === '1')); } catch (e) { fail(res, e); }
  });
  /* [v0.53.3] 목록표(버전 · 지문)만 먼저 · 바뀐 것만 따로 */
  app.get('/apps/material/api/manifest', async (req, res) => {
    const u = await who(req, res); if (!u) return;
    try { const c = await model(req.query.refresh === '1'); sendVer(req, res, { ver: c.ver, body: c.manifest }); } catch (e) { fail(res, e); }
  });
  app.post('/apps/material/api/items', J, async (req, res) => {
    const u = await who(req, res); if (!u) return;
    try {
      const c = await model(); const b = req.body || {};
      if (String(b.ver || '') !== c.ver) return res.status(409).json({ success: false, stale: true, ver: c.ver, message: '그사이 자료가 바뀌었습니다. 다시 받습니다.' });
      res.setHeader('Cache-Control', 'no-store');
      res.json({ success: true, ver: c.ver, m: (b.m || []).map(k => c.M[k]).filter(Boolean), p: (b.p || []).map(k => c.P[k]).filter(Boolean) });
    } catch (e) { fail(res, e); }
  });
  /* 협력사 · 생산 · 출고 화면용 원본 (가볍게) */
  app.get('/apps/material/api/find', async (req, res) => {   /* [v0.53.36] 품번 찾기 */
    const u = await who(req, res); if (!u) return;
    try { res.json(Object.assign({ success: true }, await findPart(req.query.code))); } catch (e) { fail(res, e); }
  });
  app.get('/apps/material/api/raw', async (req, res) => {
    const u = await who(req, res); if (!u) return;
    const kind = String(req.query.kind || ''); if (!R.KINDS[kind]) return res.status(400).json({ success: false, message: '종류가 없습니다.' });
    try { sendVer(req, res, await rawCached(kind, req.query.from)); } catch (e) { fail(res, e); }
  });
  app.get('/apps/material/api/uploads', async (req, res) => {
    const u = await userFromRequest_(req); if (!u || !(canUpload(u) || canView(u))) return res.status(401).json({ success: false, message: '권한이 없습니다.' });
    try { res.setHeader('Cache-Control', 'no-store'); res.json(Object.assign({ success: true }, await uploadList())); } catch (e) { fail(res, e); }
  });
  /* [v0.53.14] 자재 소진 관리 — 입고 예정 (mm_inbound) · 보기 권한이 있으면 적고 고칠 수 있다 */
  const inFail = (res, e) => { if (e && (e.shipCol || /ship_(plan|date|no|by|at)/.test(String(e.body || e.message)))) return res.status(400).json({ success: false, shipCol: true, message: SHIP_SQL });   /* [v0.53.111] 발송 칸 없음 (입고 기능은 그대로 씀) */
    const missing = !!e && (e.status === 404 || /42P01|PGRST205|does not exist|schema cache/.test(String(e.body || e.message))); const noCol = !!e && /kind|act_date|act_qty|42703|PGRST204/.test(String(e.body || e.message)); res.status(missing || noCol ? 503 : 400).json({ success: false, missing: missing || noCol, message: missing ? '입고 예정 표(mm_inbound)가 없습니다. Supabase SQL Editor 에서 supabase_material_inbound.sql 을 실행해 주세요.' : noCol ? '입고 확인 · 보유수량 칸이 아직 없습니다. Supabase SQL Editor 에서 supabase_material_inbound.sql 을 다시 실행해 주세요 (v0.53.27 칸 추가).' : String((e && e.message) || e) }); };
  const inRow = x => ({ id: x.id, k: x.part_key, code: x.part_no || '', due: String(x.due || '').slice(0, 10), qty: Number(x.qty) || 0, memo: x.memo || '', done: !!x.done, kind: x.kind || 'plan', adate: String(x.act_date || '').slice(0, 10), aqty: x.act_qty == null ? null : Number(x.act_qty), by: x.updated_by || x.created_by || '', at: x.updated_at || x.created_at || '', cat: kstDay(x.created_at),
    shipPlan: String(x.ship_plan || '').slice(0, 10), shipDate: String(x.ship_date || '').slice(0, 10), shipNo: x.ship_no || '', shipBy: x.ship_by || '', shipAt: x.ship_at || '' });   /* [v0.53.111] 발송 (칸이 없으면 빈 값) */
  /* [v0.53.115] 합친 품번(mm_alias)의 기록은 남길 품번으로 보낸다 */
  const inRows = async data => { const ALI = await aliasMap(); return (data || []).map(inRow).map(x => ALI[x.k] ? Object.assign(x, { k: ALI[x.k], kFrom: x.k }) : x); };
  /* [v0.53.111] 발송 칸(SQL)이 있는지 : 있으면 계속 · 없으면 1분마다 다시 봄 */
  let SHIPC = { ok: null, t: 0 };
  const shipReady = async () => { if (SHIPC.ok === true || (SHIPC.ok === false && Date.now() - SHIPC.t < 60000)) return SHIPC.ok; try { await db('GET', 'mm_inbound?select=ship_plan&limit=1'); SHIPC = { ok: true, t: Date.now() }; } catch (e) { SHIPC = { ok: false, t: Date.now() }; } return SHIPC.ok; };
  const SHIP_SQL = '발송 기록 칸이 아직 없습니다 — Supabase SQL Editor 에서 supabase_material_inbound.sql 의 [v0.53.111] 부분을 실행해 주세요.';
  /* ---------------- [v0.53.38] 발주계획관리 (SL · Firm / Forecast) ----------------
     mm_po_plan : 자재 × 월 (수량 · 메모) · mm_po_note : 자재마다 메모 · mm_po_hist : 고친 기록
     Firm = 당월 포함 4개월 · Forecast = 그다음 6개월 (모두 10개월) [v0.53.47] (달이 바뀌면 자동으로 넘어감) — 화면 · 엑셀 · 대시보드가 같은 규칙 */
  const PO_FIRM_N = 4;   /* [v0.53.47] FIRM = 당월 포함 4개월 (예 10월 → 10 · 11 · 12 · 1월) */
  const poMonths = () => { const t = today(); let y = +t.slice(0, 4), m = +t.slice(5, 7); const out = []; for (let i = 0; i < 10; i++) { out.push({ m: y + '-' + String(m).padStart(2, '0'), firm: i < PO_FIRM_N }); m++; if (m > 12) { m = 1; y++; } } return out; };
  const poRow = x => ({ id: x.id, k: x.part_key, code: x.part_no || '', m: x.month, q: x.qty == null ? null : Number(x.qty), memo: x.memo || '', by: x.updated_by || x.created_by || '', at: x.updated_at || x.created_at || '' });
  app.get('/apps/material/api/po', async (req, res) => {
    const u = await who(req, res); if (!u) return;
    try {
      res.setHeader('Cache-Control', 'no-store');
      const ms = poMonths(), q = req.query || {};
      const from = /^\d{4}-\d{2}$/.test(String(q.from || '')) ? String(q.from) : addMonthsKey(ms[0].m, -12), to = /^\d{4}-\d{2}$/.test(String(q.to || '')) ? String(q.to) : ms[9].m;
      const [r, n, mm] = await Promise.all([getAll('mm_po_plan', '*', 'month=gte.' + from + '&month=lte.' + to, 'month.asc,id.asc'), getAll('mm_po_note', '*', '', 'part_key.asc', 'part_key'),
        db('GET', 'mm_po_plan?select=month&order=month.asc&limit=1').then(x => ((x.data || [])[0] || {}).month || '').catch(() => '')]);
      res.json({ success: true, months: ms, from, to, first: mm, rows: r.map(poRow), notes: n.map(x => ({ k: x.part_key, memo: x.memo || '', by: x.updated_by || '', at: x.updated_at || '' })) });
    } catch (e) { const msg = String(e.message || e); res.status(/does not exist|relation|schema cache/i.test(msg) ? 400 : 500).json({ success: false, needSql: /does not exist|relation|schema cache/i.test(msg), message: /does not exist|relation|schema cache/i.test(msg) ? '발주계획 표가 아직 없습니다 — Supabase SQL Editor 에서 supabase_material_po.sql 을 실행해 주세요.' : msg }); }
  });
  function addMonthsKey(ym, d) { let y = +ym.slice(0, 4), m = +ym.slice(5, 7) + d; while (m < 1) { m += 12; y--; } while (m > 12) { m -= 12; y++; } return y + '-' + String(m).padStart(2, '0'); }
  /* [v0.53.39] 한 칸 저장 (일괄 저장도 이것을 차례로 부른다) */
  async function poSaveOne(u, b) {
    const k = String(b.k || '').trim(), mo = String(b.m || '').trim();
    if (!k) throw new Error('자재를 골라 주세요.');
    if (!/^\d{4}-\d{2}$/.test(mo)) throw new Error('월을 골라 주세요.');
    const by = String(u.name || u.id || '');
    const old = ((await db('GET', 'mm_po_plan?select=*&part_key=eq.' + encodeURIComponent(k) + '&month=eq.' + mo)).data || [])[0] || null;
    let q;
    if (b.q === undefined) q = old && old.qty != null ? Number(old.qty) : null;
    else { const qs = b.q == null ? '' : String(b.q).replace(/,/g, '').trim(); q = qs === '' ? null : Number(qs); }
    if (q !== null && (!isFinite(q) || q < 0 || q > 1e10)) throw new Error('수량은 0 이상 숫자로 넣어 주세요 (' + mo + ').');
    const memo = b.memo === undefined ? undefined : String(b.memo || '').slice(0, 500);
    const newMemo = memo === undefined ? (old ? old.memo || '' : '') : memo;
    let row = null;
    if (q === null && !newMemo) { if (old) await db('DELETE', 'mm_po_plan?id=eq.' + old.id); }
    else if (old) row = ((await db('PATCH', 'mm_po_plan?id=eq.' + old.id, { qty: q, memo: newMemo, part_no: String(b.code || old.part_no || '').slice(0, 80), updated_by: by, updated_at: new Date().toISOString() }, 'return=representation')).data || [])[0];
    else row = ((await db('POST', 'mm_po_plan', [{ part_key: k.slice(0, 80), part_no: String(b.code || '').slice(0, 80), month: mo, qty: q, memo: newMemo, created_by: by, updated_by: by }], 'return=representation')).data || [])[0];
    const oq = old && old.qty != null ? Number(old.qty) : null;
    if (oq !== q || (old ? old.memo || '' : '') !== newMemo) await db('POST', 'mm_po_hist', [{ part_key: k, month: mo, old_qty: oq, new_qty: q, old_memo: old ? old.memo || '' : '', new_memo: newMemo, by_name: by, at: new Date().toISOString() }], 'return=minimal').catch(() => {});
    return { k, m: mo, row: row ? poRow(row) : null };
  }
  async function poNoteOne(u, k, memo) {
    const by = String(u.name || u.id || ''); memo = String(memo || '').slice(0, 1000);
    if (!memo) await db('DELETE', 'mm_po_note?part_key=eq.' + encodeURIComponent(k));
    else await db('POST', 'mm_po_note?on_conflict=part_key', [{ part_key: k, memo, updated_by: by, updated_at: new Date().toISOString() }], 'resolution=merge-duplicates,return=minimal');
    await db('POST', 'mm_po_hist', [{ part_key: k, month: null, new_memo: memo, by_name: by, at: new Date().toISOString() }], 'return=minimal').catch(() => {});
    return { k, memo, by, at: new Date().toISOString() };
  }
  app.post('/apps/material/api/po/save', J, async (req, res) => {
    const u = await who(req, res); if (!u) return;
    try { const r = await poSaveOne(u, req.body || {}); res.json(Object.assign({ success: true }, r)); }
    catch (e) { res.status(400).json({ success: false, message: String(e.message || e) }); }
  });
  /* [v0.53.45] 일괄 저장 — 빠르게 : 칸마다 DB 를 세 번씩 부르던 것(600칸이면 수 분 · 시간 초과)을
     ① 있는 줄을 한 번에 읽고 ② 넣기 · 고치기는 한 번에 (part_key · month 겹치면 고침) ③ 지우기도 한 번에 ④ 고친 기록도 한 번에
     → 칸이 수백 개여도 몇 번의 DB 호출로 끝난다. 화면도 400칸씩 나눠 보내 한 번이 짧다 */
  async function poSaveMany(u, items) {
    const by = String(u.name || u.id || ''), now = new Date().toISOString(), last = {};
    for (const it of items) {
      const k = String(it.k || '').trim(), mo = String(it.m || '').trim();
      if (!k) throw new Error('자재를 골라 주세요.');
      if (!/^\d{4}-\d{2}$/.test(mo)) throw new Error('월을 골라 주세요.');
      last[k + '|' + mo] = Object.assign({}, it, { k, m: mo });
    }
    const list = Object.values(last); if (!list.length) return [];
    const months = [...new Set(list.map(x => x.m))], keys = new Set(list.map(x => x.k));
    /* [v0.53.47] 있는 줄은 이 자재들 · 이 달들만 읽는다 (예전 : 그 달 모든 자재를 읽어 큰 표에서 느렸다) */
    const old = {}, KL = [...keys], qv = x => '"' + String(x).replace(/["\\]/g, '') + '"';
    for (let i = 0; i < KL.length; i += 120) {
      const f = 'month=in.(' + months.join(',') + ')&part_key=in.(' + KL.slice(i, i + 120).map(x => encodeURIComponent(qv(x))).join(',') + ')';
      (await getAll('mm_po_plan', '*', f, 'id.asc')).forEach(r => { old[r.part_key + '|' + r.month] = r; });
    }
    const ups = [], dels = [], hist = [], out = [];
    for (const it of list) {
      const o = old[it.k + '|' + it.m] || null;
      let q;
      if (it.q === undefined) q = o && o.qty != null ? Number(o.qty) : null;
      else { const qs = it.q == null ? '' : String(it.q).replace(/,/g, '').trim(); q = qs === '' ? null : Number(qs); }
      if (q !== null && (!isFinite(q) || q < 0 || q > 1e10)) throw new Error('수량은 0 이상 숫자로 넣어 주세요 (' + it.k + ' · ' + it.m + ').');
      const memo = it.memo === undefined ? (o ? o.memo || '' : '') : String(it.memo || '').slice(0, 500);
      const oq = o && o.qty != null ? Number(o.qty) : null, om = o ? o.memo || '' : '';
      if (oq === q && om === memo) { out.push({ k: it.k, m: it.m, row: o ? poRow(o) : null }); continue; }
      if (q === null && !memo) { if (o) dels.push(o.id); out.push({ k: it.k, m: it.m, row: null }); }
      else ups.push({ part_key: it.k.slice(0, 80), part_no: String(it.code || (o && o.part_no) || it.k).slice(0, 80), month: it.m, qty: q, memo, created_by: o ? o.created_by || by : by, updated_by: by, updated_at: now });
      hist.push({ part_key: it.k, month: it.m, old_qty: oq, new_qty: q, old_memo: om, new_memo: memo, by_name: by, at: now });
    }
    for (let i = 0; i < ups.length; i += 500) {
      const r = await db('POST', 'mm_po_plan?on_conflict=part_key,month', ups.slice(i, i + 500), 'resolution=merge-duplicates,return=representation');
      (r.data || []).forEach(x => out.push({ k: x.part_key, m: x.month, row: poRow(x) }));
    }
    for (let i = 0; i < dels.length; i += 200) await db('DELETE', 'mm_po_plan?id=in.(' + dels.slice(i, i + 200).join(',') + ')');
    for (let i = 0; i < hist.length; i += 500) await db('POST', 'mm_po_hist', hist.slice(i, i + 500), 'return=minimal').catch(() => {});
    return out;
  }
  app.post('/apps/material/api/po/batch', J, async (req, res) => {
    const u = await who(req, res); if (!u) return;
    const b = req.body || {}, items = Array.isArray(b.items) ? b.items.slice(0, 5000) : [], notes = Array.isArray(b.notes) ? b.notes.slice(0, 1000) : [];
    try {
      const out = await poSaveMany(u, items), outN = [];
      for (const n of notes) outN.push(await poNoteOne(u, String(n.k || '').trim(), n.memo));
      res.json({ success: true, rows: out, notes: outN });
    } catch (e) { res.status(400).json({ success: false, message: String(e.message || e) }); }
  });
  app.post('/apps/material/api/po/note', J, async (req, res) => {
    const u = await who(req, res); if (!u) return;
    try { const b = req.body || {}, k = String(b.k || '').trim(); if (!k) throw new Error('자재를 골라 주세요.'); res.json(Object.assign({ success: true }, await poNoteOne(u, k, b.memo))); }
    catch (e) { res.status(400).json({ success: false, message: String(e.message || e) }); }
  });
  /* [v0.53.41] SL 메일 (수동으로만 · 자동 발송 없음) — 메일 알림과 같은 발송 계정 · 보낸 사람 이름 · 회신은 보낸 사람
     주소록 : 매입처마다 받는 사람 · 참조를 app_props(mm_po_mail_book) 에 · 기록 : app_props(mm_po_mail_log) 최근 300건 */
  const POBOOK = 'mm_po_mail_book', POLOG = 'mm_po_mail_log', POTPL = 'mm_po_mail_tpl', POTPL_EN = 'mm_po_mail_tpl_en';   /* POTPL_EN [v0.53.112] 영문 기본 문구 ({SUPPLIER} {FIRM} {FORECAST} {PERIOD} {MONTHS} {NOTE}) */
  /* [v0.53.112] SL 영문 : 한글 글(전할 말 · 본문 · 품명 · 메모)을 AI(Gemini — INV 메일 · 다국어와 같은 GEMINI_API_KEY)로 영어로 옮긴다
     같은 글은 기억해 두었다가 바로 씀 (최근 500개) · 키가 없거나 실패하면 원문 그대로 두고 ok:false (보내기는 막지 않음 · 화면이 알림) */
  const SLTR = new Map(); let SLTR_THINK = true;
  const hasHan = t => /[가-힣ㄱ-ㅎㅏ-ㅣ]/.test(String(t || ''));
  async function slTranslate(texts) {
    const list = (Array.isArray(texts) ? texts : []).slice(0, 400).map(t => String(t == null ? '' : t).slice(0, 6000));
    const need = [...new Set(list.map(t => t.trim()).filter(t => hasHan(t) && !SLTR.has(t)))].slice(0, 150);
    let ok = true, message = '';
    if (need.length) {
      const key = String(process.env.GEMINI_API_KEY || '').trim();
      if (!key) { ok = false; message = 'AI 번역 설정(GEMINI_API_KEY)이 없어 한글을 그대로 둡니다 — 영어로 직접 고쳐 주세요.'; }
      else try {
        const model = String(process.env.SL_MAIL_MODEL || process.env.INV_MAIL_MODEL || process.env.I18N_MODEL || 'gemini-3.6-flash').trim();
        const base = String(process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com').replace(/\/+$/, '');
        const prompt = 'You translate Korean text for a purchase Schedule Line (SL) that Ashimori Korea Co., Ltd. (AKC), an automotive safety parts maker, sends to an overseas supplier. ' +
          'Translate every item into clear, polite, concise business English. Keep part numbers, quantities, dates, units, codes and company names exactly as written; romanize Korean person names. ' +
          'Keep line breaks. Do not add greetings, facts or comments. Return ONLY a JSON array of strings with the same order and length as the input.\n\nInput JSON:\n' + JSON.stringify(need);
        const call = think => { const gc = { temperature: 0.1, maxOutputTokens: 8192, responseMimeType: 'application/json' }; if (think) gc.thinkingConfig = { thinkingLevel: 'minimal' };
          return fetch(base + '/v1beta/models/' + encodeURIComponent(model) + ':generateContent?key=' + encodeURIComponent(key), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: gc }) }); };
        let r = await call(SLTR_THINK);
        if (!r.ok && r.status === 400 && SLTR_THINK) { const b0 = await r.text().catch(() => ''); if (/thinking/i.test(b0)) { SLTR_THINK = false; r = await call(false); } else throw new Error('400 ' + b0.slice(0, 120)); }
        if (!r.ok) throw new Error(r.status + ' ' + String(await r.text().catch(() => '')).slice(0, 120));
        const j = await r.json(), txt = (((((j && j.candidates) || [])[0] || {}).content || {}).parts || []).filter(p => !p.thought).map(p => p.text || '').join('');
        const arr = JSON.parse(String(txt).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
        if (!Array.isArray(arr) || arr.length !== need.length) throw new Error('번역 결과 개수가 맞지 않습니다');
        need.forEach((t, i) => { const en = String(arr[i] == null ? '' : arr[i]).trim(); if (en && !hasHan(en)) SLTR.set(t, en); });
        while (SLTR.size > 500) SLTR.delete(SLTR.keys().next().value);
        if (need.some(t => !SLTR.has(t))) { ok = false; message = 'AI 번역이 일부 비었습니다 — 남은 한글은 영어로 직접 고쳐 주세요.'; }
      } catch (e) { ok = false; message = 'AI 번역 실패 — ' + String(e.message || e).slice(0, 160) + ' (한글은 그대로 둡니다)'; }
    }
    const en = list.map(t => { const k = t.trim(); return hasHan(k) && SLTR.has(k) ? SLTR.get(k) : t; });
    return { ok, message, en, left: en.filter(hasHan).length };
  }   /* POTPL [v0.53.42] 제목 · 본문 기본 문구 (모두 같이 씀 · {매입처} {FIRM} {FORECAST} {기간} {전할말} 자리표) */
  const propGet = async k => { const r = await db('GET', 'app_props?select=value&key=eq.' + encodeURIComponent(k) + '&limit=1').catch(() => ({ data: [] })); const v = ((r.data || [])[0] || {}).value; try { return v ? JSON.parse(v) : null; } catch (e) { return null; } };
  const propSet = (k, v) => db('POST', 'app_props?on_conflict=key', [{ key: k, value: JSON.stringify(v), updated_at: new Date().toISOString() }], 'resolution=merge-duplicates,return=minimal');
  app.get('/apps/material/api/po/mail/info', async (req, res) => {
    const u = await who(req, res); if (!u) return;
    try {
      const mailer = require('../lib/mailer'), mi = mailer.invInfo(), MM = require('./material-mail'), st = await MM.settings_().catch(() => ({}));
      const sup = String(req.query.sup || ''), book = (await propGet(POBOOK)) || {}, log = ((await propGet(POLOG)) || []).filter(x => !sup || x.sup === sup).slice(0, 10);
      const allBook = Object.keys(book).map(s2 => ({ sup: s2, to: book[s2].to || '', cc: book[s2].cc || '' }));
      res.json({ success: true, ready: !!mi.ready, reason: mi.reason || '', from: (st.fromName || 'AKC 자재관리 알림') + (mi.fromAddress ? ' <' + mi.fromAddress + '>' : ''), me: String(u.email || u.name || ''), book: book[sup] || null, allBook, tpl: (await propGet(POTPL)) || null, tplEn: (await propGet(POTPL_EN)) || null, ai: !!String(process.env.GEMINI_API_KEY || '').trim(), log });   /* [v0.53.112] 영문 기본 문구 · AI 번역 가능 */
    } catch (e) { res.status(400).json({ success: false, message: String(e.message || e) }); }
  });
  app.post('/apps/material/api/po/mail/tpl', J, async (req, res) => {   /* [v0.53.42] 기본 문구 저장 (비우면 처음 문구로) */
    const u = await who(req, res); if (!u) return;
    try {
      const b = req.body || {}, subject = String(b.subject || '').slice(0, 200), body = String(b.body || '').slice(0, 20000), KEY = b.lang === 'en' ? POTPL_EN : POTPL;   /* [v0.53.112] 영문 · 한국어 따로 */
      if (!subject && !body) { await db('DELETE', 'app_props?key=eq.' + KEY); return res.json({ success: true, tpl: null, lang: b.lang === 'en' ? 'en' : 'ko' }); }
      const tpl = { subject, body, by: String(u.name || u.id || ''), at: new Date().toISOString() };
      await propSet(KEY, tpl); res.json({ success: true, tpl, lang: b.lang === 'en' ? 'en' : 'ko' });
    } catch (e) { res.status(400).json({ success: false, message: String(e.message || e) }); }
  });
  /* [v0.53.112] 영문 SL : 전할 말 · 본문 등 한글을 AI 로 영어로 (화면의 🌐 AI 영문 번역 · 영문 메일을 열 때) */
  app.post('/apps/material/api/po/mail/translate', J, async (req, res) => {
    const u = await who(req, res); if (!u) return;
    try { res.json(Object.assign({ success: true }, await slTranslate((req.body || {}).texts))); } catch (e) { res.status(400).json({ success: false, message: String(e.message || e) }); }
  });
  app.post('/apps/material/api/po/mail/send', J, async (req, res) => {
    const u = await who(req, res); if (!u) return;
    const b = req.body || {}, by = String(u.name || u.id || '');
    try {
      const mailer = require('../lib/mailer'), mi = mailer.invInfo(); if (!mi.ready) throw new Error(mi.reason || '메일 발송 설정이 없습니다.');
      const MM = require('./material-mail'), st = await MM.settings_().catch(() => ({})), pa = MM._parseAddrs;
      const to = pa(b.to).filter(a => a.valid), cc = pa(b.cc).filter(a => a.valid), bad = pa(String(b.to || '') + ',' + String(b.cc || '')).filter(a => !a.valid);
      if (bad.length) throw new Error('메일 주소를 확인해 주세요 : ' + bad.map(a => a.address).join(', '));
      if (!to.length) throw new Error('받는 사람을 넣어 주세요.');
      const subject = String(b.subject || '').trim().slice(0, 200) || (b.lang === 'en' ? '[AKC] Schedule Line' : '[AKC] SL 발주계획');
      const text = String(b.body || '').slice(0, 20000);
      const x = await poXlsx(u, b);
      const esc2 = t => String(t).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
      const html = '<div style="font-family:Malgun Gothic,Apple SD Gothic Neo,sans-serif;font-size:14px;line-height:1.7;color:#1f2937">' + esc2(text).replace(/\n/g, '<br>') +
        '<div style="margin-top:14px;font-size:11px;color:#94a3b8">This email was sent from AKC SYSTEM by ' + esc2(by) + '.</div></div>';
      const from = mi.fromAddress; if (!from) throw new Error('발송 계정(INV_SMTP_USER)이 없습니다.');
      const r = await mailer.invSend({ from: { name: st.fromName || 'AKC 자재관리 알림', address: from }, fromLabel: st.fromName || 'AKC 자재관리 알림', replyTo: /@/.test(String(u.email || '')) ? u.email : from,
        to: to.map(a => ({ name: a.name, address: a.address })), cc: cc.map(a => ({ name: a.name, address: a.address })), subject, text, html,
        attachments: [{ filename: x.fn, content: x.buf, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }] });
      if (!r.accepted.length) throw new Error('메일 서버가 받는 사람을 모두 거절했습니다 : ' + r.rejected.join(', '));
      const sup = String(b.sup || '');
      if (b.saveBook && sup) { const book = (await propGet(POBOOK)) || {}; book[sup] = { to: String(b.to || ''), cc: String(b.cc || ''), by, at: new Date().toISOString() }; await propSet(POBOOK, book).catch(() => {}); }
      const log = (await propGet(POLOG)) || []; log.unshift({ at: new Date().toISOString(), by, sup, to: to.map(a => a.address).join(', '), cc: cc.map(a => a.address).join(', '), subject, file: x.fn, n: x.n, period: x.from + ' ~ ' + x.to, months: x.nm, lang: x.lang, ok: true });   /* [v0.53.112] 개월 수 · 언어 */
      await propSet(POLOG, log.slice(0, 300)).catch(() => {});
      res.json({ success: true, accepted: r.accepted, rejected: r.rejected, file: x.fn, period: x.from + ' ~ ' + x.to, months: x.nm, lang: x.lang, trLeft: x.trLeft || 0 });
    } catch (e) {
      try { const log = (await propGet(POLOG)) || []; log.unshift({ at: new Date().toISOString(), by, sup: String(b.sup || ''), to: String(b.to || '').slice(0, 300), subject: String(b.subject || '').slice(0, 200), ok: false, err: String(e.message || e).slice(0, 300) }); await propSet(POLOG, log.slice(0, 300)); } catch (er) {}
      res.status(400).json({ success: false, message: String(e.message || e) });
    }
  });
  app.get('/apps/material/api/po/hist', async (req, res) => {
    const u = await who(req, res); if (!u) return;
    /* [v0.53.51] 고친 기록은 자재마다 최근 10개만 — 볼 때 그보다 오래된 줄은 지운다 (쌓이면 느려지고 자리만 차지) */
    try { const k = String(req.query.k || '').trim(); const all = ((await db('GET', 'mm_po_hist?select=*&part_key=eq.' + encodeURIComponent(k) + '&order=at.desc,id.desc&limit=500')).data || []).sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')) || (b.id - a.id)), r = all.slice(0, 10), old = all.slice(10).map(x => x.id);
      for (let i = 0; i < old.length; i += 100) await db('DELETE', 'mm_po_hist?id=in.(' + old.slice(i, i + 100).join(',') + ')').catch(() => {});
      res.json({ success: true, rows: r.map(x => ({ m: x.month, oq: x.old_qty == null ? null : Number(x.old_qty), nq: x.new_qty == null ? null : Number(x.new_qty), om: x.old_memo || '', nm: x.new_memo || '', by: x.by_name || '', at: x.at })) }); }
    catch (e) { res.status(400).json({ success: false, message: String(e.message || e) }); }
  });
  /* 협력사에 보낼 엑셀 : 고른 자재들 × 10개월 (Firm · Forecast 색 구분) + 메모 — [v0.53.41] 내려받기 · 메일 첨부가 같이 씀 */
  async function poXlsx(u, body) {
      const b = body || {}, keys = Array.isArray(b.keys) ? b.keys.slice(0, 3000).map(String) : [];
      if (!keys.length) throw new Error('내려받을 자재가 없습니다.');
      const cur = poMonths(), c = await model(false), MM = {}; (c.data.materials || []).forEach(m => { MM[m.k] = m; });
      /* [v0.53.39] 화면에서 고른 조회 년월의 10개월 (없으면 이번 달부터) · 구분은 오늘 기준 (지난 달 = PAST) */
      /* [v0.53.112] 화면에서 고른 기간 (시작 ~ 끝 · 최대 12개월 · 차례대로) — 없으면 이번 달부터 10개월 */
      const ms = Array.isArray(b.months) && b.months.length && b.months.every(x => /^\d{4}-\d{2}$/.test(String(x))) ? [...new Set(b.months.map(String))].sort().slice(0, 12).map(x => { const i = cur.findIndex(y => y.m === x); return { m: x, firm: i > -1 && i < PO_FIRM_N, past: x < cur[0].m }; }) : cur;
      const EN = b.lang === 'en', fm = ms.filter(x => x.firm), fc = ms.filter(x => !x.firm && !x.past), rg = L => L.length ? L[0].m + ' ~ ' + L[L.length - 1].m : '';
      const plan = await getAll('mm_po_plan', '*', 'month=gte.' + ms[0].m + '&month=lte.' + ms[ms.length - 1].m, 'month.asc');
      const notes = await getAll('mm_po_note', '*', '', 'part_key.asc', 'part_key');
      const P = {}, N = {}; plan.forEach(r => { (P[r.part_key] = P[r.part_key] || {})[r.month] = r; }); notes.forEach(r => { N[r.part_key] = r.memo || ''; });
      const ExcelJS = require('exceljs'), wb = new ExcelJS.Workbook(); wb.creator = 'AKC SYSTEM';
      /* [v0.53.112] 영문 : 한글 품명 · 메모 · 전할 말을 AI 로 (같은 글은 한 번만) — 번역 못 한 한글 수 trLeft */
      let TR = t => t, trLeft = 0;
      if (EN) { const src = []; keys.forEach(k => { const m = MM[k] || {}; src.push(m.name || ''); if (N[k]) src.push(N[k]); ms.forEach(x => { const pr = (P[k] || {})[x.m]; if (pr && pr.memo) src.push(pr.memo); }); }); if (!b.memoEn) src.push(String(b.memo || ''));
        const tr = await slTranslate(src), mp = new Map(); src.forEach((t, i) => mp.set(t, tr.en[i])); TR = t => mp.has(t) ? mp.get(t) : t; trLeft = tr.left; }
      const ws = wb.addWorksheet(EN ? 'Schedule Line' : 'SL 발주계획', { views: [{ state: 'frozen', xSplit: 3, ySplit: 6 }], pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 } });
      const sup = String(b.sup || '').slice(0, 80), title = EN ? 'SCHEDULE LINE — ' + (sup || 'All suppliers') : 'SCHEDULE LINE (발주계획) — ' + (sup || '전체 협력사');
      ws.mergeCells(1, 1, 1, 4 + ms.length * 1 + 2); ws.getCell(1, 1).value = title; ws.getCell(1, 1).font = { bold: true, size: 16, color: { argb: 'FF0F3D3E' } };
      ws.getCell(2, 1).value = 'Issued : ' + today() + '  ·  Ashimori Korea Co., Ltd. (AKC)' + (EN ? '  ·  Period : ' + rg(ms) + ' (' + ms.length + (ms.length > 1 ? ' months)' : ' month)') : '  ·  by ' + String(u.name || u.id || '') + '  ·  기간 ' + rg(ms) + ' (' + ms.length + '개월)');
      /* [v0.53.112] FIRM · FORECAST 설명 = 이 파일에 든 달 그대로 (예전 : 고른 달과 상관없이 이번 달부터 10개월로 적음) */
      ws.getCell(3, 1).value = (EN ? [fm.length ? 'FIRM = confirmed order (' + rg(fm) + ') — please keep the quantity and delivery date' : '', fc.length ? 'FORECAST = forecast for planning (' + rg(fc) + ') — not confirmed' : '', ms.some(x => x.past) ? 'PAST = previous months (record)' : '']
        : [fm.length ? 'FIRM = 확정 발주 (' + rg(fm) + ') · 납기 · 수량을 지켜 주세요' : '', fc.length ? 'FORECAST = 예상 (' + rg(fc) + ') · 생산 · 자재 준비용, 확정 아님' : '', ms.some(x => x.past) ? 'PAST = 지난 달 기록' : '']).filter(Boolean).join('   |   ');
      ws.getCell(3, 1).font = { size: 10, color: { argb: 'FF475569' } };
      if (b.memo) { ws.getCell(4, 1).value = EN ? 'Note : ' + String(b.memoEn || TR(String(b.memo))).slice(0, 800) : '전달 사항 : ' + String(b.memo).slice(0, 500); ws.getCell(4, 1).font = { size: 10, bold: true, color: { argb: 'FF9A3412' } }; }
      const head1 = ['', '', '', ''].concat(ms.map(x => x.past ? 'PAST' : x.firm ? 'FIRM' : 'FORECAST')).concat(['', '']);
      const head2 = (EN ? ['Part No.', 'Description', 'Unit', 'Lead time (days)'] : ['품번 (P/N)', '품명 (Description)', '단위', '리드타임(일)']).concat(ms.map(x => x.m.slice(2).replace('-', '.'))).concat(EN ? ['Total (FIRM)', 'Remarks'] : ['합계 (FIRM)', '메모 (Remarks)']);
      ws.getRow(5).values = head1; ws.getRow(6).values = head2;
      const FIRM = 'FFDCFCE7', FC = 'FFE0E7FF';
      [5, 6].forEach(rn => { const r = ws.getRow(rn); r.font = { bold: true }; r.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true }; r.height = rn === 6 ? 30 : 18; });
      ms.forEach((x, i) => { [5, 6].forEach(rn => { ws.getCell(rn, 5 + i).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: x.past ? 'FFE5E7EB' : x.firm ? FIRM : FC } }; }); });
      let rn = 7;
      keys.forEach(k => {
        const m = MM[k] || {}, pr = P[k] || {}, mo = [];
        const vals = ms.map(x => pr[x.m] && pr[x.m].qty != null ? Number(pr[x.m].qty) : null);
        const memos = ms.map(x => pr[x.m] && pr[x.m].memo ? x.m.slice(2).replace('-', '.') + ' ' + TR(pr[x.m].memo) : '').filter(Boolean);
        if (N[k]) memos.unshift(TR(N[k]));
        const firmSum = vals.reduce((a, v, i) => a + (ms[i].firm ? (v || 0) : 0), 0);
        ws.getRow(rn).values = [m.code || k, TR(m.name || ''), m.unit || 'EA', m.lead || ''].concat(vals).concat([firmSum || null, memos.join(' / ')]);
        ms.forEach((x, i) => { const c2 = ws.getCell(rn, 5 + i); c2.numFmt = '#,##0'; c2.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: x.past ? 'FFF3F4F6' : x.firm ? 'FFF0FDF4' : 'FFF5F7FF' } }; });
        ws.getCell(rn, 5 + ms.length).numFmt = '#,##0'; ws.getCell(rn, 5 + ms.length).font = { bold: true };
        ws.getCell(rn, 6 + ms.length).alignment = { wrapText: true, vertical: 'top' };
        rn++;
      });
      const tr = ws.getRow(rn); tr.getCell(1).value = EN ? 'TOTAL' : '합계 (TOTAL)'; tr.font = { bold: true };
      ms.forEach((x, i) => { const col = ws.getColumn(5 + i).letter; tr.getCell(5 + i).value = { formula: 'SUM(' + col + '7:' + col + (rn - 1) + ')' }; tr.getCell(5 + i).numFmt = '#,##0'; });
      const cl = ws.getColumn(5 + ms.length).letter; tr.getCell(5 + ms.length).value = { formula: 'SUM(' + cl + '7:' + cl + (rn - 1) + ')' }; tr.getCell(5 + ms.length).numFmt = '#,##0';
      ws.columns.forEach((col, i) => { col.width = i === 0 ? 18 : i === 1 ? 36 : i === 2 ? 7 : i === 3 ? 10 : i === 5 + ms.length ? 48 : 11; });
      for (let r2 = 5; r2 <= rn; r2++) ws.getRow(r2).eachCell({ includeEmpty: true }, c2 => { c2.border = { top: { style: 'thin', color: { argb: 'FFCBD5E1' } }, bottom: { style: 'thin', color: { argb: 'FFCBD5E1' } }, left: { style: 'thin', color: { argb: 'FFCBD5E1' } }, right: { style: 'thin', color: { argb: 'FFCBD5E1' } } }; });
      ws.pageSetup.printTitlesRow = '5:6';
      const buf = await wb.xlsx.writeBuffer();
      return { buf: Buffer.from(buf), fn: 'SL_' + (sup || 'ALL').replace(/[\\/:*?"<>|\s]+/g, '_') + '_' + today() + '.xlsx', n: keys.length, from: ms[0].m, to: ms[ms.length - 1].m, nm: ms.length, lang: EN ? 'en' : 'ko', trLeft };
  }
  app.post('/apps/material/api/po/export', J, async (req, res) => {
    const u = await who(req, res); if (!u) return;
    try {
      const x = await poXlsx(u, req.body || {});
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', "attachment; filename*=UTF-8''" + encodeURIComponent(x.fn));
      res.end(x.buf);
    } catch (e) { res.status(400).json({ success: false, message: String(e.message || e) }); }
  });
  /* [v0.53.72] 소진 후 단종 (재주문 안 함) 스위치 — app_props 'mm_eol' { overrides: { 품번키: true|false } } · 기본 = 진영전기 와이어하네스 15개
     계산 모델은 그대로 두고, 화면 · 메일이 계산할 때 m.eol 로 얹는다 (다시 계산 필요 없음)
     [v0.53.92 고침] db() 는 { data, headers } 를 돌려주는데 r[0] 을 읽어 저장값이 늘 비어 보였다 → 화면에 켠 스위치가 안 보이고,
     켜고 끌 때마다 예전 스위치를 지운 채 이번 것 하나만 저장했다. r.data[0] 을 읽는다 (메일 · AI 는 처음부터 바르게 읽음) */
  app.get('/apps/material/api/eol', async (req, res) => {
    const u = await who(req, res); if (!u) return;
    try { const r = await db('GET', 'app_props?select=value&key=eq.mm_eol&limit=1'); let v = {}; try { v = JSON.parse((r && r.data && r.data[0] && r.data[0].value) || '{}') || {}; } catch (e) {} res.json({ success: true, overrides: v.overrides || {}, defaults: [...R.EOL_DEFAULT], by: v.by || '', at: v.at || '' }); }
    catch (e) { res.status(400).json({ success: false, message: String(e.message || e) }); }
  });
  app.post('/apps/material/api/eol', J, async (req, res) => {
    const u = await who(req, res); if (!u) return;
    try {
      const k = R.partKey(S((req.body || {}).k)), on = !!(req.body || {}).on;
      if (!k) throw new Error('품번이 없습니다.');
      const r = await db('GET', 'app_props?select=value&key=eq.mm_eol&limit=1'); let v = {}; try { v = JSON.parse((r && r.data && r.data[0] && r.data[0].value) || '{}') || {}; } catch (e) {}
      const ov = v.overrides || {};
      if (on === R.EOL_DEFAULT.has(k)) delete ov[k]; else ov[k] = on;   /* 기본값과 같으면 지운다 */
      await db('POST', 'app_props?on_conflict=key', [{ key: 'mm_eol', value: JSON.stringify({ overrides: ov, by: u.name || u.id, at: new Date().toISOString() }), updated_at: new Date().toISOString() }], 'resolution=merge-duplicates,return=minimal');
      try { require('../lib/audit').auditLog_(u.id, '자재관리', '소진 후 단종 ' + (on ? '켬' : '끔'), k, true, u.name); } catch (e) {}
      res.json({ success: true, overrides: ov, k, on });
    } catch (e) { res.status(400).json({ success: false, message: String(e.message || e) }); }
  });
  /* [v0.53.103] 리드타임 읽기 · 고치기 · 되돌리기 (자재관리 권한 · 감사 기록 · 저장하면 다시 계산) */
  app.get('/apps/material/api/lead', async (req, res) => {
    const u = await who(req, res); if (!u) return;
    try { res.setHeader('Cache-Control', 'no-store'); res.json({ success: true, overrides: await leadOverrides() }); } catch (e) { res.status(400).json({ success: false, message: String(e.message || e) }); }
  });
  app.post('/apps/material/api/lead', J, async (req, res) => {
    const u = await who(req, res); if (!u) return;
    try {
      const b = req.body || {}, k = R.partKey(S(b.k)), reset = b.days === null || b.days === undefined || b.days === '';
      if (!k) throw new Error('품번이 없습니다.');
      const d = reset ? null : Number(b.days);
      if (!reset && !(Number.isInteger(d) && d >= 1 && d <= 365)) throw new Error('리드타임은 1 ~ 365 일 사이 정수로 넣어 주세요.');
      const it = (((await db('GET', 'mm_item?select=lead_days&part_key=eq.' + encodeURIComponent(k) + '&limit=1')).data) || [])[0] || {}, item = N(it.lead_days) > 0 ? N(it.lead_days) : null;
      const ov = await leadOverrides(), prev = ov[k] ? N(ov[k].d) : null;
      if (reset || d === item) delete ov[k];   /* 기준표 값과 같으면 지운다 (기준표 값을 그대로 씀) */
      else ov[k] = { d, by: S(u.name || u.id).slice(0, 40), at: new Date().toISOString(), item };
      await db('POST', 'app_props?on_conflict=key', [{ key: LEAD_KEY, value: JSON.stringify({ overrides: ov, by: u.name || u.id, at: new Date().toISOString() }), updated_at: new Date().toISOString() }], 'resolution=merge-duplicates,return=minimal');
      try { require('../lib/audit').auditLog_(u.id, '자재관리', '리드타임 ' + (ov[k] ? '수정' : '되돌리기'), k + ' : ' + (prev || item || '기본값') + '일 → ' + (ov[k] ? d + '일' : (item ? '기준표 ' + item + '일' : '기본값')), true, u.name); } catch (e) {}
      GEN++; CACHE = null; clearTimeout(WARM); WARM = setTimeout(() => { model().catch(() => {}); }, 1500);   /* 다음 요청 · 메일은 새 리드타임으로 */
      res.json({ success: true, k, edited: !!ov[k], days: ov[k] ? d : null, item, by: ov[k] ? ov[k].by : '', at: ov[k] ? ov[k].at : '' });
    } catch (e) { res.status(400).json({ success: false, message: String(e.message || e) }); }
  });
  /* [v0.53.115] 같은 자재 합치기 : 읽기 · 저장 (자재관리 권한 · 감사 기록 · 저장하면 다시 계산) */
  app.get('/apps/material/api/alias', async (req, res) => {
    const u = await who(req, res); if (!u) return;
    try { res.setHeader('Cache-Control', 'no-store'); res.json({ success: true, pairs: await aliasList() }); } catch (e) { res.status(400).json({ success: false, message: String(e.message || e) }); }
  });
  app.post('/apps/material/api/alias', J, async (req, res) => {
    const u = await who(req, res); if (!u) return;
    try {
      const inp = Array.isArray((req.body || {}).pairs) ? req.body.pairs.slice(0, 300) : null; if (!inp) throw new Error('합칠 목록이 없습니다.');
      const old = await aliasList(), oldOf = {}; old.forEach(p => { oldOf[R.partKey(p.from) + '>' + R.partKey(p.to)] = p; });
      const out = [], seen = {}, now = new Date().toISOString(), by = S(u.name || u.id).slice(0, 40);
      for (const p of inp) {
        const f = R.partKey(S(p.from)), t = R.partKey(S(p.to));
        if (!f && !t) continue;
        if (!f || !t) throw new Error('합칠 품번과 남길 품번을 모두 넣어 주세요 : ' + (S(p.from) || S(p.to)));
        if (f === t) throw new Error('같은 품번은 합칠 수 없습니다 : ' + S(p.from));
        if (seen[f]) throw new Error('같은 품번을 두 번 합칠 수 없습니다 : ' + S(p.from));
        seen[f] = t;
        const o = oldOf[f + '>' + t];
        out.push({ from: S(p.from).slice(0, 60), to: S(p.to).slice(0, 60), note: S(p.note).slice(0, 200), by: o ? o.by : by, at: o ? o.at : now });
      }
      for (const f of Object.keys(seen)) if (seen[seen[f]]) throw new Error('남길 품번이 다시 다른 품번으로 합쳐집니다 (이어서 합치기 안 됨) : ' + f + ' → ' + seen[f] + ' → ' + seen[seen[f]]);
      await db('POST', 'app_props?on_conflict=key', [{ key: ALIAS_KEY, value: JSON.stringify({ pairs: out, by, at: now }), updated_at: now }], 'resolution=merge-duplicates,return=minimal');
      const was = old.map(p => R.partKey(p.from) + '→' + R.partKey(p.to)), now2 = out.map(p => R.partKey(p.from) + '→' + R.partKey(p.to));
      const add = now2.filter(x => was.indexOf(x) < 0), del = was.filter(x => now2.indexOf(x) < 0);
      try { require('../lib/audit').auditLog_(u.id, '자재관리', '같은 자재 합치기', (add.length ? '더함 ' + add.join(', ') : '') + (add.length && del.length ? ' / ' : '') + (del.length ? '뺌 ' + del.join(', ') : '') || '바뀐 것 없음', true, u.name); } catch (e) {}
      GEN++; CACHE = null; clearTimeout(WARM);
      await model(false);   /* 바로 다시 계산 (화면이 새 모델을 받음) */
      res.json({ success: true, pairs: out });
    } catch (e) { res.status(400).json({ success: false, message: String(e.message || e) }); }
  });
  /* [v0.53.110] 휴면 재고 지정 · 되돌리기 (on : true = 휴면으로 · false = 휴면이 아닌 재고로 · null = 자동 판정으로) */
  app.get('/apps/material/api/dorm', async (req, res) => {
    const u = await who(req, res); if (!u) return;
    try { res.setHeader('Cache-Control', 'no-store'); res.json({ success: true, overrides: await dormOverrides() }); } catch (e) { res.status(400).json({ success: false, message: String(e.message || e) }); }
  });
  app.post('/apps/material/api/dorm', J, async (req, res) => {
    const u = await who(req, res); if (!u) return;
    try {
      const b = req.body || {}, k = R.partKey(S(b.k));
      if (!k) throw new Error('품번이 없습니다.');
      if (!(b.on === true || b.on === false || b.on === null)) throw new Error('휴면 지정 값이 이상합니다.');
      const ov = await dormOverrides(), prev = ov[k] ? ov[k].on : null;
      if (b.on === null) delete ov[k]; else ov[k] = { on: b.on, by: S(u.name || u.id).slice(0, 40), at: new Date().toISOString() };
      await db('POST', 'app_props?on_conflict=key', [{ key: DORM_KEY, value: JSON.stringify({ overrides: ov, by: u.name || u.id, at: new Date().toISOString() }), updated_at: new Date().toISOString() }], 'resolution=merge-duplicates,return=minimal');
      const nm = v => v === true ? '휴면으로' : v === false ? '휴면 아님' : '자동 판정';
      try { require('../lib/audit').auditLog_(u.id, '자재관리', '휴면 재고 지정', k + ' : ' + nm(prev) + ' → ' + nm(b.on), true, u.name); } catch (e) {}
      GEN++; CACHE = null; clearTimeout(WARM); WARM = setTimeout(() => { model().catch(() => {}); }, 1500);   /* 다음 요청 · 메일은 새 판정으로 */
      res.json({ success: true, k, on: ov[k] ? ov[k].on : null, by: ov[k] ? ov[k].by : '', at: ov[k] ? ov[k].at : '' });
    } catch (e) { res.status(400).json({ success: false, message: String(e.message || e) }); }
  });
  /* [v0.53.57] 품번 변경 규칙 읽기 · 저장 (저장하면 다시 계산) */
  app.get('/apps/material/api/subst', async (req, res) => {
    const u = await who(req, res); if (!u) return;
    try { const c = await model(false); res.json({ success: true, rules: await substRules(), info: c.data.subst || [] }); } catch (e) { res.status(400).json({ success: false, message: String(e.message || e) }); }
  });
  app.post('/apps/material/api/subst', J, async (req, res) => {
    const u = await who(req, res); if (!u) return;
    try {
      const rules = (Array.isArray((req.body || {}).rules) ? req.body.rules : []).slice(0, 500).map(r => ({ fg: S(r.fg).slice(0, 60), fgName: S(r.fgName).slice(0, 120), neu: S(r.neu).slice(0, 60), old: S(r.old).slice(0, 200), from: S(r.from).slice(0, 10), sup: S(r.sup).slice(0, 60), note: S(r.note).slice(0, 300) })).filter(r => r.fg || r.neu);
      for (const r of rules) if (!r.fg || !r.neu || !/^\d{4}-\d{2}-\d{2}$/.test(r.from)) throw new Error('완성품 · 새 품번 · 적용일(YYYY-MM-DD)을 모두 넣어 주세요 : ' + (r.fg || r.neu));
      await db('POST', 'app_props?on_conflict=key', [{ key: SUBST_KEY, value: JSON.stringify(rules), updated_at: new Date().toISOString() }], 'resolution=merge-duplicates,return=minimal');
      GEN++; CACHE = null;
      const c = await model(false);
      res.json({ success: true, rules, info: c.data.subst || [] });
    } catch (e) { res.status(400).json({ success: false, message: String(e.message || e) }); }
  });
  app.get('/apps/material/api/inbound', async (req, res) => {
    const u = await who(req, res); if (!u) return;
    try { res.setHeader('Cache-Control', 'no-store'); const r = await db('GET', 'mm_inbound?select=*&order=due.asc,id.asc&limit=20000'); res.json({ success: true, rows: await inRows(r.data), ship: await shipReady() }); } catch (e) { inFail(res, e); }
  });
  const inPost = (p, fn) => app.post(p, J, async (req, res) => {
    const u = await who(req, res); if (!u) return;
    try { await fn(u, req.body || {}); GEN++;   /* [v0.53.27] 입고 확인 · 보유수량은 재고 계산에 들어가므로 모델을 다시 만든다 */
      const r = await db('GET', 'mm_inbound?select=*&order=due.asc,id.asc&limit=20000'); res.json({ success: true, rows: await inRows(r.data), ship: await shipReady() }); } catch (e) { inFail(res, e); }
  });
  /* [v0.53.27] 종류 : plan(입고 예정 · 앞날 계산에만) · rcv(입고 확인 = 실제 입고 · 재고에 더함 · 지난 날짜 기록 가능) · count(보유수량 맞추기 · 그날 실제 보유 수량)
     예정을 [입고 확인] 하면 원래 예정일 · 수량(due · qty)은 남기고 실제 날짜 · 수량(act_date · act_qty)을 적는다 */
  const isDate = d => /^\d{4}-\d{2}-\d{2}$/.test(d) && !isNaN(Date.parse(d + 'T00:00:00Z'));
  inPost('/apps/material/api/inbound/save', async (u, b) => {
    const k = String(b.k || '').trim(), due = String(b.due || '').trim(), qty = Number(String(b.qty == null ? '' : b.qty).replace(/,/g, ''));
    const kind = ['plan', 'rcv', 'count'].indexOf(b.kind) > -1 ? b.kind : 'plan';
    if (!k) throw new Error('자재를 골라 주세요.');
    if (!isDate(due)) throw new Error(kind === 'count' ? '보유수량을 센 날짜를 넣어 주세요.' : kind === 'rcv' ? '입고된 날짜를 넣어 주세요.' : '입고 예정일을 넣어 주세요.');
    if (kind !== 'plan' && (kind === 'rcv' && String(b.adate || '').trim() ? String(b.adate).trim() : due) > today()) throw new Error(kind === 'count' ? '보유수량은 오늘까지의 날짜로만 넣습니다.' : '입고 확인은 오늘까지의 날짜로만 넣습니다 (앞날은 입고 예정으로).');
    if (!isFinite(qty) || Math.abs(qty) > 1e9 || (kind !== 'count' && !qty) || (kind === 'count' && String(b.qty == null ? '' : b.qty).trim() === '')) throw new Error(kind === 'count' ? '실제 보유 수량을 넣어 주세요 (0 도 됩니다).' : '수량을 넣어 주세요 (줄일 때는 − : 예 −200).');
    let ad = String(b.adate || '').trim(), aq = b.aqty == null || b.aqty === '' ? null : Number(String(b.aqty).replace(/,/g, ''));
    if (kind === 'rcv' && ad) { if (!isDate(ad) || ad > today()) throw new Error('실제 입고일은 오늘까지의 날짜로 넣어 주세요.'); if (aq === null || !isFinite(aq) || !aq) throw new Error('실제 입고 수량을 넣어 주세요.'); }
    if (kind === 'plan') { ad = ''; aq = null; } else if (kind === 'count') { ad = ''; aq = aq !== null && isFinite(aq) ? aq : null; }   /* count : act_qty = 맞출 때 계산 재고와의 차이 (기록용) */
    const row = { part_key: k.slice(0, 80), part_no: String(b.code || '').slice(0, 80), due, qty, kind, act_date: ad || null, act_qty: aq, done: kind === 'rcv' && b.sep === true,   /* [v0.53.110] rcv 의 done = 입고일 앞 MES 와 다른 입고 (따로 더함) */ memo: String(b.memo || '').slice(0, 200), updated_by: String(u.name || u.id || ''), updated_at: new Date().toISOString() };
    if (b.id) await db('PATCH', 'mm_inbound?id=eq.' + Number(b.id), row);
    else await db('POST', 'mm_inbound', [Object.assign({ created_by: row.updated_by }, row)]);
  });
  /* [v0.53.111] 협력사 발송 기록 : plan = 출발 예정일 · date = 실제 출발일(발송 확인 · 오늘까지) · no = 운송장 / B/L — 셋 다 비우면 지움 · 입고 예정 · 입고 확인 건에만 */
  inPost('/apps/material/api/inbound/ship', async (u, b) => {
    if (!(await shipReady())) { const e = new Error(SHIP_SQL); e.shipCol = true; throw e; }
    const id = Number(b.id); if (!(id > 0)) throw new Error('없는 입고 예정입니다.');
    const x = (((await db('GET', 'mm_inbound?select=id,kind&id=eq.' + id)).data) || [])[0];
    if (!x) throw new Error('없는 입고 예정입니다 (이미 지워졌을 수 있습니다).');
    if ((x.kind || 'plan') === 'count') throw new Error('보유수량 맞추기에는 발송을 적지 않습니다.');
    const plan = String(b.plan || '').trim(), date = String(b.date || '').trim(), no = String(b.no || '').trim().slice(0, 80);
    if (plan && !isDate(plan)) throw new Error('출발 예정일 날짜가 이상합니다.');
    if (date && !isDate(date)) throw new Error('실제 출발일 날짜가 이상합니다.');
    if (date && date > today()) throw new Error('실제 출발일은 오늘까지의 날짜로 넣어 주세요 (앞날은 출발 예정일로).');
    const clear = !plan && !date && !no, now = new Date().toISOString();
    await db('PATCH', 'mm_inbound?id=eq.' + id, { ship_plan: plan || null, ship_date: date || null, ship_no: no || null, ship_by: clear ? null : String(u.name || u.id || '').slice(0, 40), ship_at: clear ? null : now, updated_at: now });
  });
  inPost('/apps/material/api/inbound/done', async (u, b) => { if (!b.id) throw new Error('없는 예정입니다.'); await db('PATCH', 'mm_inbound?id=eq.' + Number(b.id), { done: !!b.done, updated_by: String(u.name || u.id || ''), updated_at: new Date().toISOString() }); });
  inPost('/apps/material/api/inbound/del', async (u, b) => { if (!b.id) throw new Error('없는 예정입니다.'); await db('DELETE', 'mm_inbound?id=eq.' + Number(b.id)); });
  /* [v0.53.19] 여러 건 한 번에 : 입고 완료 · 되돌리기 · 삭제 (입고 예정 관리 화면) */
  inPost('/apps/material/api/inbound/bulk', async (u, b) => {
    const ids = (Array.isArray(b.ids) ? b.ids : []).map(Number).filter(n => n > 0).slice(0, 1000);
    if (!ids.length) throw new Error('고른 예정이 없습니다.');
    const f = 'mm_inbound?id=in.(' + ids.join(',') + ')';
    if (b.act === 'del') await db('DELETE', f);
    else if (b.act === 'done' || b.act === 'undo') await db('PATCH', f, { done: b.act === 'done', updated_by: String(u.name || u.id || ''), updated_at: new Date().toISOString() });
    else if (b.act === 'rcv') {   /* [v0.53.27] 지연 예정 한 번에 입고 확인 : 예정일 · 예정 수량 그대로 실제 입고로 (오늘 뒤 날짜는 오늘로) */
      const rows = (await db('GET', f.replace('mm_inbound?', 'mm_inbound?select=id,due,qty&'))).data || [], t = today();
      for (const r of rows) await db('PATCH', 'mm_inbound?id=eq.' + r.id, { kind: 'rcv', act_date: String(r.due).slice(0, 10) > t ? t : String(r.due).slice(0, 10), act_qty: r.qty, done: false, updated_by: String(u.name || u.id || ''), updated_at: new Date().toISOString() });
    }
    else throw new Error('할 일을 알 수 없습니다.');
  });
  const post = (p, fn) => app.post(p, J, async (req, res) => {
    const u = await who(req, res, true); if (!u) return;
    try { res.json(Object.assign({ success: true }, await fn(u, req.body || {}))); }
    catch (e) { try { if (req.body && req.body.id && p !== '/apps/material/api/upload/cancel') await uploadCancel(u, { id: req.body.id, reason: e.message }); } catch (x) {} fail(res, e); }
  });
  post('/apps/material/api/upload/start', uploadStart);
  post('/apps/material/api/upload/chunk', uploadChunk);
  post('/apps/material/api/upload/finish', uploadFinish);
  post('/apps/material/api/upload/cancel', uploadCancel);
  /* [v0.53.104] 무상출고요청 (api/material-free.js) — 입고 예정 · 출고(− 수량)를 mm_inbound 에 쓰므로 바꾸면 모델을 다시 만든다 */
  require('./material-free').mount(app, { userFromRequest_, J, canView, model, bump: () => { GEN++; CACHE = null; clearTimeout(WARM); WARM = setTimeout(() => { model().catch(() => {}); }, 1500); } });
  setTimeout(() => { if (require('../lib/supabase').supaReady_ && require('../lib/supabase').supaReady_()) model().catch(() => {}); }, 20000).unref();   // [v0.53.1] 서버가 켜지면 미리 계산해 둔다
  setInterval(() => { const now = Date.now(); Object.keys(JOBS).forEach(id => { if (now - JOBS[id].at > 30 * 60000) { uploadCancel(null, { id, reason: '30분 동안 이어지지 않음' }).catch(() => {}); } }); }, 10 * 60000).unref();
}

module.exports = { mount, buildBom, explode, parsePlan, model, _model: model, _gen: () => GEN, BASE_DATE, baseDateOf, canView, _substRules: substRules, _substPrepare: substPrepare };   /* [v0.53.69] 시험용 : 품번 변경 규칙 */
