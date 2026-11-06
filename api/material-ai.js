/**
 * 파일명: api/material-ai.js   [v0.53.92 · 사용자 요청 2026-11-04]
 * 목적: 메인 AI 검색이 '자재관리' 숫자를 읽게 한다. (gas/patches/AiSearchZ3_BomMaterialMl.patch.gs 의 lookup_material_stock)
 *
 * [무엇이 안 됐나]
 *   AI 도구 가운데 자재관리를 읽는 것이 없어, "자재관리 인플레이터 부족재고 알려줘" 를 물으면
 *   완성품(모품번) 재고(lookup_stock_avail · lookup_metric)가 답으로 나왔다.
 *   AI 도구는 작업자(worker)의 vm 안에서 도는 옛 GAS 코드라 Node 모듈(api/material.js · material-engine.js)을 부를 수 없다.
 * [바꾼 것]
 *   자재관리 화면 · 자동 메일(api/material-mail.js items_)과 '같은 모델(api/material.js model) · 같은 엔진(api/material-engine.js) ·
 *   같은 분류(material-mail 의 clsOf_ : ★ 인플레이터 INF · ★ OPW · ★ 와이어하네스 WH) · 같은 소진 후 단종 스위치(app_props mm_eol)' 로
 *   자재마다 한 줄 요약을 만든다. 작업자는 lib/gas-runtime/host.js 의 rpc 'mm' 으로 이 모듈을 부른다 (worker.js 의 __mmRows).
 *     줄 : { k, code, name, sup, region, unit, cls, infEtc, gubun, jg, stock, r(하루 사용), out(소진 예상일), D(남은 일수),
 *            orderBy(발주 권장일), orderD, lead, leadAssumed, status, act, known, usedInCount, live(60일 안 생산계획 있는 완성품 수), eol, pln(다음 입고 예정) }
 *     meta : { baseDate, ver, today, actEnd, planEnd, count }
 *   계산 결과는 (모델 버전 · 기준일 · 단종 스위치)가 같으면 다시 셈하지 않는다.
 */
const E = require('./material-engine');
const R = require('./material-rules');
const { supaGetJson_ } = require('../lib/supabase');

let getModel = null;   /* 시험에서 바꿔 끼울 수 있게 (_setModel) — 기본은 api/material.js 의 model(서버 메모리 한 벌) */
const modelFn = () => getModel || require('./material').model;
const todayKst = () => new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
const r3 = v => (v === null || v === undefined || !isFinite(v)) ? null : Math.round(v * 1000) / 1000;
let MEMO = null;

/* 소진 후 단종 스위치 : 화면 · 메일과 같은 값 (기본 = 진영전기 와이어하네스 + app_props mm_eol 의 overrides) */
async function eolOverrides() {
  try { const r = await supaGetJson_('app_props?select=value&key=eq.mm_eol&limit=1'); return ((JSON.parse((r && r[0] && r[0].value) || '{}') || {}).overrides) || {}; }
  catch (e) { return {}; }
}

/** 모델 하나 → 자재 줄 (메일 items_ 와 같은 prep · calc · actOf · clsOf_) */
function buildRows(MODEL, today, eolOver) {
  const M = require('./material-mail');
  const eng = E.create(MODEL);
  const prods = {}; (MODEL.products || []).forEach(p => { prods[p.k] = p; });
  const rows = [];
  (MODEL.materials || []).forEach(src => {
    const m = eng.prep(Object.assign(JSON.parse(JSON.stringify(src)), { eol: R.eolOf(src.k, eolOver || {}) }));
    const r = eng.calc(m, today), a = eng.actOf(r, today);
    const cls = M.clsM_ ? M.clsM_(m, prods) : M.clsOf_(m.name, m.code);   /* [v0.53.115] ★ FRT 버클 (BKL) 포함 */
    const live = (m.usedIn || []).filter(k => { const p = prods[k]; return p && (p.plan || []).some(([d]) => d > today && E.diffDays(d, today) <= 60); }).length;
    const pl = (r.pln || []).filter(([d]) => d >= today);
    rows.push({
      k: m.k, code: m.code || m.k, name: m.name || '', sup: m.sup || '', region: m.region || '', unit: m.unit || '',
      cls, infEtc: !cls && M.isInf_(m.name) ? 1 : 0, gubun: m.gubun || '', jg: m.jg ? 1 : 0,
      stock: r.known ? r3(r.stock) : null, r: r3(r.r), out: r.out || null, D: r.D, orderBy: r.orderBy || null, orderD: r.orderD,
      lead: m.lead, leadAssumed: m.leadAssumed ? 1 : 0, status: r.status, act: a || '', known: !!r.known,
      usedInCount: (m.usedIn || []).length, live, eol: m.eol ? 1 : 0,
      pln: pl.length ? [pl[0][0], r3(pl[0][1]), pl.length, r3(pl.reduce((t, p) => t + p[1], 0))] : null
    });
  });
  return rows;
}

/** rpc 'mm' : q = { today?: 'YYYY-MM-DD' } (작업자 시계와 맞추려고 AI 쪽이 넘긴다 · 없으면 한국 오늘) */
async function rows(q) {
  q = q || {};
  const today = /^\d{4}-\d{2}-\d{2}$/.test(String(q.today || '')) ? String(q.today) : todayKst();
  const c = await modelFn()(false);
  const MODEL = c && c.data;
  if (!MODEL || !Array.isArray(MODEL.materials)) throw new Error('자재관리 계산 자료가 아직 없습니다. 잠시 뒤 다시 해 주세요.');
  const eolOver = await eolOverrides();
  const key = String(MODEL.ver || c.ver || '') + '|' + today + '|' + JSON.stringify(eolOver);
  if (!MEMO || MEMO.key !== key) {
    const list = buildRows(MODEL, today, eolOver);
    MEMO = { key, out: { meta: { baseDate: MODEL.baseDate, ver: MODEL.ver || c.ver || '', today, actEnd: MODEL.actEnd || '', planEnd: MODEL.planEnd || '', count: list.length }, rows: list } };
  }
  return MEMO.out;
}

module.exports = { rows, buildRows, _setModel: fn => { getModel = fn; MEMO = null; } };
