/**
 * 파일명: api/material-rules.js
 * 목적: [자재관리 · v0.53.0] MES 로우데이터 5종을 읽는 규칙 '한 곳'.
 *   서버(api/material.js)가 저장할 때와 화면(설정 › 업로드 › 자재관리)이 미리보기할 때 같은 코드를 쓴다.
 *   화면에는 /apps/material/rules.js 로 그대로 내려간다 (window.MMRules).
 *
 *   종류            | 파일                                   | qty           | qty2      | qty3
 *   purchase        | 1. 협력사마감 - 매입(원자재상품)        | 승인수량      | BOX수량   | -
 *   outsrc          | 1-1. 협력사마감 - 생산(외주임가공)      | 승인수량      | BOX수량   | 임가공비
 *   goods_sales     | 2. 재고,수불현황 - 상품매출자료 현황     | 매출승인수량  | BOX수량   | 적입수량
 *   production      | 2-1. 재고,수불현황 - 제품 생산자료현황   | 양품수량      | 생산총수량 | 불량수량
 *   ovs_ship        | 3. 제품 매출자료현황(해외 출고수량)      | 그날 수량     | 총수량    | -   (품목 × 날짜 표를 날짜별 줄로 풀어 저장)
 *
 *   교체 규칙 : 파일 1행의 기간 라벨(예: //2026-09-01-2026-10-31)과 실제 날짜 범위를 합친 기간의 예전 자료를 지우고 새 자료로 바꾼다.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MMRules = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const KINDS = {
    purchase:    { label: '매입 (원자재 · 상품)',   file: '1. 협력사마감 - 매입(원자재상품)',  need: ['품목코드[P/TNO.]', '승인수량', 'PART'], not: ['임가공비', '생산총수량', '매출승인수량'] },
    outsrc:      { label: '외주임가공',            file: '1-1. 협력사마감 - 생산(외주임가공)', need: ['품목코드[P/TNO.]', '승인수량', '임가공비'] },
    goods_sales: { label: '상품매출',              file: '2. 재고,수불현황 - 상품매출자료 현황', need: ['품목코드[P/TNO.]', '매출승인수량'] },
    production:  { label: '생산실적 (본 화면 「생산실적」 탭)',              file: '2-1. 재고,수불현황 - 제품 생산자료현황', need: ['품목코드[P/TNO.]', '생산총수량', '양품수량[QTY]'] },
    ovs_ship:    { label: '해외출고',              file: '3. 재고,수불현황 - 제품 매출자료현황(해외 출고수량)', need: ['품목코드', '총수량[QTY]'] }   /* [v0.53.34] 같은 화면 아래쪽 목록(등록일자 · 매출승인수량)도 받는다 — fgRatio */
  };
  const ORDER = ['purchase', 'outsrc', 'goods_sales', 'production', 'ovs_ship'];
  /* 입고 상태 (매입) — [v0.53.0] 실제 자료로 확인한 결과, 검사성적서제출 · 입고대기 상태로 들어온 물량도 그대로 출고(상품매출)되고 있었다
     (예: BGE040027H 8/31 기말 290,000 + 확정 175,000 < 9~10월 상품매출 650,000 → 확인 대기 270,000 까지 더해야 맞음).
     그래서 반품 · 부적합 · 반려만 빼고 모두 재고에 더한다. 확정 전 상태는 화면에 '확인 대기' 로 따로 보여 준다 */
  const RECEIVED = ['입고승인', '입고확정', '수입검사완료'];
  const EXCLUDED = ['입고반품', '수입검사부적합', '검사성적서반려'];

  const hn = v => String(v == null ? '' : v).replace(/\s+/g, '').toUpperCase();
  const partKey = v => String(v == null ? '' : v).replace(/[\s\-]/g, '').toUpperCase();
  const pad = n => (n < 10 ? '0' : '') + n;
  /* [v0.53.69] 와이어하네스 품번 · 매입처 (사용자 지정 2026-10-31 · 화면 캡처 2장) — 서버(매입처) · 화면(★ 와이어하네스) · 메일이 이 한 곳을 쓴다
     품명이 'LEAD WIRE' 라 'HARNESS' 글자 규칙에 걸리지 않고, 자료마다 매입처 이름이 달라 품번으로 정한다 */
  const WH_SUP = {
    '신진': ['KABL181007H1', 'KABL181017H1', 'KACL180000H1', 'KACL180010H1', 'KACL180020H1', 'KACN180001K1', 'KACN180021K1', 'KACN180031K1', 'KAEL180000H1', 'KAEN180010K1'],
    '진영전기': ['KABL181007H', 'KABL181017K', 'KABN180017K', 'KACL1800000H', 'KACL1800000K-2', 'KACL1800010H', 'KACL1800010K-2', 'KACL180020H', 'KACL180020K-2', 'KACL180030H', 'KACN180001K', 'KACN180021K', 'KACN180031K', 'KAEL180000H', 'KAEN180010K']
  };
  const WH_EXTRA = ['KACL180060K', 'KAEL180020K'];   /* 예전(v0.53.32)에 와이어하네스로 지정한 품번 (매입처는 자료 그대로) */
  const WH_SUP_OF = {}; Object.keys(WH_SUP).forEach(s => WH_SUP[s].forEach(c => { WH_SUP_OF[String(c).replace(/[\s\-]/g, '').toUpperCase()] = s; }));
  const WH_SET = new Set(Object.keys(WH_SUP_OF).concat(WH_EXTRA.map(c => String(c).replace(/[\s\-]/g, '').toUpperCase())));
  const whSupOf = c => WH_SUP_OF[String(c == null ? '' : c).replace(/[\s\-]/g, '').toUpperCase()] || '';
  const isWhCode = c => WH_SET.has(String(c == null ? '' : c).replace(/[\s\-]/g, '').toUpperCase());
  /* [v0.53.72] 소진 후 단종 (재주문 안 함) 기본 목록 = 진영전기 와이어하네스 15개 — 남은 재고만 쓰고 더 사지 않는다 (사용자 지정 2026-10-31)
     화면 [소진 후 사용 안 함] 스위치로 바꾼 값(app_props 'mm_eol')이 있으면 그 값이 우선 */
  const EOL_DEFAULT = new Set(WH_SUP['진영전기'].map(c => String(c).replace(/[\s\-]/g, '').toUpperCase()));
  const eolOf = (k, over) => { const K = String(k == null ? '' : k).replace(/[\s\-]/g, '').toUpperCase(); return over && Object.prototype.hasOwnProperty.call(over, K) ? !!over[K] : EOL_DEFAULT.has(K); };
  const ymd = d => d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
  function toDate(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number' && isFinite(v)) {             // 엑셀 날짜 번호 (1900 체계)
      if (v < 20000 || v > 80000) return null;
      return ymd(new Date(Date.UTC(1899, 11, 30) + Math.floor(v) * 86400000));
    }
    if (v instanceof Date) return isNaN(v) ? null : ymd(new Date(Date.UTC(v.getFullYear(), v.getMonth(), v.getDate())));
    const s = String(v).trim();
    let m = s.match(/^(\d{4})[-./](\d{1,2})[-./](\d{1,2})/);
    if (m) return m[1] + '-' + pad(+m[2]) + '-' + pad(+m[3]);
    m = s.match(/^(\d{2})(\d{2})(\d{2})$/);                 // 260901
    if (m) return '20' + m[1] + '-' + m[2] + '-' + m[3];
    if (/^\d+(\.\d+)?$/.test(s)) return toDate(Number(s));
    return null;
  }
  function num(v) {
    if (v == null || v === '' || typeof v === 'boolean') return null;
    if (typeof v === 'number') return isFinite(v) ? v : null;
    const n = Number(String(v).replace(/,/g, '').trim());
    return isFinite(n) ? n : null;
  }
  const txt = v => { const s = String(v == null ? '' : v).trim(); return s === '' ? null : s; };
  const addDays = (s, n) => ymd(new Date(Date.parse(s + 'T00:00:00Z') + n * 86400000));

  /* 1행 기간 라벨 : '//2026-09-01-2026-10-31' · '//2026-09-01~2026-10-31' */
  function parseLabel(rows) {
    for (let r = 0; r < Math.min(rows.length, 3); r++) {
      const s = String((rows[r] || [])[0] || '');
      const m = s.match(/(\d{4})[-.\/](\d{1,2})[-.\/](\d{1,2})\s*[~\-]\s*(\d{4})[-.\/](\d{1,2})[-.\/](\d{1,2})/);
      if (m) return { text: s.replace(/^\/+/, '').trim(), from: m[1] + '-' + pad(+m[2]) + '-' + pad(+m[3]), to: m[4] + '-' + pad(+m[5]) + '-' + pad(+m[6]) };
    }
    return null;
  }
  function headerIndex(rows) {
    for (let r = 0; r < Math.min(rows.length, 10); r++) {
      const h = (rows[r] || []).map(hn);
      if (h.indexOf('품목코드[P/TNO.]') > -1 || h.indexOf('품목코드') > -1) return r;
    }
    return -1;
  }
  /* [v0.53.34] 「제품 매출자료현황」 아래쪽 목록은 머리글이 상품매출과 똑같다 (품목코드[P/T No.] · 매출승인수량)
     → 창고 이름(W/H Line Name)이 완제품 창고(완제품 · _FG)인 줄이 절반 넘으면 제품 매출(= 해외출고 탭 자료)로 본다 */
  function fgRatio(header, rows) {
    const h = (header || []).map(hn), i = h.indexOf(hn('W/H Line Name')); if (i < 0) return 0;
    const v = (rows || []).filter(r => r && String(r[i] || '').trim()); if (!v.length) return 0;
    return v.filter(r => /완제품|(^|[^A-Z])FG([^A-Z]|$)|_FG/i.test(String(r[i]))).length / v.length;
  }
  function detectKind(header) {
    const h = (header || []).map(hn);
    for (const k of ORDER) {
      const d = KINDS[k];
      if (d.need.every(x => h.indexOf(hn(x)) > -1) && !(d.not || []).some(x => h.indexOf(hn(x)) > -1)) return k;
    }
    return '';
  }
  function colFinder(header) {
    const h = (header || []).map(hn);
    return function (names) {
      for (const n of names) { const i = h.indexOf(hn(n)); if (i > -1) return i; }
      for (const n of names) { const i = h.findIndex(x => x.indexOf(hn(n)) === 0); if (i > -1) return i; }
      return -1;
    };
  }
  /* 날짜 칸 '[09-01] 화' → 날짜 · '[40Days↑]' → 40일 이후 묶음 */
  function pivotCols(header, label) {
    const out = [];
    const y0 = label ? +label.from.slice(0, 4) : new Date().getFullYear();
    const m0 = label ? +label.from.slice(5, 7) : 1;
    let lastDate = null;
    (header || []).forEach((v, i) => {
      const s = String(v == null ? '' : v);
      let m = s.match(/\[(\d{1,2})-(\d{1,2})\]/);
      if (m) {
        const mo = +m[1], y = mo < m0 ? y0 + 1 : y0;
        lastDate = y + '-' + pad(mo) + '-' + pad(+m[2]);
        out.push({ i, date: lastDate, bucket: false, col: s.trim() });
        return;
      }
      if (/days/i.test(s) && /\d/.test(s)) out.push({ i, date: null, bucket: true, col: s.trim() });
    });
    out.forEach(c => { if (c.bucket) c.date = lastDate ? addDays(lastDate, 1) : (label ? label.to : null); });
    return out;
  }

  /* 한 파일(머리글 + 데이터 줄) → 저장할 줄 목록. 서버와 화면이 같이 쓴다 */
  function mapRows(kind, header, rows, label) {
    const col = colFinder(header), keys = (header || []).map(v => String(v == null ? '' : v).trim());
    const rawOf = r => { const o = {}; keys.forEach((k, i) => { if (!k) return; const v = r[i]; if (v !== '' && v != null) o[o[k] !== undefined ? k + '#' + i : k] = v; }); return o; };
    const out = [], skipped = [];
    if (kind === 'ovs_ship' && col(['총수량[Qty]']) > -1) {   /* 품목 × 날짜 표 (위쪽) — 목록(아래쪽)은 아래 공통 처리 */
      const C = { part: col(['품목코드']), name: col(['품목명[Description]']), spec: col(['규격']), unit: col(['단위']), cm: col(['CM']), wh: col(['WH']), tot: col(['총수량[Qty]']), rev: col(['REV']) };
      const P = pivotCols(header, label);
      rows.forEach((r, n) => {
        const part = txt(r[C.part]);
        if (!part) { skipped.push(n); return; }
        const base = { part_no: part, part_key: partKey(part), part_name: txt(r[C.name]), spec: txt(r[C.spec]), unit: txt(r[C.unit]), cm_code: txt(r[C.cm]), cm_name: null, project: null, part_type: null };
        const info = {}; ['품목코드', '품목명[Description]', '규격', '단위', 'REV', '검색', 'CM', 'WH', '총수량[Qty]'].forEach(k => { const i = col([k]); if (i > -1 && r[i] !== '' && r[i] != null) info[k] = r[i]; });
        let any = false;
        P.forEach(c => {
          const q = num(r[c.i]);
          if (!q) return;
          any = true;
          out.push(Object.assign({}, base, { row_date: c.date, status: c.bucket ? '40일 이후 묶음' : null, qty: q, qty2: num(r[C.tot]), qty3: null, unit_price: null, amount: null, vat: null, amount_total: null, doc_no: txt(r[C.wh]), raw: Object.assign({ _col: c.col }, info) }));
        });
        if (!any) skipped.push(n);
      });
      return { rows: out, skipped: skipped.length };
    }
    const C = {
      date: col(['등록일자']), cm_code: col(['C/M No.']), cm_name: col(['Customer Name']), project: col(['프로젝트명']),
      part: col(['품목코드[P/T No.]', '품목코드']), name: col(['품목명[Description]']), spec: col(['규격']), unit: col(['단위']),
      part_type: col(['PART']), status: kind === 'purchase' || kind === 'outsrc' ? col(['입고승인']) : col(['구분']),
      box: col(['BOX수량']), price: col(['단가[\\원화]', '단가']), amount: col(['금액[\\원화]', '금액']), vat: col(['부가세[\\원화]', '부가세']), total: col(['포함금액[\\원화]', '포함금액']),
      appr: col(['승인수량']), fee: col(['임가공비']), sale: col(['매출승인수량']), ppq: col(['적입수량[PPQ]']),
      good: col(['양품수량[Qty]']), all: col(['생산총수량']), bad: col(['불량수량[Qty]']),
      order: col(['Order No.']), inv: col(['INVOICE NO']), tr: col(['Tr. No.'])
    };
    const g = (r, i) => (i > -1 ? r[i] : null);
    rows.forEach((r, n) => {
      const part = txt(g(r, C.part)), d = toDate(g(r, C.date));
      if (!part || !d) { skipped.push(n); return; }
      const o = {
        row_date: d, part_no: part, part_key: partKey(part), part_name: txt(g(r, C.name)), spec: txt(g(r, C.spec)), unit: txt(g(r, C.unit)),
        cm_code: txt(g(r, C.cm_code)), cm_name: txt(g(r, C.cm_name)), project: txt(g(r, C.project)), part_type: txt(g(r, C.part_type)), status: txt(g(r, C.status)),
        qty: null, qty2: num(g(r, C.box)), qty3: null, unit_price: num(g(r, C.price)), amount: num(g(r, C.amount)), vat: num(g(r, C.vat)), amount_total: num(g(r, C.total)),
        doc_no: txt(g(r, C.order)) || txt(g(r, C.tr)), raw: rawOf(r)
      };
      if (kind === 'purchase') o.qty = num(g(r, C.appr));
      if (kind === 'outsrc') { o.qty = num(g(r, C.appr)); o.qty3 = num(g(r, C.fee)); }
      if (kind === 'goods_sales' || kind === 'ovs_ship') { o.qty = num(g(r, C.sale)); o.qty3 = num(g(r, C.ppq)); o.doc_no = txt(g(r, C.inv)) || o.doc_no; }   /* ovs_ship 목록형 = 매출승인수량 */
      if (kind === 'production') { o.qty = num(g(r, C.good)); o.qty2 = num(g(r, C.all)); o.qty3 = num(g(r, C.bad)); }
      out.push(o);
    });
    return { rows: out, skipped: skipped.length };
  }

  /* 교체할 기간 = 라벨 기간 ∪ 실제 날짜 범위 */
  function periodOf(label, mapped) {
    let a = label ? label.from : null, b = label ? label.to : null;
    (mapped || []).forEach(r => { if (!r.row_date) return; if (!a || r.row_date < a) a = r.row_date; if (!b || r.row_date > b) b = r.row_date; });
    return { from: a, to: b };
  }
  /* 파일 전체(2차원 배열) 한 번에 : 화면 미리보기용 */
  function inspect(allRows) {
    const label = parseLabel(allRows), hi = headerIndex(allRows);
    if (hi < 0) return { ok: false, message: '머리글(품목코드)을 찾지 못했습니다.' };
    const header = allRows[hi];
    const data = allRows.slice(hi + 1).filter(r => (r || []).some(v => v !== '' && v != null));
    let kind = detectKind(header), listForm = false;
    if (kind === 'goods_sales' && fgRatio(header, data) >= 0.5) { kind = 'ovs_ship'; listForm = true; }   /* 제품 매출 목록 → 해외출고 */
    const m = kind ? mapRows(kind, header, data, label) : { rows: [], skipped: 0 };
    const p = periodOf(label, m.rows);
    const months = {}; m.rows.forEach(r => { if (r.row_date) months[r.row_date.slice(0, 7)] = (months[r.row_date.slice(0, 7)] || 0) + 1; });
    return { ok: !!kind, kind, listForm, label, headerIndex: hi, header, data, mapped: m.rows.length, skipped: m.skipped, period: p, months, message: kind ? '' : '어떤 자료인지 알아보지 못했습니다 (머리글이 다릅니다).' };
  }
  /* [v0.53.115] 버클 (사용자 지정 2026-11-06) — 완성품 이름으로 가른다
     · FRT BKL · FRT BUCKLE (프런트 · 해외에서 오는 부품) = ★ 집중 관리 'frt' · RR BKL · BUCKLE ASSY 등 그 밖 버클 제품 = 차순위 'rr'
     · 자재는 그 자재를 쓰는 완성품이 모두 버클 제품일 때만 (PUSH NUT · 라벨 · 실처럼 다른 제품과 같이 쓰는 공용 부품은 뺀다)
       또는 자재 품명에 FRT BKL · FRT BUCKLE 이 있으면 프런트 */
  const BKL_FRT_RX = /(^|[^A-Z])(FRT|FRONT)[\s._\-\/]*(BKL|BUCKLE)([^A-Z]|$)/i;
  const BKL_RX = /(^|[^A-Z])(BKL|BUCKLE)([^A-Z]|$)/i;
  const bklFg = name => BKL_FRT_RX.test(String(name || '')) ? 'frt' : BKL_RX.test(String(name || '')) ? 'rr' : '';
  /** name = 자재 품명 · usedIn = 쓰는 완성품 키 · fgName(k) = 완성품 이름 → 'frt' | 'rr' | '' */
  function bklOf(name, usedIn, fgName) {
    if (BKL_FRT_RX.test(String(name || ''))) return 'frt';
    const ks = usedIn || []; if (!ks.length) return '';
    const kinds = ks.map(k => bklFg(fgName ? fgName(k) : ''));
    if (kinds.some(x => !x)) return '';
    return kinds.indexOf('frt') > -1 ? 'frt' : 'rr';
  }
  return { bklFg, bklOf, WH_SUP, WH_EXTRA, whSupOf, isWhCode, EOL_DEFAULT, eolOf, KINDS, ORDER, RECEIVED, EXCLUDED, hn, partKey, toDate, num, parseLabel, headerIndex, detectKind, fgRatio, mapRows, periodOf, inspect, addDays };
});
