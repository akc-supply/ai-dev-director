/**
 * 파일명: api/material-mail.js   [v0.53.5 · 사용자 요청 2026-10-22]
 * 목적: 자재관리 — '즉시 조달(결품)' · '이번 주 발주(발주 권장일 7일 안 · 지난 것 포함)' 자재를 모아
 *       정해 둔 간격 · 시각(한국 시각)에 사내 다른 팀에게 메일로 자동 공유한다. VF 매출채권 자동 메일(api/vffin-mail.js)과 같은 틀.
 *
 *   · 계산 : 화면과 같은 엔진(api/material-engine.js) · 같은 모델(api/material.js 서버 계산 한 벌) → 화면 숫자와 메일 숫자가 같다
 *   · 범위 : 설정에서 고른다 — 즉시 조달 / 이번 주 발주 / 4주 안 발주 · 해외 · 국내 · JG 제외 · 상품 제외 (기본 = 대시보드 기본값)
 *   · 발송 : 인보이스 메일과 같은 회사 메일 계정 (lib/mailer.js invSend) · 보내는 사람 이름 'AKC 자재관리 알림'
 *   · 자동 : 켜기/끄기 · 간격(며칠마다) · 시각(한국) · 주말 건너뛰기. 서버가 1분마다 확인하고, 오늘 이미 보냈거나 해 봤으면 다시 보내지 않는다
 *   · 설정 · 기록 : app_props 'MAT_MAIL_SETTINGS' · 'MAT_MAIL_STATE' · 'MAT_MAIL_LOG' (SQL 필요 없음)
 *   · 사내 메일이므로 한글을 쓴다 (VF 매출채권 메일은 고객용이라 영문만)
 *   · [v0.53.98] 화면 이름 「이메일 설정」 · 본문 다시 만듦(칸 7개 · 📦 발주 완료 · 입고 확인 묶음 · 자료 기준 · 오래된 자료 경고)
 */
const mailer = require('../lib/mailer');
const { supaFetch_, supaGetJson_ } = require('../lib/supabase');
const E = require('./material-engine');

const SET_KEY = 'MAT_MAIL_SETTINGS', STATE_KEY = 'MAT_MAIL_STATE', LOG_KEY = 'MAT_MAIL_LOG';
const TZ = 'Asia/Seoul';
/* [v0.53.98] 기본 본문을 짧게 : 기준 · 용어 설명은 {SUMMARY} 아래 「자료 기준 · 범위 · 읽는 법」 칸이 대신한다 */
const DEFAULT_BODY =
  '안녕하세요.\n' +
  '{DATE} 기준 자재 조달 · 발주 알림을 공유드립니다.\n\n' +
  '{SUMMARY}\n\n' +
  '{TABLES}\n\n' +
  '자세한 내용은 AKC SYSTEM › 업무 › 자재관리에서 확인하실 수 있습니다. {LINK}\n\n' +
  '감사합니다.\n' +
  '{SIGNATURE}';
const DEFAULTS = {
  enabled: false,
  /* [v0.53.70] 묶음(넣을 범위)마다 따로 예약 : 켜기 · 시각(한국) · 매일 / 요일 선택(여러 요일 · 매주) — 예전 '며칠마다 · 주말 건너뛰기' 를 바꿈 */
  schedules: { all: { on: false, time: '08:30', mode: 'weekly', days: [1, 2, 3, 4, 5] }, ovs: { on: false, time: '08:30', mode: 'weekly', days: [1, 2, 3, 4, 5] }, inf: { on: false, time: '08:30', mode: 'weekly', days: [1, 2, 3, 4, 5] } },
  to: '', cc: '',
  scope: { preset: 'all', now: true, wk: true, m1: false, region: '', noJG: true, noGoods: true },
  fromName: 'AKC 자재관리 알림',
  subject: '[AKC 자재관리] 즉시 조달 {NOW}건 · 이번 주 발주 {WK}건 ({DATE})',
  body: DEFAULT_BODY,
  signature: '영업팀\n아시모리코리아(주)',
  footer: '이 메일은 AKC SYSTEM 이 자동으로 보낸 메일입니다.',
  link: ''
};
const EMAIL = /^[^\s@<>"';,]+@[^\s@<>"';,]+\.[^\s@<>"';,]+$/;
const clip = (s, n) => String(s == null ? '' : s).slice(0, n);
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const WD = ['일', '월', '화', '수', '목', '금', '토'];

function nowKst_(d) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short' })
    .formatToParts(d || new Date()).reduce((o, x) => { o[x.type] = x.value; return o; }, {});
  return { ymd: p.year + '-' + p.month + '-' + p.day, hm: p.hour + ':' + p.minute, wd: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday) };
}
const dayNum_ = ymd => { const m = String(ymd || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000 : NaN; };
const ymdOf_ = n => new Date(n * 86400000).toISOString().slice(0, 10);
const wdOf_ = ymd => new Date(dayNum_(ymd) * 86400000).getUTCDay();
function parseAddrs(text) {
  const out = [], seen = {}, s = String(text || '');
  const re = /(?:"([^"]*)"|'([^']*)'|([^<>;,\n"]*?))\s*<\s*([^<>\s]+)\s*>|([^\s<>;,"']+@[^\s<>;,"']+)/g;
  let m;
  while ((m = re.exec(s))) {
    const email = String(m[4] || m[5] || '').trim().replace(/^['"]+|['"]+$/g, '');
    if (!email || seen[email.toLowerCase()]) continue;
    seen[email.toLowerCase()] = true;
    const name = String(m[1] !== undefined ? m[1] : (m[2] !== undefined ? m[2] : (m[3] || ''))).replace(/^['"\s]+|['"\s]+$/g, '').trim();
    out.push({ name, address: email, valid: EMAIL.test(email) });
  }
  return out;
}

/* ── 설정 · 상태 · 기록 ── */
async function propGet_(key) { const r = await supaGetJson_('app_props?select=value&key=eq.' + encodeURIComponent(key) + '&limit=1'); return (r && r[0] && r[0].value != null) ? String(r[0].value) : null; }
async function propSet_(key, value) {
  const r = await supaFetch_('POST', 'app_props?on_conflict=key', [{ key, value: String(value), updated_at: new Date().toISOString() }], { Prefer: 'resolution=merge-duplicates,return=minimal' });
  if (!r.ok) throw new Error('저장하지 못했습니다 (HTTP ' + r.status + ')');
}
async function propJson_(key, dflt) { try { const v = await propGet_(key); return v ? JSON.parse(v) : dflt; } catch (e) { return dflt; } }
async function settings_() {
  const s = await propJson_(SET_KEY, {}) || {};
  const o = {};
  Object.keys(DEFAULTS).forEach(k => { if (k === 'scope' || k === 'schedules') return; o[k] = (s[k] === undefined || s[k] === null || (typeof DEFAULTS[k] === 'string' && ['footer', 'to', 'cc', 'link'].indexOf(k) < 0 && !String(s[k]).trim())) ? DEFAULTS[k] : s[k]; });
  if (isOldBody_(o.body)) o.body = DEFAULT_BODY;   /* [v0.53.98] 예전 기본 본문 그대로면 새 기본 본문 (고쳐 쓴 본문은 그대로) */
  o.scope = Object.assign({}, DEFAULTS.scope, s.scope || {});
  o.schedules = schedulesOf_(s);
  o.updatedBy = s.updatedBy || ''; o.updatedAt = s.updatedAt || '';
  return o;
}
/* [v0.53.70] 묶음별 예약 · 예전 설정 이어받기
 *   예전(v0.53.5~0.53.69) : 하나의 메일 = 고른 묶음(scope.preset) · intervalDays 일마다 · sendTime · skipWeekend
 *   → 그 묶음 하나만 켜고, 시각 그대로 · 주말 건너뛰기면 「월~금」, 아니면 「매일」 (며칠마다 2 이상은 매일로 바뀌고 legacyNote 로 알림) */
const PRESETS = ['all', 'ovs', 'inf'];
const PRESET_NAME = { all: '전체 (지금 고른 범위)', ovs: '해외 수입 자재만', inf: '★ 집중 관리' };
const TIME_RX = /^([01]\d|2[0-3]):[0-5]\d$/;
function cleanSch_(x, dflt) {
  const o = x && typeof x === 'object' ? x : {};
  const days = Array.from(new Set((Array.isArray(o.days) ? o.days : []).map(Number).filter(n => Number.isInteger(n) && n >= 0 && n <= 6))).sort((a, b) => a - b);
  return { on: !!o.on, time: TIME_RX.test(String(o.time || '')) ? String(o.time) : dflt.time, mode: o.mode === 'daily' ? 'daily' : 'weekly', days };
}
function schedulesOf_(s) {
  const out = {};
  if (s && s.schedules && typeof s.schedules === 'object') { PRESETS.forEach(p => { out[p] = cleanSch_(s.schedules[p], DEFAULTS.schedules[p]); if (out[p].mode === 'weekly' && !out[p].days.length) out[p].days = DEFAULTS.schedules[p].days.slice(); }); return out; }
  PRESETS.forEach(p => { out[p] = JSON.parse(JSON.stringify(DEFAULTS.schedules[p])); });
  if (s && (s.sendTime || s.intervalDays || s.enabled)) {   /* 예전 설정 */
    const p = PRESETS.indexOf(s.scope && s.scope.preset) > -1 ? s.scope.preset : 'all';
    out[p] = { on: true, time: TIME_RX.test(String(s.sendTime || '')) ? s.sendTime : '08:30', mode: s.skipWeekend === false ? 'daily' : 'weekly', days: s.skipWeekend === false ? [] : [1, 2, 3, 4, 5] };
    if (Number(s.intervalDays) > 1) out[p].legacyNote = '예전 설정 「' + s.intervalDays + '일마다」 는 매일 · 요일 방식으로 바뀌었습니다. 확인 후 저장해 주세요.';
  }
  return out;
}
const dayOk_ = (sch, wd) => sch.mode === 'daily' || (sch.days || []).indexOf(wd) > -1;
function schText_(sch) { if (!sch || !sch.on) return '꺼짐'; const d = sch.mode === 'daily' ? '매일' : (sch.days.length === 5 && [1, 2, 3, 4, 5].every(x => sch.days.indexOf(x) > -1) ? '월~금' : sch.days.length === 7 ? '매일' : '매주 ' + sch.days.map(x => WD[x]).join('·')); return d + ' ' + sch.time; }
function cleanSettings_(b) {
  const s = {};
  s.enabled = !!b.enabled;
  s.schedules = {};
  for (const p of PRESETS) {
    const x = (b.schedules || {})[p] || {};
    if (x.time !== undefined && !TIME_RX.test(String(x.time || ''))) return { err: PRESET_NAME[p] + ' : 시각을 확인해 주세요 (예 08:30).' };
    s.schedules[p] = cleanSch_(x, DEFAULTS.schedules[p]);
    if (s.schedules[p].on && s.schedules[p].mode === 'weekly' && !s.schedules[p].days.length) return { err: PRESET_NAME[p] + ' : 보낼 요일을 하나 이상 골라 주세요 (또는 「매일」).' };
  }
  s.to = clip(b.to, 4000); s.cc = clip(b.cc, 4000);
  const sc = b.scope || {};
  s.scope = { preset: ['all', 'ovs', 'inf'].indexOf(sc.preset) > -1 ? sc.preset : 'all', now: sc.now !== false, wk: sc.wk !== false, m1: !!sc.m1, region: ['해외', '국내'].indexOf(sc.region) > -1 ? sc.region : '', noJG: sc.noJG !== false, noGoods: sc.noGoods !== false };
  s.fromName = clip(b.fromName, 80).replace(/[<>"@\r\n]/g, '').trim();
  s.subject = clip(b.subject, 300); s.body = clip(b.body, 10000); s.signature = clip(b.signature, 600); s.footer = clip(b.footer, 500);
  s.link = /^https?:\/\/[^\s"<>]+$/.test(String(b.link || '').trim()) ? String(b.link).trim() : '';
  const bad = [];
  ['to', 'cc'].forEach(k => {
    parseAddrs(s[k]).filter(a => !a.valid).forEach(a => bad.push(a.address));
    const left = String(s[k] || '').replace(/(?:"[^"]*"|'[^']*'|[^<>;,\n"]*?)\s*<\s*[^<>\s]+\s*>|[^\s<>;,"']+@[^\s<>;,"']+/g, '').replace(/[\s;,]+/g, '');
    if (left) bad.push(String(s[k]).trim().slice(0, 60));
  });
  if (bad.length) return { err: '주소 모양이 이상합니다 : ' + bad.join(', ') };
  if (s.enabled && !parseAddrs(s.to).length) return { err: '자동 발송을 켜려면 받는 사람이 있어야 합니다.' };
  if (s.enabled && !PRESETS.some(p => s.schedules[p].on)) return { err: '자동 발송을 켜려면 「넣을 범위」 에서 예약할 묶음을 하나 이상 켜 주세요.' };
  if (!s.scope.now && !s.scope.wk && !s.scope.m1) return { err: '메일에 넣을 범위(즉시 조달 · 이번 주 발주 · 4주 안 발주)를 하나 이상 골라 주세요.' };
  if (s.body.indexOf('{TABLES}') < 0) return { err: '본문에 {TABLES}(자재 표 자리)가 있어야 합니다.' };
  return { s };
}
async function log_(rec) {
  const list = await propJson_(LOG_KEY, []) || [];
  list.unshift(Object.assign({ at: new Date().toISOString() }, rec));
  await propSet_(LOG_KEY, JSON.stringify(list.slice(0, 50)));
}

/* ── 대상 자재 (화면과 같은 엔진) ── */
let getModel = null;
/* 인플레이터 = 화면(품목군 ★ 인플레이터)과 같은 규칙 : 품명에 INFLATOR · 부속(너트 · 볼트 · 브래킷 …)은 뺀다 */
const isInf_ = n => /INFLATOR|인플레이터/i.test(n || '') && !/(^|[^A-Z])(NUT|BOLT|BRKT|BRACKET|WASHER|SCREW|HOLDER|CAP|COVER|PIN|CLIP|RING|TAPE|SHIM|SPACER|PLATE|STUD)([^A-Z]|$)/i.test(n || '');
/* [v0.53.18] OPW = 화면(품목군 ★ OPW)과 같은 규칙 : 품명에 OPW (낱말) · 부속은 빼고 · 인플레이터가 먼저 */
const isOpw_ = n => !isInf_(n) && /(^|[^A-Z])OPW([^A-Z]|$)/i.test(n || '') && !/(^|[^A-Z])(NUT|BOLT|BRKT|BRACKET|WASHER|SCREW|HOLDER|CAP|COVER|PIN|CLIP|RING|TAPE|SHIM|SPACER|PLATE|STUD)([^A-Z]|$)/i.test(n || '');
/* [v0.53.25] 와이어하네스 = 화면(품목군 ★ 와이어하네스)과 같은 규칙 */
const isWh_ = n => !isInf_(n) && !isOpw_(n) && /WIRE ?HARNESS|W\/H([^A-Z]|$)|(^|[^A-Z])HARNESS|와이어 ?하네스|하네스/i.test(n || '') && !/(^|[^A-Z])(NUT|BOLT|BRKT|BRACKET|WASHER|SCREW|HOLDER|CAP|COVER|PIN|CLIP|RING|TAPE|SHIM|SPACER|PLATE|STUD)([^A-Z]|$)/i.test(n || '');
/* [v0.53.32] 와이어하네스 품번 목록 (화면과 같음 · 품명에 HARNESS 가 없는 것 포함) */
const WH_CODES = { has: c => require('./material-rules').isWhCode(c) };   /* [v0.53.69] 화면과 같은 한 곳 (api/material-rules.js · 신진 · 진영전기) */
/* [v0.53.36] 주요 인플레이터 = 품번 규칙 (화면과 같음) — 품명에 INFLATOR 가 있어도 규칙 밖이면 메일 집중 관리에서 뺀다 */
const KEY_INF_LIST = ['KABL261007C', 'KABL261017C', 'KACL261000C', 'KACL261010C', 'KADL260007C', 'KADL261000C', 'KACL260007C', 'ADN261007J', 'ACN261007C', 'AEN261007C', 'KAAN260807C', 'KACS261007C', 'KADN261001C', 'KABN260817T', 'AAN261007U', 'ABN261007U', 'KAAL260007U'];
const keyInf_ = c => { const x = String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); return /^K?A[A-E][A-Z]26\d{4}[A-Z]$/.test(x) || KEY_INF_LIST.indexOf(x) > -1; };
const clsOf_ = (n, code) => keyInf_(code) ? 'INF' : isInf_(n) ? '' : isOpw_(n) ? 'OPW' : (WH_CODES.has(String(code || '').trim().toUpperCase()) || isWh_(n)) ? 'WH' : '';
/* [v0.53.18] inf 묶음 = 해외 인플레이터 + 해외 OPW (저장된 설정 'inf' 를 그대로 쓰므로 따로 바꿀 것 없음) */
const PRESET = { all: '', ovs: '해외 수입 자재', inf: '해외 인플레이터 · OPW · 와이어하네스' };
PRESET.inf = '해외 인플레이터 · OPW · FRT 버클 · 와이어하네스';   /* [v0.53.115] FRT 버클 더함 (위 줄의 예전 이름은 /check 확인 글자라 그대로 둠) */
/* [v0.53.115] ★ FRT 버클 = 화면과 같은 규칙 (api/material-rules.js bklOf : FRT BKL · FRT BUCKLE 완성품에만 쓰는 자재) */
const clsM_ = (m, prods) => clsOf_(m.name, m.code) || (require('./material-rules').bklOf(m.name, m.usedIn, k => (prods[k] || {}).name) === 'frt' ? 'BKL' : '');
/* [v0.53.26] 집중 관리 묶음의 이름표 : 이번 메일에 실제로 담긴 품목만 (0건인 품목은 이름 · 건수 모두 뺀다) */
const CLS_LIST = [['INF', '인플레이터'], ['OPW', 'OPW'], ['BKL', 'FRT 버클'], ['WH', '와이어하네스']];
function infLabel_(cnt) {
  const ovs = CLS_LIST.filter(([c]) => c !== 'WH' && cnt(c) > 0).map(x => x[1]), wh = cnt('WH') > 0;
  const parts = []; if (ovs.length) parts.push('해외 ' + ovs.join(' · ')); if (wh) parts.push('와이어하네스');
  return parts.length ? parts.join(' · ') : '집중 관리 자재';
}   /* [v0.53.25] 와이어하네스 추가 */
async function items_(st, todayYmd) {
  const c = await getModel();
  const MODEL = c.data;
  const eng = E.create(MODEL);
  const sc = st.scope || DEFAULTS.scope;
  const prods = {}; (MODEL.products || []).forEach(p => { prods[p.k] = p; });
  const out = { now: [], wk: [], m1: [], eol: [], ver: MODEL.ver, base: MODEL.baseDate, actEnd: MODEL.actEnd, planEnd: MODEL.planEnd, fresh: fresh_(MODEL, todayYmd) };
  /* [v0.53.72] 소진 후 단종 스위치 (화면과 같은 값 : 기본 진영전기 와이어하네스 15개 + app_props mm_eol) */
  let eolOver = {}; try { eolOver = ((await propJson_('mm_eol', {})) || {}).overrides || {}; } catch (e) {}
  const RR = require('./material-rules');
  MODEL.materials.forEach(src => {
    /* [v0.53.7] 보낼 묶음 : all = 지금 고른 범위 그대로 · ovs = 해외 수입 자재만 · inf = 해외 인플레이터만 */
    /* [v0.53.26] 집중 관리 묶음 : 인플레이터 · OPW 는 해외(수입)만 (예전 그대로) · 와이어하네스는 국내 포함 (와이어하네스는 국내 자재뿐이라 해외만 담으면 0건이었다) */
    if (sc.preset === 'ovs' && src.region !== '해외') return;
    if (sc.preset === 'inf') { const cl = clsM_(src, prods); if (!cl) return; if (cl !== 'WH' && src.region !== '해외') return; }
    if (sc.region && src.region !== sc.region) return;
    if (sc.noJG && src.jg) return;
    if (sc.noGoods && src.gubun === '상품') return;
    const m = eng.prep(Object.assign(JSON.parse(JSON.stringify(src)), { eol: RR.eolOf(src.k, eolOver) }));
    const r = eng.calc(m, todayYmd), a = eng.actOf(r, todayYmd);
    if (m.eol) { if (r.status !== '휴면' && r.known) out.eol.push({ cls: clsM_(m, prods), code: m.code, name: m.name, unit: m.unit, sup: m.sup, stock: r.stock, r: r.r, out: r.out, D: r.D, next: RR.whSupOf(m.code) === '진영전기' ? '신진 사용' : '' }); return; }   /* 발주 알림 대신 따로 */
    if (!a || a === 'dorm' || !sc[a]) return;
    const live = (m.usedIn || []).filter(k => { const p = prods[k]; return p && (p.plan || []).some(([d]) => d > todayYmd && E.diffDays(d, todayYmd) <= 60); });
    /* [v0.53.98] 발주 완료 = 입고 예정(앞날 · 지연)이 있음 → 표에서 「📦 발주 완료 · 입고 확인」 묶음 (건수 · 조치 구분은 그대로)
       모든 입고 뒤에도 이 표 기간(즉시 · 이번 주 7일 · 4주 28일) 안에 다시 발주해야 하면 「추가 발주」 로 위에 남긴다 */
    const fut = (r.pln || []).filter(([d]) => d >= todayYmd), lateP = (m.plnLate || []).filter(([d]) => d < todayYmd);
    const ordered = fut.length > 0 || lateP.length > 0, ib = ordered ? ibOf_(m, r, fut, todayYmd) : null;
    const more = !!(ordered && fut.length && ib.nextOrderBy && E.diffDays(ib.nextOrderBy, todayYmd) <= WIN_[a]);
    out[a].push({ cls: clsM_(m, prods), code: m.code, name: m.name, unit: m.unit, sup: m.sup, region: m.region, lead: m.lead, leadAssumed: m.leadAssumed,
      stock: r.stock, r: r.r, out: r.out, D: r.D, orderBy: r.orderBy, orderD: r.orderD, src: r.rSrc, pln: fut, late: lateP, ord: ordered && !more, more, ib, prods: live.length,
      ship: (m.ship || []).map(([due, plan, date, no, q]) => Object.assign({ due, q }, E.shipOf({ plan, date, no }, todayYmd))).filter(x => x.st),   /* [v0.53.111] 협력사 발송 (예정일 빠른 순) */ prodCodes: live.slice(0, 3).map(k => (prods[k] || {}).code || k) });
  });
  out.now.sort((x, y) => (y.prods - x.prods) || (x.stock - y.stock));
  out.wk.sort((x, y) => String(x.orderBy).localeCompare(String(y.orderBy)));
  out.m1.sort((x, y) => String(x.orderBy).localeCompare(String(y.orderBy)));
  out.eol.sort((x, y) => (x.out ? 0 : 1) - (y.out ? 0 : 1) || String(x.out || '').localeCompare(String(y.out || '')) || String(x.code).localeCompare(String(y.code)));
  return out;
}
const nf = n => (n === null || n === undefined || isNaN(n)) ? '-' : Math.round(n).toLocaleString('ko-KR');
const md = s => s ? s.slice(5).replace('-', '/') : '-';
const CLS_NAME = { INF: '★ 인플레이터', OPW: '★ OPW', BKL: '★ FRT 버클', WH: '★ 와이어하네스' };
/* ══ [v0.53.98] 메일 본문 (다시 만듦) — 메일 프로그램(아웃룩 · 지메일 · 휴대폰)에서 깨지지 않게 표 · 글자 모양을 칸마다 직접 적는다
   · 칸 7개 : 품번 · 품명 / 매입처 · 리드타임 / 재고 · 하루 사용 / 소진 예상 / 발주 / 입고 예정 / 영향 완성품
   · 건수는 대시보드 카드와 같다 (즉시 조달 · 이번 주 발주 · 4주 안 발주). 표 안에서 입고 예정이 잡힌 자재(= 이미 발주함)는
     아래 「📦 발주 완료 · 입고 확인」 묶음으로 모은다 — 「발주 시점 N일 지남」 이 아니라 입고 예정일 · 입고 전 재고 공백 · 추가 발주일을 보인다
   · 발주 완료인데 모든 입고 뒤에도 그 표 기간 안에 다시 발주해야 하면 위(발주할 것)에 두고 「추가 발주」 로 보인다 (자재관리 탭과 같은 셈) */
const FONT_ = "font-family:'Malgun Gothic','맑은 고딕','Apple SD Gothic Neo',Arial,sans-serif;";
const dShort_ = (d, t) => !d ? '-' : (String(t || '').slice(0, 4) === d.slice(0, 4) ? md(d) : d.slice(2).replace(/-/g, '.'));
const dD_ = n => n === null || n === undefined ? '' : n < 0 ? (-n) + '일 지남' : n === 0 ? '오늘' : 'D-' + n;
const tag_ = (t, bg, fg) => '<span style="display:inline-block;font-size:10.5px;font-weight:800;line-height:16px;padding:0 5px;border-radius:4px;background:' + bg + ';color:' + fg + ';margin:0 0 0 4px;white-space:nowrap">' + t + '</span>';
/* [v0.53.111] 협력사 발송 한 줄 : 🚚 발송(실제 출발) · ⚠ 출발 예정 지남(발송 확인 없음) · 출발 예정 — 예정일이 가장 빠른 입고 예정 기준 */
function shipLine_(x, t, html) {
  const L = x.ship || []; if (!L.length) return '';
  const s0 = L.find(a => a.st === 'late') || L[0], more = L.length > 1 ? ' 외 ' + (L.length - 1) + '건' : '', dd = html ? d => dShort_(d, t) : md;
  const txt = s0.st === 'sent' ? '🚚 ' + dd(s0.d) + ' 발송' + (s0.no ? ' · ' + s0.no : '') + ' → 입고 ' + dd(s0.due) : s0.st === 'late' ? '⚠ 출발 예정 ' + dd(s0.d) + ' 지남 · 발송 확인 없음 (입고 ' + dd(s0.due) + ')' : '출발 예정 ' + dd(s0.d) + ' (입고 ' + dd(s0.due) + ')';
  return html ? sub_(esc(txt + more), s0.st === 'sent' ? '#0F766E' : s0.st === 'late' ? '#B42318' : '#475569') : txt + more;
}
const sub_ = (s, col) => '<div style="font-size:11px;line-height:1.45;color:' + (col || '#64748B') + ';margin-top:2px">' + s + '</div>';
const WIN_ = { now: 7, wk: 7, m1: 28 };
/* 자료가 언제까지 올라왔는지 · 오래된 자료 경고 (메일 · 이메일 설정 화면 같은 값) */
function fresh_(M, t) {
  const lag = d => d ? E.diffDays(t, d) : null;
  const f = { base: M.baseDate || '', act: M.actEnd || '', rcv: M.rcvEnd || '', mes: M.mesEnd || '', sl: M.slEnd || '', built: (M.diag && M.diag.builtAt) || '', calcDay: M.today || '', warn: [] };
  if (f.act && lag(f.act) > 3) f.warn.push('생산실적이 ' + dShort_(f.act, t) + ' 까지만 올라와 있습니다 (' + lag(f.act) + '일 전) — 사용량 · 재고가 실제와 다를 수 있습니다');
  if (f.rcv && lag(f.rcv) > 3) f.warn.push('MES 입고 자료가 ' + dShort_(f.rcv, t) + ' 까지만 올라와 있습니다 (' + lag(f.rcv) + '일 전) — 그 뒤 입고는 재고에 아직 없습니다');
  if (f.mes && E.diffDays(f.mes, t) < 7) f.warn.push('MES 생산계획이 ' + dShort_(f.mes, t) + ' 까지만 있습니다 — 그 뒤 사용량은 롤링 S/L 로만 셉니다');
  if (f.calcDay && f.calcDay !== t) f.warn.push('계산 기준일(' + f.calcDay + ')이 오늘(' + t + ')과 다릅니다');
  return f;
}
function freshText_(f, t) {
  return ['수불부 ' + dShort_(f.base, t) + ' 기말', f.act ? '생산실적 ~' + dShort_(f.act, t) : '', f.rcv ? 'MES 입고 ~' + dShort_(f.rcv, t) : '', f.mes ? 'MES 계획 ~' + dShort_(f.mes, t) : '', f.sl ? 'VF S/L ~' + dShort_(f.sl, t) : ''].filter(Boolean).join(' · ');
}
/* 입고 예정이 있는 자재 : 입고 전 재고 공백 · 모든 입고 뒤 다음 소진 · 추가 발주일 (화면 runIb 와 같은 셈 · 엔진 proj0 + 남은 예정) */
function ibOf_(m, r, fut, t) {
  const o = { gap: null, after: null, nextOrderBy: null };
  if (!r || !r.known) return o;
  const HZ = E.C.HORIZON, adds = fut.map(([d, q]) => [E.diffDays(d, t), +q]);
  const sAt = i => { let s = r.proj0(i); for (const [x, q] of adds) if (x <= i) s += q; return s; };
  if (r.out && fut.length) {
    const pb = fut.find(([d]) => d > r.out);
    if (pb) { const i0 = E.diffDays(r.out, t), i1 = Math.min(E.diffDays(pb[0], t), HZ + 1); let mn = 0; for (let i = Math.max(0, i0); i < i1; i++) mn = Math.min(mn, sAt(i)); o.gap = { from: r.out, to: pb[0], days: E.diffDays(pb[0], r.out), short: -mn, q: pb[1] }; }
  }
  if (fut.length) { const iL = Math.max(0, E.diffDays(fut[fut.length - 1][0], t)); for (let i = iL; i <= HZ; i++) if (sAt(i) <= 0) { o.after = E.addDays(t, i); break; } }
  else o.after = r.out;
  o.nextOrderBy = o.after && !m.eol ? E.addDays(o.after, -m.lead) : null;
  return o;
}
function cellsOf_(x, kind, t) {
  const st = x.stock;
  const c1 = '<b style="font-size:12.5px;color:#0F172A">' + esc(x.code) + '</b>' + (x.cls ? tag_(x.cls === 'INF' ? '★ INF' : x.cls === 'OPW' ? '★ OPW' : x.cls === 'BKL' ? '★ BKL' : '★ W/H', '#FFEDD5', '#C2410C') : '') + (x.region === '해외' ? tag_('해외', '#DBEAFE', '#1D4ED8') : '') + sub_(esc(x.name || '') + '<span class="akm-m" style="display:none;mso-hide:all"> · ' + esc(x.sup || '') + '</span>');
  const c2 = esc(x.sup || '-') + sub_('LT ' + nf(x.lead) + '일' + (x.leadAssumed ? ' (가정)' : ''));
  const c3 = '<b style="font-size:13px;color:' + (st !== null && st <= 0 ? '#B42318' : '#0F172A') + '">' + nf(st) + '</b> <span style="font-size:10.5px;color:#94A3B8">' + esc(x.unit || '') + '</span>' + sub_('하루 ' + nf(x.r));
  const c4 = kind === 'now' || (x.D !== null && x.D !== undefined && x.D <= 0) ? '<b style="color:#B42318">이미 소진</b>' : x.out ? '<b>' + dShort_(x.out, t) + '</b>' + sub_(dD_(x.D)) : '<span style="color:#94A3B8">-</span>';
  const ORD = '<span style="display:inline-block;font-size:11px;font-weight:800;line-height:18px;padding:0 7px;border-radius:9px;background:#CCFBF1;color:#0F766E;white-space:nowrap">📦 발주 완료</span>';
  let c5;
  if (x.ord) c5 = ORD + sub_(x.pln.length ? '입고 예정일 확인' : '입고 지연 확인', x.pln.length ? '#0F766E' : '#B42318');
  else if (x.more) { const d = E.diffDays(x.ib.nextOrderBy, t); c5 = ORD + '<div style="font-size:11.5px;font-weight:800;color:' + (d < 0 ? '#B42318' : '#B54708') + ';margin-top:3px">추가 발주 ' + dShort_(x.ib.nextOrderBy, t) + '</div>' + sub_(dD_(d)); }
  else if (kind === 'now') c5 = '<b style="color:#B42318">즉시 조달</b>';
  else if (x.orderD < 0) c5 = '<b style="color:#B42318">' + (-x.orderD) + '일 지남</b>' + sub_('권장 ' + dShort_(x.orderBy, t));
  else c5 = '<b style="color:' + (x.orderD === 0 ? '#B54708' : '#0F172A') + '">' + (x.orderD === 0 ? '오늘' : dShort_(x.orderBy, t)) + '</b>' + (x.orderD ? sub_(dD_(x.orderD)) : '');
  let c6 = '';
  if (x.pln && x.pln.length) c6 = '<b>' + dShort_(x.pln[0][0], t) + '</b> <span style="color:#0F766E;font-weight:700">' + nf(x.pln[0][1]) + '</span>' + (x.pln.length > 1 ? sub_('외 ' + (x.pln.length - 1) + '건 · 합 ' + nf(x.pln.reduce((a, p) => a + p[1], 0))) : '');
  if (x.ib && x.ib.gap) c6 += sub_('⚠ 입고 전 공백 ' + x.ib.gap.days + '일' + (x.ib.gap.short > 0 ? ' · 부족 ' + nf(x.ib.gap.short) : ''), '#B42318');
  if (x.late && x.late.length) c6 += sub_('⚠ ' + dShort_(x.late[0][0], t) + ' 예정 ' + nf(x.late[0][1]) + ' 안 들어옴' + (x.late.length > 1 ? ' 외 ' + (x.late.length - 1) + '건' : ''), '#B42318');
  if (x.ship && x.ship.length) c6 += shipLine_(x, t, true);   /* [v0.53.111] 협력사 발송 */
  if (!c6) c6 = '<span style="color:#94A3B8">-</span>';
  const c7 = x.prods ? '<b>' + x.prods + '종</b>' + sub_(x.prodCodes.slice(0, 2).map(esc).join('<br>') + (x.prods > 2 ? '<br>외 ' + (x.prods - 2) + '종' : '')) : '<span style="color:#94A3B8">-</span>';
  return [c1, c2, c3, c4, c5, c6, c7];
}
const TW_ = [24, 13, 11, 10, 12, 16, 14];
const TAL_ = ['left', 'left', 'right', 'center', 'center', 'center', 'left'];
const HIDE_ = i => i === 1 || i === 6 ? ' class="akm-h"' : '';   /* 휴대폰(좁은 화면)에서 숨기는 칸 : 매입처 · 영향 완성품 */
function rowHtml_(x, kind, t) {
  return '<tr>' + cellsOf_(x, kind, t).map((c, i) => '<td' + HIDE_(i) + ' style="padding:8px 7px;border-bottom:1px solid #E8EDF3;font-size:12px;line-height:1.45;vertical-align:top;text-align:' + TAL_[i] + ';' + (i < 2 || i === 6 ? 'word-break:break-all;overflow-wrap:anywhere;' : 'word-break:keep-all;') + '">' + c + '</td>').join('') + '</tr>';
}
function tableHtml_(title, list, kind, color, group) {
  if (!list.length) return '';
  const t = list.t || '';
  const need = list.filter(x => !x.ord), ord = list.filter(x => x.ord).slice().sort((a, b) => String(((a.pln[0] || a.late[0]) || [''])[0]).localeCompare(String(((b.pln[0] || b.late[0]) || [''])[0])));
  /* [v0.53.8] 해외 묶음은 매입처별 · [v0.53.18] 집중 관리는 품목(★ 인플레이터 → ★ OPW → ★ 와이어하네스) 다음 매입처 */
  const rowsOf = L => {
    if (!group) return L.map(x => rowHtml_(x, kind, t)).join('');
    const byCls = group === 'cls', key = x => (byCls ? (x.cls || 'ZZ') + '|' : '|') + (x.sup || '(매입처 없음)');
    const G = {}; L.forEach(x => { (G[key(x)] = G[key(x)] || []).push(x); });
    const ord = c => ({ INF: 0, OPW: 1, BKL: 2, WH: 3 })[c] ?? 4;   /* [v0.53.115] FRT 버클 */
    let lastCls = null;
    return Object.keys(G).sort((a, b) => (ord(a.split('|')[0]) - ord(b.split('|')[0])) || G[b].length - G[a].length || a.localeCompare(b)).map(k => {
      const [cls, sup] = k.split('|'), g = G[k], lt = Math.max(...g.map(x => x.lead || 0));
      let head = '';
      if (byCls && cls !== lastCls) { lastCls = cls; const n = L.filter(x => (x.cls || 'ZZ') === cls).length; head = '<tr><td colspan="7" style="padding:8px 9px;background:#FFF7ED;border-bottom:1px solid #FED7AA;font-size:13px;font-weight:900;color:#9A3412">' + esc(CLS_NAME[cls] || '그 밖') + ' <span style="font-weight:700;color:#64748B">' + n + '건</span></td></tr>'; }
      return head + '<tr><td colspan="7" style="padding:6px 9px;background:#F8FAFC;border-bottom:1px solid #E2E8F0;font-size:12px;font-weight:800;color:#334155">▸ ' + esc(sup) + ' <span style="font-weight:600;color:#64748B">· ' + g.length + '건 · 최장 리드타임 ' + lt + '일</span></td></tr>' + g.map(x => rowHtml_(x, kind, t)).join('');
    }).join('');
  };
  const band = ord.length ? '<tr><td colspan="7" style="padding:9px 9px;background:#F0FDFA;border-top:2px solid #5EEAD4;border-bottom:1px solid #99F6E4;font-size:12.5px;font-weight:900;color:#0F766E">📦 발주 완료 · 입고 확인 ' + ord.length + '건 <span style="font-weight:600;color:#475569">— 이미 발주해 입고 예정이 있는 자재입니다. 예정일에 들어오는지만 확인해 주세요</span></td></tr>' : '';
  const H = ['품번 · 품명', '매입처', '재고 · 하루 사용', '소진 예상', '발주', '입고 예정', '영향 완성품 (60일)'];
  const sum = [need.length && ord.length ? (kind === 'now' ? '조달 필요 ' : '발주할 것 ') + need.length + '건' : '', ord.length ? '📦 발주 완료 ' + ord.length + '건' : ''].filter(Boolean).join(' · ');
  return '<table role="presentation" cellspacing="0" cellpadding="0" width="100%" style="margin:22px 0 8px;border-collapse:collapse"><tr><td style="border-left:4px solid ' + color + ';padding:1px 0 1px 10px;' + FONT_ + '"><b style="font-size:15px;color:' + color + '">' + esc(title) + '</b> <b style="font-size:15px;color:#0F172A">' + list.length + '건</b>' + (sum ? ' <span style="font-size:12px;color:#64748B">· ' + sum + '</span>' : '') + '</td></tr></table>' +
    '<table class="akm-t" cellspacing="0" cellpadding="0" width="100%" style="border-collapse:collapse;width:100%;table-layout:fixed;border:1px solid #E2E8F0;' + FONT_ + '">' +
    '<tr>' + H.map((h, i) => '<th' + HIDE_(i) + ' style="width:' + TW_[i] + '%;padding:8px 7px;background:#F1F5F9;border-bottom:2px solid ' + color + ';text-align:' + TAL_[i] + ';font-size:11.5px;font-weight:800;color:#334155;word-break:keep-all">' + h + '</th>').join('') + '</tr>' +
    rowsOf(need) + band + rowsOf(ord) + '</table>';
}
/* [v0.53.72] 소진 후 단종 (재주문 안 함) 표 : 소진 예상일만 · 발주 안내 없음 (진영전기 와이어하네스는 다 쓰면 신진으로 · 더 사지 않음) */
function eolTableHtml_(list) {
  if (!list.length) return '';
  const color = '#6D28D9', t = list.t || '', W = [26, 16, 14, 14, 30], AL = ['left', 'left', 'right', 'center', 'left'];
  const td = (s, i) => '<td style="padding:8px 7px;border-bottom:1px solid #E8EDF3;font-size:12px;line-height:1.45;vertical-align:top;text-align:' + AL[i] + ';' + (i < 2 ? 'word-break:break-all;overflow-wrap:anywhere;' : '') + '">' + s + '</td>';
  const rows = list.map(x => '<tr>' + [
    '<b style="font-size:12.5px">' + esc(x.code) + '</b>' + sub_(esc(x.name || '')),
    esc(x.sup || '-'),
    '<b style="color:' + (x.stock <= 0 ? '#B42318' : '#0F172A') + '">' + nf(x.stock) + '</b> <span style="font-size:10.5px;color:#94A3B8">' + esc(x.unit || '') + '</span>' + sub_('하루 ' + nf(x.r)),
    x.out ? (x.D <= 0 ? '<b style="color:#B42318">이미 소진</b>' : '<b>' + dShort_(x.out, t) + '</b>' + sub_('D-' + x.D)) : '<span style="color:#64748B">소진 예정 없음</span>',
    '<b style="color:' + color + '">재주문 안 함</b>' + (x.next ? sub_('다 쓰면 ' + esc(x.next)) : '')
  ].map(td).join('') + '</tr>').join('');
  return '<table role="presentation" cellspacing="0" cellpadding="0" width="100%" style="margin:22px 0 8px;border-collapse:collapse"><tr><td style="border-left:4px solid ' + color + ';padding:1px 0 1px 10px;' + FONT_ + '"><b style="font-size:15px;color:' + color + '">⛔ 소진 후 단종 · 재주문 안 함</b> <b style="font-size:15px;color:#0F172A">' + list.length + '건</b> <span style="font-size:12px;color:#64748B">· 남은 재고만 씁니다 (발주 · 조달 요청 없음)</span></td></tr></table>' +
    '<table cellspacing="0" cellpadding="0" width="100%" style="border-collapse:collapse;width:100%;table-layout:fixed;border:1px solid #E2E8F0;' + FONT_ + '"><tr>' +
    ['품번 · 품명', '매입처', '재고 · 하루 사용', '소진 예상', '비고'].map((h, i) => '<th style="width:' + W[i] + '%;padding:8px 7px;background:#F1F5F9;border-bottom:2px solid ' + color + ';text-align:' + AL[i] + ';font-size:11.5px;font-weight:800;color:#334155">' + h + '</th>').join('') + '</tr>' + rows + '</table>';
}
function eolTableText_(list) {
  if (!list.length) return '';
  return '■ 소진 후 단종 · 재주문 안 함 (' + list.length + '건) — 남은 재고만 사용 · 발주하지 않음\n' + list.map(x => '- ' + x.code + ' ' + x.name + ' / ' + x.sup + ' / 재고 ' + nf(x.stock) + ' / ' + (x.out ? (x.D <= 0 ? '이미 소진' : '소진 예상 ' + md(x.out) + ' (D-' + x.D + ')') : '소진 예정 없음') + ' / 재주문 안 함' + (x.next ? ' · 이후 ' + x.next : '')).join('\n');
}
function tableText_(title, list, kind) {
  if (!list.length) return '';
  const line = x => '- ' + (x.cls ? '[' + x.cls + '] ' : '') + x.code + ' ' + x.name + ' / ' + x.sup + ' / 재고 ' + nf(x.stock) + ' / ' +
    (x.ord ? '발주 완료' + (x.pln.length ? ' · 입고 ' + md(x.pln[0][0]) + ' ' + nf(x.pln[0][1]) + (x.pln.length > 1 ? ' 외 ' + (x.pln.length - 1) + '건' : '') : '') + (x.late.length ? ' · ' + md(x.late[0][0]) + ' 예정 안 들어옴' : '') + (x.ib && x.ib.gap ? ' · 입고 전 공백 ' + x.ib.gap.days + '일' : '') + (x.ship && x.ship.length ? ' · ' + shipLine_(x, '', false) : '')
      : x.more ? '발주 완료 · 추가 발주 ' + md(x.ib.nextOrderBy) + (x.pln.length ? ' / 입고 예정 ' + md(x.pln[0][0]) + ' ' + nf(x.pln[0][1]) : '') + (x.ship && x.ship.length ? ' · ' + shipLine_(x, '', false) : '')
      : (kind === 'now' ? '즉시 조달' : '소진 ' + md(x.out) + ' · 발주 ' + (x.orderD < 0 ? (-x.orderD) + '일 지남' : md(x.orderBy))) + (x.pln && x.pln.length ? ' / 입고 예정 ' + md(x.pln[0][0]) + ' ' + nf(x.pln[0][1]) : '')) +
    (x.prods ? ' / 영향 ' + x.prods + '종' : '');
  const need = list.filter(x => !x.ord), ord = list.filter(x => x.ord);
  return '■ ' + title + ' (' + list.length + '건' + (ord.length ? ' · 발주 완료 ' + ord.length + '건' : '') + ')\n' + need.map(line).join('\n') + (ord.length ? (need.length ? '\n' : '') + '  [발주 완료 · 입고 확인]\n' + ord.map(line).join('\n') : '');
}
/* [v0.53.98] 예전 기본 본문을 그대로 쓰고 있으면 새 기본 본문으로 (고쳐 쓴 본문은 그대로) */
const BODY_OLD_ = ['안녕하세요.\n\n{DATE} 기준 자재관리 시스템이 계산한 조달 · 발주 알림을 공유드립니다.\n(기준점 : 재무회계팀 8월 말 수불부 기말 재고 · 사용량 : 생산실적 + MES 생산계획 × BOM)\n\n{SUMMARY}\n\n즉시 조달 자재는 이미 재고가 바닥난 것으로 계산된 자재입니다. 실물 재고와 입고 일정을 확인해 주시고, 생산에 영향이 없도록 조치 부탁드립니다.\n이번 주 발주 자재는 리드타임을 고려하면 이번 주 안에 발주해야 소진 전에 들어오는 자재입니다.\n\n{TABLES}\n\n자세한 내용은 AKC SYSTEM › 업무 › 자재관리 에서 확인하실 수 있습니다. {LINK}\n\n감사합니다.\n\n{SIGNATURE}'];
const bodyKey_ = s => String(s || '').replace(/\r/g, '').replace(/\d{1,2}월 말 수불부/g, 'X월 말 수불부').replace(/[ \t]+/g, ' ').trim();
const isOldBody_ = s => BODY_OLD_.some(b => bodyKey_(b) === bodyKey_(s));
function compose_(st, it, todayYmd) {
  const sc = st.scope || DEFAULTS.scope;
  const t = todayYmd;
  ['now', 'wk', 'm1', 'eol'].forEach(k => { if (it[k]) it[k].t = t; });
  const n = { now: it.now.length, wk: it.wk.length, m1: it.m1.length, eol: (it.eol || []).length };
  const oc = L => L.filter(x => x.ord).length;
  n.ord = { now: oc(it.now), wk: oc(it.wk), m1: oc(it.m1) };   /* [v0.53.98] 그중 발주 완료 (입고 확인만) */
  const late = it.wk.filter(x => !x.ord && (x.more ? E.diffDays(x.ib.nextOrderBy, t) < 0 : x.orderD < 0)).length, hit = it.now.filter(x => x.prods).length;
  const cntCls = c => [].concat(sc.now ? it.now : [], sc.wk ? it.wk : [], sc.m1 ? it.m1 : []).filter(x => x.cls === c).length;   /* [v0.53.18] */
  const date = t + ' (' + WD[wdOf_(t)] + ')';
  const PL = sc.preset === 'inf' ? infLabel_(cntCls) : (PRESET[sc.preset] || '');   /* [v0.53.26] 담긴 품목만 */
  const clsTxt = CLS_LIST.filter(([c]) => cntCls(c) > 0).map(([c, nm]) => nm + ' ' + cntCls(c) + '건').join(' · ');
  const scopeTxt = [PL, PL ? '' : (sc.region || '해외 + 국내'), sc.noJG ? 'JG 제외' : '', sc.noGoods ? '상품 제외' : ''].filter(Boolean).join(' · ');
  const F = it.fresh || fresh_({}, t);
  const ordTxt = (L, o) => o ? ' (📦 발주 완료 ' + o + '건)' : '';
  const sumTxt = ({ ovs: '[해외 수입 자재만 · 매입처별]\n', inf: '[' + PL + ' · 특별 관리 · 품목 · 매입처별]\n' }[sc.preset] || '') + (sc.preset === 'inf' && clsTxt ? '· ' + clsTxt + '\n' : '') +
    '· 즉시 조달 ' + n.now + '건 (생산 영향 ' + hit + '건)' + ordTxt(it.now, n.ord.now) + '\n· 이번 주 발주 ' + n.wk + '건 (발주 시점 지남 ' + late + '건)' + ordTxt(it.wk, n.ord.wk) + (sc.m1 ? '\n· 4주 안 발주 ' + n.m1 + '건' + ordTxt(it.m1, n.ord.m1) : '') + (n.eol ? '\n· 소진 후 단종 ' + n.eol + '건 (재주문 안 함)' : '') +
    '\n· 범위 : ' + scopeTxt + '\n· 자료 기준 : ' + freshText_(F, t) + (F.warn.length ? '\n' + F.warn.map(w => '⚠ ' + w).join('\n') : '') +
    '\n· 발주 완료 = 입고 예정이 잡혀 있어 입고일에 들어오는지만 확인하면 되는 자재';
  /* 숫자 카드 (메일 프로그램이 같은 폭으로 그리게 표 한 줄) */
  const card = (lab, v, subs, col, bg, small) => '<div style="padding:12px 14px;background:' + bg + ';border:1px solid ' + col + '33;border-left:4px solid ' + col + ';border-radius:10px;' + FONT_ + '"><div style="font-size:12px;font-weight:800;color:#475569">' + lab + '</div><div style="font-size:' + (small ? 15 : 26) + 'px;line-height:1.25;font-weight:900;color:' + col + ';margin:3px 0 2px">' + v + '</div><div style="font-size:11.5px;line-height:1.45;color:#64748B">' + subs + '</div></div>';
  /* [v0.53.8] 보낼 묶음마다 메일 모양 · 안내 · 표가 달라진다 */
  const TH = {
    all: { title: '조달 · 발주 알림', c1: '#16465d', c2: '#1a6570', tag: '', note: '' },
    ovs: { title: '해외 수입 자재 · 조달 · 발주 알림', c1: '#1E3A8A', c2: '#2563EB', tag: '해외 수입 ',
           note: '<b>해외 매입처 자재만</b> 모았습니다. 운송 리드타임이 길어(보통 45~90일) 발주 시점이 지나면 항공 운송 등 긴급 조치가 필요할 수 있습니다. 표는 <b>매입처별</b>입니다.' },
    inf: { title: '★ ' + PL + ' · 조달 · 발주 알림', c1: '#9A3412', c2: '#EA580C', tag: PL + ' ',
           note: '<b>' + PL + '</b> (특별 관리 주요 부품)만 모았습니다.' + (cntCls('WH') ? ' 인플레이터 · OPW 는 <b>해외(수입)</b>, 와이어하네스는 <b>국내 포함</b>입니다.' : '') + ' 표는 <b>품목(' + CLS_LIST.filter(([c]) => cntCls(c) > 0).map(([, nm]) => '★ ' + nm).join(' → ') + ') · 매입처별</b>입니다.' }
  }[sc.preset] || null;
  const T = TH || { title: '조달 · 발주 알림', c1: '#16465d', c2: '#1a6570', tag: '', note: '' };
  const listed = [].concat(sc.now ? it.now : [], sc.wk ? it.wk : [], sc.m1 ? it.m1 : []);
  const leads = listed.map(x => x.lead || 0), sups = new Set(listed.map(x => x.sup)).size;
  const cards = [
    sc.now ? card('즉시 조달', n.now + '<span style="font-size:13px;font-weight:700;color:#64748B"> 건</span>', '생산 영향 ' + hit + '건' + (n.ord.now ? '<br>📦 발주 완료 ' + n.ord.now + '건' : ''), '#D92D20', '#FEF3F2') : '',
    sc.wk ? card('이번 주 발주', n.wk + '<span style="font-size:13px;font-weight:700;color:#64748B"> 건</span>', '발주 시점 지남 ' + late + '건' + (n.ord.wk ? '<br>📦 발주 완료 ' + n.ord.wk + '건' : ''), '#DC6803', '#FFFAEB') : '',
    sc.m1 ? card('4주 안 발주', n.m1 + '<span style="font-size:13px;font-weight:700;color:#64748B"> 건</span>', '미리 준비' + (n.ord.m1 ? '<br>📦 발주 완료 ' + n.ord.m1 + '건' : ''), '#B54708', '#FFFCF5') : '',
    n.eol ? card('소진 후 단종', n.eol + '<span style="font-size:13px;font-weight:700;color:#64748B"> 건</span>', '재주문 안 함 · 소진 예상일만', '#6D28D9', '#F5F3FF') : '',   /* [v0.53.72] */
    sc.preset === 'inf' && clsTxt ? card('품목', CLS_LIST.filter(([c]) => cntCls(c) > 0).map(([c, nm]) => nm + ' ' + cntCls(c)).join('<br>'), '담긴 건수 (없는 품목은 뺌)', T.c2, '#FFF7ED', true) : '',
    sc.preset === 'ovs' || sc.preset === 'inf' ? card('매입처 · 리드타임', sups + '<span style="font-size:13px;font-weight:700;color:#64748B"> 곳</span>', listed.length ? '최장 ' + Math.max(...leads) + '일 · 평균 ' + Math.round(leads.reduce((a, b) => a + b, 0) / leads.length) + '일' : '해당 없음', T.c2, '#F8FAFC') : ''
  ].filter(Boolean);
  const sumHtml = (T.note ? '<div style="margin:0 0 10px;padding:9px 12px;border-radius:8px;background:#F8FAFC;border-left:4px solid ' + T.c2 + ';font-size:12.5px;line-height:1.6;color:#334155">' + T.note + '</div>' : '') +
    /* 아웃룩(PC)은 표 칸으로 · 그 밖은 줄바꿈되는 상자로 (휴대폰에서 2~3개씩) */
    '<div style="font-size:0;line-height:0;margin:0 -4px">' + '<!--[if mso]><table role="presentation" cellspacing="0" cellpadding="0" width="100%"><tr><![endif]-->' +
      cards.map(c => '<!--[if mso]><td valign="top" style="padding:4px"><![endif]--><div class="akm-c" style="display:inline-block;vertical-align:top;width:' + Math.floor(100 / cards.length) + '%;min-width:150px;max-width:100%;box-sizing:border-box;padding:4px;font-size:13px;line-height:1.5">' + c + '</div><!--[if mso]></td><![endif]-->').join('') +
      '<!--[if mso]></tr></table><![endif]-->' + '</div>' +
    '<table role="presentation" cellspacing="0" cellpadding="0" width="100%" style="margin-top:6px;border-collapse:collapse"><tr><td style="padding:8px 12px;background:#F8FAFC;border:1px solid #E2E8F0;border-radius:8px;font-size:11.5px;line-height:1.7;color:#475569;' + FONT_ + '">' +
      '<b style="color:#0F172A">자료 기준</b> ' + esc(freshText_(F, t)) + '<br><b style="color:#0F172A">범위</b> ' + esc(scopeTxt) +
      (F.warn.length ? '<div style="margin-top:6px;padding:6px 9px;border-radius:6px;background:#FFFAEB;border:1px solid #FEC84B;color:#93370D;font-weight:700">' + F.warn.map(w => '⚠ ' + esc(w)).join('<br>') + '</div>' : '') +
      '<div style="margin-top:4px;color:#64748B">즉시 조달 = 지금 재고 0 이하 · 이번 주 발주 = 발주 권장일(소진 예상 − 리드타임)이 7일 안 (지난 것 포함) · <b style="color:#0F766E">📦 발주 완료</b> = 입고 예정이 잡혀 있어 입고일에 들어오는지만 확인</div>' +
    '</td></tr></table>';
  const grp = sc.preset === 'inf' ? 'cls' : sc.preset === 'ovs';   /* [v0.53.18] 인플레이터 · OPW 는 품목별 → 매입처별 */
  const tablesHtml = (sc.now ? tableHtml_(T.tag + '즉시 조달 · 재고 소진', it.now, 'now', '#D92D20', grp) : '') + (sc.wk ? tableHtml_(T.tag + '이번 주 발주', it.wk, 'wk', '#DC6803', grp) : '') + (sc.m1 ? tableHtml_(T.tag + '4주 안 발주', it.m1, 'm1', '#B54708', grp) : '') + eolTableHtml_(it.eol || []) +
    (!listed.length && !n.eol ? '<div style="margin:18px 0;padding:16px;border:1px dashed #CBD5E1;border-radius:10px;text-align:center;color:#64748B;font-size:13px">지금 범위에는 조달 · 발주할 자재가 없습니다.</div>' : '') + '<div style="height:16px;line-height:16px;font-size:0">&nbsp;</div>';
  const tablesTxt = [sc.now ? tableText_('즉시 조달', it.now, 'now') : '', sc.wk ? tableText_('이번 주 발주', it.wk, 'wk') : '', sc.m1 ? tableText_('4주 안 발주', it.m1, 'm1') : '', eolTableText_(it.eol || [])].filter(Boolean).join('\n\n');
  const fillTxt = tpl => String(tpl || '').replace(/\{DATE\}/g, date).replace(/\{NOW\}/g, n.now).replace(/\{WK\}/g, n.wk).replace(/\{M1\}/g, n.m1)
    .replace(/\{LINK\}/g, st.link || '').replace(/\{SIGNATURE\}/g, st.signature || '').replace(/\{SCOPE\}/g, PL || '전체');
  /* 글 부분 : 빈 줄로 나눈 문단마다 <p> (블록 앞뒤 빈 줄이 큰 틈이 되지 않게) */
  const fillHtml = tpl => esc(tpl).replace(/\r/g, '').replace(/\{DATE\}/g, esc(date)).replace(/\{NOW\}/g, n.now).replace(/\{WK\}/g, n.wk).replace(/\{M1\}/g, n.m1)
    .replace(/\{LINK\}/g, st.link ? '<a href="' + esc(st.link) + '" style="color:#0F766E;font-weight:700">바로 가기 →</a>' : '')
    .replace(/\{SIGNATURE\}/g, esc(st.signature || '')).replace(/\{SCOPE\}/g, esc(PL || '전체'))
    .split(/\n\s*\n/).map(p => p.replace(/^\n+|\n+$/g, '')).filter(p => p.trim()).map(p => '<p style="margin:0 0 12px">' + p.replace(/\n/g, '<br>') + '</p>').join('');
  const subject = ((PL && st.subject.indexOf('{SCOPE}') < 0 ? '[' + PL + '] ' : '') + fillTxt(st.subject)).replace(/\s+/g, ' ').trim();
  /* [v0.53.20] 본문의 '8월 말 수불부' 같은 기준 달 글자는 지금 기준 달로 */
  const bmTxt = +String(it.base || '2026-08-31').slice(5, 7) + '월 말 수불부';
  st = Object.assign({}, st, { body: String(st.body || '').replace(/\d{1,2}월 말 수불부/g, bmTxt) });
  const parts = String(st.body || '').split(/(\{SUMMARY\}|\{TABLES\})/);
  const css = '<style>@media only screen and (max-width:620px){.akm-h{display:none!important}.akm-m{display:inline!important}.akm-c{width:50%!important;min-width:0!important}.akm-t{table-layout:auto!important}.akm-t td,.akm-t th{padding:7px 5px!important;width:auto!important}}</style>';
  const html = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' + css + '</head><body style="margin:0;padding:0">' +
    '<div style="' + FONT_ + 'color:#0F172A;font-size:13.5px;line-height:1.65;max-width:980px">' +
    '<table role="presentation" cellspacing="0" cellpadding="0" width="100%" style="border-collapse:collapse"><tr><td style="background:' + T.c1 + ';background:linear-gradient(90deg,' + T.c1 + ',' + T.c2 + ');color:#ffffff;padding:14px 18px;border-radius:10px 10px 0 0;' + FONT_ + '">' +
      '<table role="presentation" cellspacing="0" cellpadding="0" width="100%" style="border-collapse:collapse"><tr><td style="color:#ffffff;' + FONT_ + '"><div style="font-size:11.5px;font-weight:700;color:#CCFBF1">AKC 자재관리</div><div style="font-size:17px;font-weight:900;line-height:1.35">' + esc(T.title) + '</div></td>' +
      '<td align="right" valign="bottom" style="color:#ffffff;white-space:nowrap;font-size:12.5px;font-weight:800;padding-left:12px;' + FONT_ + '">' + esc(date) + '<div style="font-size:11px;font-weight:600;color:#E2E8F0">한국 시각 기준</div></td></tr></table></td></tr></table>' +
    '<div style="border:1px solid #E2E8F0;border-top:0;padding:18px 18px 16px;border-radius:0 0 10px 10px">' +
    parts.map(p => p === '{SUMMARY}' ? sumHtml : p === '{TABLES}' ? tablesHtml : fillHtml(p)).join('') +
    (st.footer ? '<div style="margin-top:18px;padding-top:10px;border-top:1px solid #E2E8F0;font-size:11.5px;color:#94A3B8">' + esc(st.footer) + '</div>' : '') + '</div></div></body></html>';
  const text = fillTxt(String(st.body || '').replace('{SUMMARY}', sumTxt).replace('{TABLES}', tablesTxt)) + (st.footer ? '\n\n' + st.footer : '');
  return { subject, html, text, counts: n, fresh: F };
}
/* [v0.53.70] 묶음별 상태 : state.sched[p] = { lastTriedYmd, lastSentYmd, lastSentAt, lastResult }
 *   예전 상태(state.lastTriedYmd · lastSentYmd)는 예전에 켜져 있던 묶음의 것으로 본다 → 업데이트 직후 오늘 보낸 묶음이 다시 나가지 않게 */
function schState_(state, p, st) {
  const S0 = (state && state.sched && state.sched[p]) || null;
  if (S0) return S0;
  const legacyP = st && st.scope && PRESETS.indexOf(st.scope.preset) > -1 ? st.scope.preset : 'all';
  if (state && !state.sched && p === legacyP && (state.lastTriedYmd || state.lastSentYmd)) return { lastTriedYmd: state.lastTriedYmd || '', lastSentYmd: state.lastSentYmd || '', lastSentAt: state.lastSentAt || '', lastResult: state.lastResult || '' };
  return {};
}
function nextOf_(sch, ps, now) {
  if (!sch || !sch.on) return null;
  if (sch.mode === 'weekly' && !(sch.days || []).length) return null;
  const today = dayNum_(now.ymd);
  for (let i = 0; i < 8; i++) {
    const ymd = ymdOf_(today + i), wd = wdOf_(ymd);
    if (!dayOk_(sch, wd)) continue;
    if (i === 0 && ps && ps.lastTriedYmd === now.ymd) continue;
    const soon = i === 0 && now.hm >= sch.time;   /* 오늘 시각이 지났는데 아직 안 보냄 (서버가 꺼져 있었음) → 1분 안에 보냄 */
    return { ymd, time: sch.time, soon, label: ymd + ' (' + WD[wd] + ') ' + sch.time + (soon ? ' (곧 보냄)' : '') };
  }
  return null;
}
function nextRun_(st, state, now) {
  if (!st.enabled) return null;
  const n = now || nowKst_(), sc = st.schedules || schedulesOf_(st);
  const list = PRESETS.map(p => { const x = nextOf_(sc[p], schState_(state, p, st), n); return x ? Object.assign(x, { preset: p, name: PRESET_NAME[p], label: x.label + ' · ' + PRESET_NAME[p] }) : null; }).filter(Boolean);
  list.sort((a, b) => (a.ymd + a.time).localeCompare(b.ymd + b.time));
  return list[0] || null;
}
function nextAll_(st, state, now) { const n = now || nowKst_(), sc = st.schedules || schedulesOf_(st), o = {}; PRESETS.forEach(p => { o[p] = st.enabled ? nextOf_(sc[p], schState_(state, p, st), n) : null; }); return o; }
/* 예전 상태를 묶음별로 옮겨 적는다 (예전 설정 기준 · 설정을 바꾸기 전에 부른다) */
async function migrateState_(st) {
  const state = await propJson_(STATE_KEY, {}) || {};
  if (state.sched) return state;
  const sched = {}; PRESETS.forEach(q => { const x = schState_(state, q, st); if (x && Object.keys(x).length) sched[q] = x; });   /* 옮기기 전 상태로 읽는다 (sched 를 먼저 만들면 예전 기록을 못 읽음) */
  state.sched = sched;
  await propSet_(STATE_KEY, JSON.stringify(state));
  return state;
}
async function updState_(p, patch) {   /* 묶음 하나의 상태만 고친다 (다른 묶음 기록은 그대로) */
  const state = await propJson_(STATE_KEY, {}) || {};
  if (!state.sched) state.sched = {};
  state.sched[p] = Object.assign({}, state.sched[p] || {}, patch);
  await propSet_(STATE_KEY, JSON.stringify(state));
  return state;
}
/* 같은 묶음 · 같은 날은 한 번만 : 'MAT_MAIL_RUN:<묶음>:<날짜>' 를 새로 넣기 (이미 있으면 DB 가 거절 409) — 서버 확인이 겹치거나 프로세스가 둘이어도 */
async function claimRun_(p, ymd) {
  try {
    const r = await supaFetch_('POST', 'app_props', [{ key: 'MAT_MAIL_RUN:' + p + ':' + ymd, value: JSON.stringify({ at: new Date().toISOString(), pid: process.pid }), updated_at: new Date().toISOString() }], { Prefer: 'return=minimal' });
    if (r.ok) return true;
    return r.status !== 409;   /* 표가 응답하지 않으면 상태 기록(lastTriedYmd)만으로 막는다 */
  } catch (e) { return true; }
}
let RUN_SWEPT = '';
async function sweepRuns_(ymd) {   /* 2주 지난 실행 표시는 지운다 (하루 한 번) */
  if (RUN_SWEPT === ymd) return; RUN_SWEPT = ymd;
  try { await supaFetch_('DELETE', 'app_props?key=like.' + encodeURIComponent('MAT_MAIL_RUN:') + '*&updated_at=lt.' + encodeURIComponent(new Date(Date.now() - 14 * 86400000).toISOString()), null, { Prefer: 'return=minimal' }); } catch (e) {}
}

/* ── 보내기 ── */
let SENDING = false;
async function sendNow_(opts) {
  const o = opts || {};
  if (SENDING) return { success: false, message: '지금 보내는 중입니다. 잠시 뒤 다시 확인해 주세요.' };
  SENDING = true;
  try {
    const st = o.settings || await settings_();
    const mi = mailer.invInfo();
    if (!mi.ready) throw new Error(mi.reason);
    const from = mi.fromAddress || (o.testTo || '');
    if (!from) throw new Error('발송 계정(INV_SMTP_USER)이 없습니다.');
    const now = nowKst_();
    const it = await items_(st, now.ymd);
    const sc = st.scope || DEFAULTS.scope;
    const total = (sc.now ? it.now.length : 0) + (sc.wk ? it.wk.length : 0) + (sc.m1 ? it.m1.length : 0) + (it.eol || []).filter(x => x.out && x.D <= 30).length;   /* [v0.53.72] 30일 안에 소진되는 단종 자재가 있으면 그것만으로도 보냄 */
    if (!total && !o.test) {
      await log_({ by: o.by || 'auto', kind: o.kind || 'auto', preset: sc.preset || 'all', ok: true, skipped: true, note: '보낼 항목 없음 (즉시 조달 · 이번 주 발주 0건)' });
      return { success: true, skipped: true, sent: 0, message: '보낼 항목이 없어 건너뛰었습니다 (즉시 조달 · 이번 주 발주 0건).' };
    }
    const m = compose_(st, it, now.ymd);
    let to = parseAddrs(st.to), cc = parseAddrs(st.cc);
    if (o.test) { to = [{ name: '', address: o.testTo }]; cc = []; }
    if (!to.length) throw new Error('받는 사람이 없습니다.');
    const r = await mailer.invSend({
      from: { name: st.fromName, address: from }, fromLabel: st.fromName, replyTo: from,
      to: to.map(a => ({ name: a.name, address: a.address })), cc: cc.map(a => ({ name: a.name, address: a.address })),
      subject: (o.test ? '[시험] ' : '') + m.subject, text: m.text, html: m.html
    });
    if (!r.accepted.length) throw new Error('메일 서버가 받는 사람을 모두 거절했습니다 : ' + r.rejected.join(', ') + ' ' + r.response);
    await log_({ by: o.by || 'auto', kind: o.kind || 'auto', preset: sc.preset || 'all', ok: true, test: !!o.test, subject: m.subject, counts: m.counts, to: to.map(a => a.address), cc: cc.map(a => a.address), smtp: clip(r.response, 160) });
    return { success: true, sent: 1, counts: m.counts, to: to.map(a => a.address), message: '✓ 즉시 조달 ' + m.counts.now + ' · 이번 주 발주 ' + m.counts.wk + ' → ' + to.map(a => a.address).join(', ') };
  } catch (e) {
    try { await log_({ by: o.by || 'auto', kind: o.kind || 'auto', preset: ((o.settings || {}).scope || {}).preset || '', ok: false, test: !!o.test, error: e.message }); } catch (x) {}
    return { success: false, message: e.message };
  } finally { SENDING = false; }
}

let TIMER = null, TICKING = false;
async function tick_() {
  if (TICKING) return; TICKING = true;   /* [v0.53.70] 한 번 확인이 끝나기 전에 다음 확인이 겹치지 않게 */
  try {
    const st = await settings_();
    if (!st.enabled) return;
    const now = nowKst_();
    await migrateState_(st);
    sweepRuns_(now.ymd);
    const order = PRESETS.slice().sort((a, b) => String(st.schedules[a].time).localeCompare(String(st.schedules[b].time)));
    for (const p of order) {
      const sch = st.schedules[p];
      if (!sch.on || !dayOk_(sch, now.wd) || now.hm < sch.time) continue;
      const state = await propJson_(STATE_KEY, {}) || {};
      if (schState_(state, p, st).lastTriedYmd === now.ymd) continue;
      await updState_(p, { lastTriedYmd: now.ymd, lastTriedAt: new Date().toISOString() });
      if (!(await claimRun_(p, now.ymd))) continue;   /* 다른 곳에서 이미 보냄 */
      const r = await sendNow_({ by: 'auto', kind: 'auto', settings: Object.assign({}, st, { scope: Object.assign({}, st.scope, { preset: p }) }) });
      await updState_(p, Object.assign({ lastResult: r.success ? (r.skipped ? 'skipped' : 'sent') : ('fail: ' + clip(r.message, 160)) }, r.sent ? { lastSentYmd: now.ymd, lastSentAt: new Date().toISOString() } : {}));
    }
  } catch (e) { console.error('[자재관리 메일] 자동 발송 확인 실패', e.message); }
  finally { TICKING = false; }
}

/* ══ [v0.53.6] 휴대폰 알림 (AKC 안드로이드 앱 · 음성) ══
   매일 08:30 · 17:30 (한국 시각) 에 즉시 조달 자재를 알림으로 보내고, AKC 앱이 받아 음성(TTS)으로 읽는다.
   · 보내는 길 : 출하관리 휴대폰 알림과 같은 lib/push.js sendAll (앱 = Firebase → 앱이 알림 + 음성 · 앱이 없으면 웹 푸시 알림)
   · 받는 사람 : 자재관리 화면 권한이 있는 사람의 등록된 기기 (마스터 · 관리자 포함)
   · 범위 : 메일 설정의 범위(해외 · 국내 · JG · 상품)와 같다. 같은 시각 칸은 하루 한 번만 (DB 기록 · 서버가 다시 켜져도 그대로)
   · 설정 · 기록 : app_props 'MAT_PUSH_SETTINGS' · 'MAT_PUSH_STATE' · 'MAT_PUSH_LOG' */
const PSET = 'MAT_PUSH_SETTINGS', PSTATE = 'MAT_PUSH_STATE', PLOG = 'MAT_PUSH_LOG';
const PDEF = { enabled: true, times: ['08:30', '17:30'], weekend: true };
async function pushSettings_() { const s = await propJson_(PSET, {}) || {}; return { enabled: s.enabled === undefined ? PDEF.enabled : !!s.enabled, times: Array.isArray(s.times) && s.times.length ? s.times : PDEF.times, weekend: s.weekend === undefined ? PDEF.weekend : !!s.weekend, updatedBy: s.updatedBy || '', updatedAt: s.updatedAt || '' }; }
async function pushLog_(rec) { const list = await propJson_(PLOG, []) || []; list.unshift(Object.assign({ at: new Date().toISOString() }, rec)); await propSet_(PLOG, JSON.stringify(list.slice(0, 40))); }
async function materialIds_() {
  const auth = require('./auth'), all = await auth.authReadAll_(false), ok = new Set();
  all.forEach(x => { try { const pu = auth.authPublicUser_(x.user); if (pu.role === 'master' || pu.role === 'admin' || (pu.views || []).indexOf('material') > -1) ok.add(String(pu.id).toLowerCase()); } catch (e) {} });
  return ok;
}
const sayNum = n => Math.round(n).toLocaleString('ko-KR');
async function pushMessage_(slot) {
  const st = await settings_(), now = nowKst_(), it = await items_(st, now.ymd);
  const hit = it.now.filter(x => x.prods), ovs = it.now.filter(x => x.region === '해외').length;
  const top = (hit.length ? hit : it.now).slice(0, 3);
  const title = '자재관리 · 즉시 조달 ' + it.now.length + '건' + (it.wk.length ? ' · 이번 주 발주 ' + it.wk.length + '건' : '');
  const body = it.now.length ? top.map(x => x.code + ' ' + (x.name || '') + ' (재고 ' + sayNum(x.stock) + ')').join('\n') + (it.now.length > 3 ? '\n외 ' + (it.now.length - 3) + '건' : '') : '즉시 조달할 자재가 없습니다.';
  const speak = (slot === '17:30' ? '오후 ' : '오전 ') + '자재관리 알림입니다. ' +
    (it.now.length ? '지금 즉시 조달이 필요한 자재는 ' + it.now.length + '건이고, 그중 해외 자재는 ' + ovs + '건, 생산에 영향이 있는 자재는 ' + hit.length + '건입니다. ' +
      '주요 자재는 ' + top.map(x => (x.name || x.code) + (x.sup ? ', 매입처 ' + x.sup : '')).join('. 그리고 ') + ' 입니다. ' : '즉시 조달이 필요한 자재는 없습니다. ') +
    (it.wk.length ? '이번 주 발주가 필요한 자재는 ' + it.wk.length + '건입니다.' : '');
  return { payload: { title, body, speak, tag: 'akc-material-' + now.ymd + '-' + slot, url: '/?view=material', voice: true }, counts: { now: it.now.length, wk: it.wk.length, hit: hit.length } };
}
let PUSHING = false;
async function pushNow_(slot, onlyId, by) {
  if (PUSHING) return { success: false, message: '보내는 중입니다.' };
  PUSHING = true;
  try {
    const push = require('../lib/push');
    const m = await pushMessage_(slot);
    const allow = await materialIds_();
    const r = await push.sendAll(m.payload, onlyId || undefined, allow);
    await pushLog_({ by: by || 'auto', slot, ok: true, sent: r.sent || 0, counts: m.counts, test: !!onlyId });
    return { success: true, sent: r.sent || 0, counts: m.counts, title: m.payload.title, speak: m.payload.speak, message: (r.sent ? '기기 ' + r.sent + '대에 보냈습니다.' : '받을 기기가 없습니다 (AKC 앱 · 휴대폰 알림 등록 필요).') };
  } catch (e) {
    try { await pushLog_({ by: by || 'auto', slot, ok: false, error: e.message }); } catch (x) {}
    return { success: false, message: e.message };
  } finally { PUSHING = false; }
}
async function pushTick_() {
  try {
    const ps = await pushSettings_(); if (!ps.enabled) return;
    const now = nowKst_(); if (!ps.weekend && (now.wd === 0 || now.wd === 6)) return;
    const state = await propJson_(PSTATE, {}) || {};
    for (const t of ps.times) {
      const key = now.ymd + ' ' + t;
      if (state[key] || now.hm < t) continue;
      const [h, mi] = t.split(':').map(Number), [h2, m2] = now.hm.split(':').map(Number);
      if ((h2 * 60 + m2) - (h * 60 + mi) > 90) { state[key] = 'skipped (늦음)'; continue; }   // 서버가 오래 꺼져 있었으면 지난 칸은 건너뜀
      state[key] = new Date().toISOString();
      Object.keys(state).filter(k => k < addDaysYmd_(now.ymd, -7)).forEach(k => delete state[k]);
      await propSet_(PSTATE, JSON.stringify(state));   // 먼저 적는다 (두 번 보내지 않게)
      await pushNow_(t, null, 'auto');
    }
    await propSet_(PSTATE, JSON.stringify(state));
  } catch (e) { console.error('[자재관리 휴대폰 알림] 확인 실패', e.message); }
}
const addDaysYmd_ = (ymd, n) => ymdOf_(dayNum_(ymd) + n);

function mount(app, deps) {
  const { userFromRequest_, canView } = deps;
  getModel = deps.model;
  const J = require('express').json({ limit: '2mb' });
  const gate = async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const o = req.headers.origin;
    if (req.method !== 'GET' && o && o.replace(/^https?:\/\//, '') !== req.headers.host) { res.status(403).json({ success: false, message: '허용되지 않은 출처입니다.' }); return null; }
    const user = await userFromRequest_(req);
    if (!user) { res.status(401).json({ success: false, needLogin: true, message: '로그인이 필요합니다.' }); return null; }
    if (user.role !== 'master') { res.status(403).json({ success: false, message: '이메일 설정은 마스터 계정만 볼 수 있습니다.' }); return null; }   // [v0.53.9]
    return user;
  };
  const audit = (user, what, detail, ok) => { try { require('../lib/audit').auditLog_(user.id, '자재관리 메일', what, String(detail || '').slice(0, 300), ok !== false, user.name); } catch (e) {} };
  const myEmail = async user => { try { const r = await supaGetJson_('users?select=email&id=eq.' + encodeURIComponent(user.id) + '&limit=1'); return String((r && r[0] && r[0].email) || '').trim(); } catch (e) { return ''; } };
  const linkOf = req => { try { return deps.baseUrlOf_ ? deps.baseUrlOf_(req) + '/' : ''; } catch (e) { return ''; } };

  app.get('/apps/material/mail/config', async (req, res) => {
    const user = await gate(req, res); if (!user) return;
    try {
      const [st, state, log, email] = await Promise.all([settings_(), propJson_(STATE_KEY, {}), propJson_(LOG_KEY, []), myEmail(user)]);
      const mi = mailer.invInfo();
      res.json({ success: true, settings: st, defaults: DEFAULTS, state, next: nextRun_(st, state), nexts: nextAll_(st, state), presetNames: PRESET_NAME, log: (log || []).slice(0, 20), now: nowKst_(), suggestLink: linkOf(req),
        smtp: { ready: mi.ready, reason: mi.reason, fromAddress: mi.fromAddress || '' }, me: { id: user.id, name: user.name || '', email } });
    } catch (e) { res.json({ success: false, message: e.message }); }
  });
  app.post('/apps/material/mail/preview', J, async (req, res) => {
    const user = await gate(req, res); if (!user) return;
    try {
      const b = req.body || {}, base = await settings_();
      const st = Object.assign({}, base, b.settings && typeof b.settings === 'object' ? b.settings : {});
      st.scope = Object.assign({}, base.scope, (b.settings && b.settings.scope) || {});
      const now = nowKst_(), mi = mailer.invInfo();
      const it = await items_(st, now.ymd), m = compose_(st, it, now.ymd);
      res.json({ success: true, subject: m.subject, html: m.html, counts: m.counts, fresh: m.fresh, to: parseAddrs(st.to).map(a => a.name || a.address), cc: parseAddrs(st.cc).map(a => a.name || a.address),
        fromDisplay: st.fromName + (mi.fromAddress ? ' <' + mi.fromAddress + '>' : ''), next: nextRun_(st, await propJson_(STATE_KEY, {})) });
    } catch (e) { res.json({ success: false, message: e.message }); }
  });
  app.post('/apps/material/mail/settings', J, async (req, res) => {
    const user = await gate(req, res); if (!user) return;
    try {
      const b = req.body || {};
      if (b.reset) { await propSet_(SET_KEY, JSON.stringify({ enabled: false })); audit(user, '기본값 되돌리기', ''); return res.json({ success: true, settings: await settings_() }); }
      const c = cleanSettings_(b);
      if (c.err) return res.json({ success: false, message: c.err });
      const prev = await settings_();
      await migrateState_(prev);   /* [v0.53.70] 예전 상태는 예전 설정 기준으로 먼저 옮긴다 */
      c.s.updatedBy = user.id; c.s.updatedAt = new Date().toISOString();
      await propSet_(SET_KEY, JSON.stringify(c.s));
      /* [v0.53.70] 예약이 바뀐 묶음 : 오늘 시각이 이미 지났으면 오늘은 건너뜀(저장하자마자 나가지 않게) · 아직이면 오늘 보냄 */
      const now = nowKst_(), state0 = await propJson_(STATE_KEY, {}) || {};
      for (const p of PRESETS) {
        const a0 = prev.schedules[p], b0 = c.s.schedules[p];
        const changed = JSON.stringify([a0.on, a0.time, a0.mode, a0.days]) !== JSON.stringify([b0.on, b0.time, b0.mode, b0.days]) || (!prev.enabled && c.s.enabled);
        if (!changed || !b0.on) continue;
        const ps = schState_(state0, p, prev);
        if (ps.lastSentYmd === now.ymd) continue;
        if (dayOk_(b0, now.wd) && now.hm >= b0.time) await updState_(p, { lastTriedYmd: now.ymd, lastResult: 'skipped (시각 지난 뒤 설정)' });
        else if (ps.lastTriedYmd === now.ymd) await updState_(p, { lastTriedYmd: '' });
      }
      audit(user, '설정 저장', (c.s.enabled ? '자동 켬 · ' : '자동 끔 · ') + PRESETS.map(p => PRESET_NAME[p] + ' ' + schText_(c.s.schedules[p])).join(' / '));
      const st = await settings_();
      res.json({ success: true, settings: st, next: nextRun_(st, await propJson_(STATE_KEY, {})) });
    } catch (e) { res.json({ success: false, message: e.message }); }
  });
  app.post('/apps/material/mail/send', J, async (req, res) => {
    const user = await gate(req, res); if (!user) return;
    const b = req.body || {};
    try {
      if (b.test) {
        const email = await myEmail(user);
        if (!email) return res.json({ success: false, message: '계정에 이메일 주소가 없습니다. (계정 관리에서 이메일을 넣어 주세요)' });
        const base = await settings_();
        const st = Object.assign({}, base, b.settings && typeof b.settings === 'object' ? b.settings : {});
        st.scope = Object.assign({}, base.scope, (b.settings && b.settings.scope) || {});
        const r = await sendNow_({ by: user.id, kind: 'test', test: true, testTo: email, settings: st });
        audit(user, '시험 메일', email + ' ' + (r.success ? '' : r.message), r.success);
        return res.json(Object.assign({ testTo: email }, r));
      }
      /* [v0.53.70] 고른 묶음(미리보기 대상)을 지금 보냄 → 그 묶음의 오늘 자동 발송은 건너뜀 */
      const base = await settings_(), p = PRESETS.indexOf(b.preset) > -1 ? b.preset : (base.scope.preset || 'all');
      await migrateState_(base);
      const r = await sendNow_({ by: user.id, kind: 'manual', settings: Object.assign({}, base, { scope: Object.assign({}, base.scope, { preset: p }) }) });
      if (r.sent) { const now = nowKst_(); await updState_(p, { lastSentYmd: now.ymd, lastSentAt: new Date().toISOString(), lastTriedYmd: now.ymd, lastResult: 'sent (manual)' }); }
      audit(user, '지금 보내기', r.message, r.success);
      res.json(r);
    } catch (e) { res.json({ success: false, message: e.message }); }
  });
  /* [v0.53.7] 주소 자동완성 : AKC 계정(이름 · 이메일) + 지금까지 메일 설정에 쓴 주소 (VF 매출채권 메일 사내 주소 포함) */
  app.get('/apps/material/mail/contacts', async (req, res) => {
    const user = await gate(req, res); if (!user) return;
    try {
      const out = [], seen = {};
      const add = (name, email, from) => { email = String(email || '').trim(); if (!EMAIL.test(email) || seen[email.toLowerCase()]) return; seen[email.toLowerCase()] = true; out.push({ name: String(name || '').trim(), email, from }); };
      try { const all = await require('./auth').authReadAll_(false); all.forEach(x => { const u = x.user || {}; add(u.name || u.id, u.email, 'AKC 계정'); }); } catch (e) {}
      const st = await settings_(); parseAddrs(st.to + ';' + st.cc).forEach(a => add(a.name, a.address, '자재관리 메일'));
      try { const vf = await propJson_('VFFIN_MAIL_SETTINGS', {}) || {}; Object.values(vf.regions || {}).forEach(r => parseAddrs((r.to || '') + ';' + (r.cc || '')).forEach(a => add(a.name, a.address, '매출채권 메일'))); } catch (e) {}
      out.sort((a, b) => (a.from === 'AKC 계정' ? 0 : 1) - (b.from === 'AKC 계정' ? 0 : 1) || a.name.localeCompare(b.name));
      res.json({ success: true, contacts: out });
    } catch (e) { res.json({ success: false, message: e.message }); }
  });
  /* 휴대폰 알림 설정 · 시험 */
  app.get('/apps/material/push/config', async (req, res) => {
    const user = await gate(req, res); if (!user) return;
    try {
      const [ps, log, state] = await Promise.all([pushSettings_(), propJson_(PLOG, []), propJson_(PSTATE, {})]);
      let devices = 0, mine = 0;
      try { const push = require('../lib/push'); const allow = await materialIds_(); const lst = push.list(); devices = lst.filter(x => allow.has(String(x.id || '').toLowerCase())).length; mine = lst.filter(x => String(x.id) === String(user.id)).length;
        try { const f = require('../lib/fcm'); if (f.ready()) { const ft = f.list(); Object.keys(ft).forEach(t => { if (allow.has(String(ft[t].id || '').toLowerCase())) devices++; if (String(ft[t].id) === String(user.id)) mine++; }); } } catch (e) {} } catch (e) {}
      res.json({ success: true, settings: ps, log: (log || []).slice(0, 15), devices, mine, now: nowKst_(), sentToday: Object.keys(state || {}).filter(k => k.indexOf(nowKst_().ymd) === 0) });
    } catch (e) { res.json({ success: false, message: e.message }); }
  });
  app.post('/apps/material/push/settings', J, async (req, res) => {
    const user = await gate(req, res); if (!user) return;
    try {
      const b = req.body || {}, times = (Array.isArray(b.times) ? b.times : []).map(String).filter(t => /^([01]\d|2[0-3]):[0-5]\d$/.test(t)).slice(0, 4).sort();
      if (!times.length) return res.json({ success: false, message: '알림 시각을 하나 이상 넣어 주세요.' });
      await propSet_(PSET, JSON.stringify({ enabled: !!b.enabled, times, weekend: b.weekend !== false, updatedBy: user.id, updatedAt: new Date().toISOString() }));
      // 오늘 이미 지난 시각은 저장하자마자 울리지 않게 '건너뜀' 으로 적는다
      const now = nowKst_(), state = await propJson_(PSTATE, {}) || {};
      times.forEach(t => { const k = now.ymd + ' ' + t; if (!state[k] && now.hm >= t) state[k] = 'skipped (설정 시각 지남)'; });
      await propSet_(PSTATE, JSON.stringify(state));
      audit(user, '휴대폰 알림 설정', (b.enabled ? '켬 ' : '끔 ') + times.join(', '));
      res.json({ success: true, settings: await pushSettings_() });
    } catch (e) { res.json({ success: false, message: e.message }); }
  });
  app.post('/apps/material/push/test', J, async (req, res) => {
    const user = await gate(req, res); if (!user) return;
    const r = await pushNow_(nowKst_().hm < '12:00' ? '08:30' : '17:30', user.id, user.id);
    audit(user, '휴대폰 알림 시험', r.message, r.success);
    res.json(r);
  });
  app.post('/apps/material/push/preview', J, async (req, res) => {
    const user = await gate(req, res); if (!user) return;
    try { const m = await pushMessage_(nowKst_().hm < '12:00' ? '08:30' : '17:30'); res.json({ success: true, payload: m.payload, counts: m.counts }); } catch (e) { res.json({ success: false, message: e.message }); }
  });
  if (!TIMER && !deps.noTimer) { TIMER = setInterval(() => { tick_(); pushTick_(); }, 60 * 1000); setTimeout(() => { tick_(); pushTick_(); }, 20 * 1000); }
}

module.exports = { pushTick_, pushMessage_, pushNow_, pushSettings_, mount, settings_, nextRun_, compose_, items_, tick_, sendNow_, nowKst_, DEFAULTS, _parseAddrs: parseAddrs, _clean: cleanSettings_, _schedulesOf: schedulesOf_, _nextAll: nextAll_,
  clsOf_, keyInf_, isInf_, isOpw_, isWh_, clsM_ };   /* [v0.53.92] AI 검색(api/material-ai.js)이 메일 · 화면과 같은 품목군 분류를 쓰게 내보낸다 */
