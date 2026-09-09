import { Router } from "express";
import { db, getSetting, setSetting } from "../db.js";
import { auth, requireBook, wrap } from "../mw.js";

// =====================================================================
// 水电气物业用量（utility）
// - 识别口径（用户 H1）：流水分类 =「住房」+ 名称含 水费/电费/燃气费/物业费
// - 生成：流水保存/编辑/恢复时自动调用 utilitySyncFlowById（幂等）
// - 反推算法照搬用户 Excel 公式：金额→用量（反向阶梯扣除）
// - 队友分拆支付：同类型 + 同覆盖区间（bill_start~bill_end）的多笔流水自动并入
//   同一账单，按合计金额反推用量（用户补充：分拆两笔相差通常不超过 7 天）
// - 规则生效日期前的流水不计入（用户补充）
// =====================================================================

const HOUSE_CAT = "住房";
// 名称关键词 → 类型；多关键词同时命中（如「水费电费一起交」）取先命中的类型，
// 合并缴费请拆开记或用「手动添加账单」。
const KW_ORDER = [
  { kw: "水费", type: "water" },
  { kw: "电费", type: "electric" },
  { kw: "燃气费", type: "gas" },
  { kw: "物业费", type: "property" },
];
export const UTILITY_TYPES = ["water", "electric", "gas", "property"];
export const TYPE_LABEL = { water: "水费", electric: "电费", gas: "燃气费", property: "物业费" };

const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const ymAdd = (ym, n) => {
  const [y, m] = String(ym).split("-").map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};
const monthSpan = (a, b) => {
  const [y1, m1] = a.split("-").map(Number);
  const [y2, m2] = b.split("-").map(Number);
  return (y2 - y1) * 12 + (m2 - m1) + 1;
};

// 识别一笔流水属于哪类水电气（名称含关键词 → 类型）；不命中返回 null
// v260908：分类不再硬编码「住房」——规则可绑定任意消费分类，分类匹配下沉到
// ruleForFlow(cat)，由「该类型规则里 category 是否等于流水分类」决定是否计入。
// v2.2.17：规则段按「覆盖账期是否落在规则账期窗口」匹配（见 ruleForFlow / ruleMatchesCov）。
export function matchUtilityType(flow) {
  if (!flow || flow.type !== "expense") return null;
  return kwTypeOf(flow);
}

// 关键词 → 类型（不含分类判断；分类判断在 ruleForFlow 按规则绑定分类精确匹配）
function kwTypeOf(flow) {
  const desc = String(flow.description || "");
  for (const { kw, type } of KW_ORDER) {
    if (desc.includes(kw)) return type;
  }
  return null;
}

// 流水名称里当前用的识别关键词（与 kwTypeOf 一致，用于 SQL LIKE）
function kwOf(type) {
  const hit = KW_ORDER.find((k) => k.type === type);
  return hit ? hit.kw : "";
}

// 规则绑定的分类（默认住房）
function ruleCategory(rule) {
  return String(rule?.category || HOUSE_CAT).trim() || HOUSE_CAT;
}

// 取该类型在 ym（'YYYY-MM'，覆盖首月口径）生效的任一规则（不区分分类，取最新生效段）；
// 手动添加账单（bill_start=覆盖首月）等无流水日上下文时使用
function pickRuleAny(bookId, type, ym) {
  const rows = db
    .prepare(
      `SELECT * FROM utility_rules WHERE book_id=? AND type=?
         AND effective_from <= ? AND (effective_to IS NULL OR effective_to >= ?)
         ORDER BY effective_from DESC LIMIT 1`
    )
    .all(bookId, type, ym, ym);
  return rows[0] || null;
}

// 该 type 是否“存在任意规则”（v2.2.17：不再按月判断——规则删光才算没有；
// 用于判定流水是否因换分类/规则集变更而不再匹配 → 从旧账单摘除）
function hasAnyRule(bookId, type) {
  const r = db
    .prepare("SELECT 1 FROM utility_rules WHERE book_id=? AND type=? LIMIT 1")
    .get(bookId, type);
  return !!r;
}

function parseTiers(rule) {
  try {
    return JSON.parse(rule.tiers_json || "[]");
  } catch {
    return [];
  }
}
function parseSeason(rule) {
  try {
    return rule.season_json ? JSON.parse(rule.season_json) : null;
  } catch {
    return null;
  }
}

// 电费按月份选档：夏季月份用 season 档，其余用 tiers_json 档
function effTiers(rule, ym) {
  const s = parseSeason(rule);
  if (s && s.months && s.months.length) {
    const m = Number(String(ym).split("-")[1]);
    if (s.months.includes(m)) return s.tiers || [];
  }
  return parseTiers(rule);
}

// 正向：用量 → 应缴金额（按用量档 容量×单价 分段求和）
function fwdCharge(usage, tiers) {
  let charge = 0;
  let u = Number(usage) || 0;
  for (const t of tiers) {
    const price = Number(t.price) || 0;
    if (t.cap == null || Number(t.cap) === Infinity) {
      charge += u * price;
      break;
    }
    const take = Math.min(u, Number(t.cap));
    charge += take * price;
    u -= take;
    if (u <= 1e-9) break;
  }
  return round2(charge);
}

// 反向阶梯扣除：金额 → 用量（照搬用户 Excel 公式）
// 水/电：用量档 × 单价；末档 cap=null 表示 ∞
function reverseTiers(amount, tiers) {
  let rem = round2(amount);
  if (rem <= 0) return 0;
  let usage = 0;
  for (let i = 0; i < tiers.length; i++) {
    const t = tiers[i];
    const price = Number(t.price) || 0;
    if (!price) continue;
    if (t.cap == null || Number(t.cap) === Infinity) {
      usage += rem / price;
      break;
    }
    const full = round2(Number(t.cap) * price);
    if (rem <= full + 1e-6) {
      usage += rem / price;
      break;
    }
    usage += Number(t.cap);
    rem = round2(rem - full);
  }
  return round2(usage);
}

// 用量落在第几档（1/2/3）：usage ≤ cap1 → 1；≤ cap1+cap2 → 2；否则 3
function tierOfUsage(usage, tiers) {
  const u = Number(usage) || 0;
  let acc = 0;
  for (let i = 0; i < tiers.length; i++) {
    const t = tiers[i];
    if (t.cap == null || Number(t.cap) === Infinity) return i + 1;
    acc += Number(t.cap);
    if (u <= acc + 1e-6) return i + 1;
  }
  return tiers.length || 1;
}

// 燃气：年累计金额分档（1 档满额 320×3.45=1104，2 档 80×4.14=331.2，3 档 ∞×5.18）
// paidBefore = 本年度此前已缴金额；本次缴 amount → 拆段算本次用量
function gasBreakdown(amount, paidBefore, tiers) {
  let rem = round2(amount);
  if (rem <= 0) return 0;
  let used = Number(paidBefore) || 0;
  let usage = 0;
  const segTop = []; // 各段累计金额上限
  let acc = 0;
  for (const t of tiers) {
    const price = Number(t.price) || 0;
    if (t.cap == null || Number(t.cap) === Infinity) segTop.push(Infinity);
    else {
      acc += round2(Number(t.cap) * price);
      segTop.push(acc);
    }
  }
  for (let i = 0; i < tiers.length; i++) {
    const price = Number(tiers[i].price) || 0;
    if (!price) continue;
    const top = segTop[i];
    if (used >= top) continue; // 本段额度已被以前缴费耗尽
    if (top === Infinity || used + rem <= top + 1e-6) {
      usage += rem / price;
      break;
    }
    usage += (top - used) / price;
    rem = round2(rem - (top - used));
    used = top;
  }
  return round2(usage);
}

// 燃气：年累计缴费金额所在档（1/2/3）
function gasTierByMoney(totalMoney, tiers) {
  let acc = 0;
  for (let i = 0; i < tiers.length; i++) {
    const t = tiers[i];
    if (t.cap == null || Number(t.cap) === Infinity) return i + 1;
    acc += round2(Number(t.cap) * Number(t.price));
    if (Number(totalMoney) <= acc + 1e-6) return i + 1;
  }
  return tiers.length || 1;
}

// 燃气 by_year 年累计口径（v2.2.17 改）：账期末月所在年（bill_end）+ 同规则分类的
// 燃气账单 paid 合计（排除自己）。覆盖区间与缴费月解耦后，1-15 上旬缴的跨年账单
//（2026-01 缴 → 覆盖 2025-11~12）按账期末月 2025-12 计入 2025 年累计，金额跟随
// 实际用量所在年——不再按「缴费自然年」用流水关键词扫（旧口径会把 2026-01 的缴费
// 算进 2026 年累计，与真实用量年错位）。其余账单自身即费用事实，直接读表更稳。
function gasYearOthersOf(bookId, rec, year) {
  let cat = HOUSE_CAT;
  if (rec.rule_id) {
    const rule = db.prepare("SELECT * FROM utility_rules WHERE id=?").get(rec.rule_id);
    if (rule) cat = ruleCategory(rule);
  }
  const rows = db
    .prepare(
      `SELECT ur.id, ur.paid FROM utility_records ur
         JOIN utility_rules rul ON rul.id = ur.rule_id
        WHERE ur.book_id=? AND ur.type='gas' AND rul.category=?
          AND substr(ur.bill_end,1,4)=?`
    )
    .all(bookId, cat, String(year));
  let t = 0;
  for (const row of rows) if (Number(row.id) !== Number(rec.id)) t += Number(row.paid) || 0;
  return round2(t);
}

function flowIdsOf(rec) {
  try {
    const a = JSON.parse(rec.flow_ids || "[]");
    return Array.isArray(a) ? a.map(Number).filter((x) => x > 0) : [];
  } catch {
    return [];
  }
}
function paidOfFlows(bookId, ids) {
  if (!ids.length) return 0;
  const ph = ids.map(() => "?").join(",");
  const r = db
    .prepare(`SELECT COALESCE(SUM(amount),0) t FROM flows WHERE book_id=? AND id IN (${ph})`)
    .get(bookId, ...ids);
  return round2(Number(r.t) || 0);
}

// 真实缴费月 = 关联流水里最早一笔的 flow_time 月（'YYYY-MM'）；
// 队友分拆多笔跨月支付时取首笔（如燃气 8/25 付一笔、9/2 补尾款 → 缴费月 8 月）。
// 无流水（手动添加的账单）→ 退回 bill_start 月（老行为，保持兼容）。
function payMonthOf(bookId, rec) {
  const ids = flowIdsOf(rec);
  if (ids.length) {
    const ph = ids.map(() => "?").join(",");
    const row = db
      .prepare(
        `SELECT MIN(substr(flow_time,1,7)) m FROM flows WHERE book_id=? AND id IN (${ph})`
      )
      .get(bookId, ...ids);
    if (row && row.m) return row.m;
  }
  return String(rec.bill_start || "").slice(0, 7);
}
function recSpan(rec) {
  return monthSpan(rec.bill_start, rec.bill_end);
}
// 覆盖区间行数 = 规则覆盖月数（同一类型账单区间应与规则一致）
function spanOfRule(rule) {
  return Math.max(1, Number(rule?.bill_span) || 1);
}

// =====================================================================
// v2.2.17 显式账期模型（用户 2026-09-11 拍板，取代 v2.2.14 的奇偶月猜块）：
// 规则上写明「出账日窗口 → 覆盖账期」映射 cover_json.windows；流水按自身日号命中
// 唯一窗口 → 得到唯一覆盖区间 bill_start~bill_end，杜绝「一笔流水生成 2 张账单」。
//   水费/燃气：上旬中旬(1-15)缴 → 覆盖 M-2~M-1（上月+上上月）
//              下旬(16-31)缴 → 覆盖 M-1~M（当月+上月）     （M=流水月，两条件互斥）
//   电费：任意日（每月一缴）→ 覆盖 M-1（上月，单月）
//   物业：季度缴 → 缴费月所在自然季度（季内任一天都归该季）
// 规则 effective_from/effective_to 语义改为「起始账期/结束账期」（首个/末个被覆盖月份）：
// 匹配对象是账单覆盖区间而非流水月——水费选 2024-02 起 → 首期覆盖 2024-02~03、
// 首笔流水 2024-03 下旬；电费选 2024-02 起 → 首期用量 2024-02、首笔流水 2024-03。
// cover_json 结构：{ "windows": [ {from,to,start,span,quarter?}, ... ] }
//   from/to = 流水日号窗口（含，需划分 1~31 且互斥，一天只命中一个）；
//   start   = 覆盖起始月偏移（0=当月，-1=上月，-2=上上月）；
//   span    = 覆盖月数；quarter=true（物业季度）时忽略 start，直接取缴费月所在自然季度。
// =====================================================================
function defaultCover(type, span) {
  const sp = Math.max(1, Number(span) || 1);
  if (type === "electric") return { windows: [{ from: 1, to: 31, start: -1, span: 1 }] };
  if (type === "water" || type === "gas") {
    return {
      windows: [
        { from: 1, to: 15, start: -2, span: 2 },
        { from: 16, to: 31, start: -1, span: 2 },
      ],
    };
  }
  // property：季度缴 = 缴费月所在自然季度；span<=1 = 缴当月
  if (sp <= 1) return { windows: [{ from: 1, to: 31, start: 0, span: 1 }] };
  if (sp === 3) return { windows: [{ from: 1, to: 31, start: 0, span: 3, quarter: true }] };
  return { windows: [{ from: 1, to: 31, start: 0, span: sp }] };
}
function parseCover(rule) {
  if (rule && rule.cover_json) {
    try {
      const o = JSON.parse(rule.cover_json);
      if (o && Array.isArray(o.windows) && o.windows.length) return o;
    } catch {
      /* 损坏则退回默认 */
    }
  }
  return defaultCover(rule?.type, rule?.bill_span);
}
// 流水（ym='YYYY-MM'，day=日号）→ 该规则出账窗口命中的覆盖区间；无命中窗口返回 null
function coverageOfRule(rule, ym, day) {
  if (!/^\d{4}-\d{2}$/.test(String(ym || ""))) return null;
  const cover = parseCover(rule);
  const m = Number(String(ym).split("-")[1]);
  const d = Number(day) || 1;
  const win = (cover.windows || []).find(
    (w) => d >= (Number(w.from) || 1) && d <= (Number(w.to) || 31)
  );
  if (!win) return null;
  const span = Math.max(1, Number(win.span) || Number(rule?.bill_span) || 1);
  if (win.quarter) {
    const back = (m - 1) % 3; // 回退到自然季度首月（0/1/2）
    const start = ymAdd(ym, -back);
    return { start, end: ymAdd(start, span - 1) };
  }
  const start = ymAdd(ym, Number(win.start) || 0);
  return { start, end: ymAdd(start, span - 1) };
}
// 规则是否覆盖该账单区间：EF=起始账期 <= 覆盖首月；ET=结束账期（如有）>= 覆盖末月
function ruleMatchesCov(rule, cov) {
  const ef = String(rule?.effective_from || "").slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(ef)) return false;
  if (String(cov?.start || "").slice(0, 7) < ef) return false;
  const et = rule.effective_to ? String(rule.effective_to).slice(0, 7) : null;
  if (et && String(cov?.end || "").slice(0, 7) > et) return false;
  return true;
}
// 流水 → 命中规则：按「出账窗口→账期」逐个候选（分类精确匹配，最新生效段优先）
function ruleForFlow(bookId, type, ym, day, cat) {
  const c = String(cat || "").trim() || HOUSE_CAT;
  const rules = db
    .prepare(
      `SELECT * FROM utility_rules WHERE book_id=? AND type=? AND category=?
         ORDER BY effective_from DESC`
    )
    .all(bookId, type, c);
  for (const rule of rules) {
    const cov = coverageOfRule(rule, ym, day);
    if (!cov) continue;
    if (!ruleMatchesCov(rule, cov)) continue;
    return { rule, cov };
  }
  return { rule: null, cov: null };
}
// 按覆盖区间找生效规则（不限分类）——手动补账单 / 规则被删后重算的兜底
function ruleForSpanAny(bookId, type, bStart, bEnd) {
  const rules = db
    .prepare(
      `SELECT * FROM utility_rules WHERE book_id=? AND type=?
         ORDER BY effective_from DESC`
    )
    .all(bookId, type);
  for (const rule of rules) {
    const cov = { start: String(bStart || "").slice(0, 7), end: String(bEnd || "").slice(0, 7) };
    if (!/^\d{4}-\d{2}$/.test(cov.start)) continue;
    if (!ruleMatchesCov(rule, cov)) continue;
    return rule;
  }
  return null;
}

// ⚠️ 以下 alignBillBlock 仅保留给已发布的 v2.2.14 存量校准 migrateUtilityAlignV1 使用
//（老库早已打过标不会再跑；全新库无 auto 账单可对齐，无副作用）。
// 新账期一律走上面的 cover_json 机制，不再用奇偶月猜块。
function alignBillBlock(type, ym, rule) {
  const span = spanOfRule(rule);
  const m = Number(String(ym || "").split("-")[1]);
  if (!m) return { start: ym, end: ym };
  if (span <= 1) return { start: ym, end: ym };
  if (span === 3) {
    const back = (m - 1) % 3; // 回退到自然季度首月（0/1/2）
    const start = ymAdd(ym, -back);
    return { start, end: ymAdd(start, 2) };
  }
  if (type === "gas") {
    // 燃气：块末 = 缴月前最近奇数月（偶数缴→缴月-1；奇数迟缴→缴月-2）
    const end = ymAdd(ym, m % 2 === 0 ? -1 : -2);
    return { start: ymAdd(end, -1), end };
  }
  // 水费：块末 = 缴月（奇数出账月）；偶数迟缴 → 前一块（末=缴月-1）
  const end = ymAdd(ym, m % 2 === 1 ? 0 : -1);
  return { start: ymAdd(end, -1), end };
}

// 重算一张账单（paid 汇总 + 反推用量/档位/应缴 + 状态）
// force=true：用户主动校正（补优惠/改用量）时即使 usage_locked 也重算用量与 charge；
// force=false（自动合并路径）：usage_locked 的账单只更新 paid，不覆盖用户手改的量/价。
function recomputeRecord(bookId, rec, rule, force) {
  // 规则被删除后账单仍要可重算：兜底按「覆盖区间」取该类型最新生效段（可能仍为 null）
  if (!rule) rule = ruleForSpanAny(bookId, rec.type, rec.bill_start, rec.bill_end);
  const ids = flowIdsOf(rec);
  const paid = paidOfFlows(bookId, ids);
  const discount = Number(rec.discount) || 0;
  const locked = Number(rec.usage_locked) === 1 && !force;

  if (locked) {
    db.prepare(
      `UPDATE utility_records SET paid=?, updated_at=datetime('now','localtime') WHERE id=?`
    ).run(paid, rec.id);
    return rec;
  }

  let usageTotal = null;
  let tier = 1;
  let charge = 0;
  let status = rec.status === "manual" ? "manual" : "";

  if (rec.type === "property") {
    // 物业：无用量/档位概念，charge = 月费 × 覆盖月数
    const monthly = Number(rule?.monthly_fee) || parseTiers(rule)[0]?.price || 0;
    charge = round2(monthly * recSpan(rec));
    tier = 1;
    usageTotal = null;
  } else if (rule?.cycle_type === "by_year") {
    // 燃气：年累计按「账期末月所在年」（v2.2.17，金额跟随实际用量年——1-15 上旬缴
    // 的跨年账单如 2026-01 缴 → 覆盖 2025-11~12，按 2025 累计；16-31 下旬缴同月账期，
    // 无跨年）。paidBefore = 同年同分类其它账单 paid 合计（不含本单）。
    const year = Number(String(rec.bill_end || rec.bill_start).slice(0, 4));
    const paidBefore = gasYearOthersOf(bookId, rec, year);
    const tiers = parseTiers(rule);
    usageTotal = gasBreakdown(round2(paid + discount), paidBefore, tiers);
    // 本期用量不再二次正向验算（反推按年累计扣出，天然自洽）；charge 取实付+优惠
    charge = round2(paid + discount);
    tier = gasTierByMoney(round2(paidBefore + paid + discount), tiers);
  } else {
    // 水/电：反向阶梯 + 正向验算
    const tiers = effTiers(rule, rec.bill_start);
    usageTotal = reverseTiers(round2(paid + discount), tiers);
    charge = fwdCharge(usageTotal, tiers);
    tier = tierOfUsage(usageTotal, tiers);
  }

  if (!status) {
    const diff = round2(charge - (paid + discount));
    status = Math.abs(diff) > 0.02
      ? "pending"
      : Number(rec.discount || 0) > 0 || Number(rec.usage_locked) === 1
        ? "corrected"
        : "auto";
  }

  db.prepare(
    `UPDATE utility_records SET usage_total=?, tier_level=?, charge=?, paid=?, status=?,
            rule_id=?, updated_at=datetime('now','localtime') WHERE id=?`
  ).run(usageTotal, tier, charge, paid, status, rule?.id ?? rec.rule_id ?? null, rec.id);
  return { ...rec, usage_total: usageTotal, tier_level: tier, charge, paid, status };
}

// 幂等生成：按流水当前值重建/并入账单。
// 编辑（改名/改金额/改时间/换分类）后再次调用即可自动纠正旧账单。
// v2.2.17：覆盖区间由规则「出账窗口→账期」（cover_json）按流水日号推导，不再奇偶猜块；
// 规则匹配 = 覆盖区间落在规则账期窗口（EF=起始账期 ≤ 覆盖首月，ET=结束账期 ≥ 覆盖末月）。
// opts.preserveOnNoRule=true（扫描历史）：流水不再匹配任何规则时保留原账单，防误删存量。
export function utilitySyncFlowById(bookId, flowId, opts = {}) {
  const preserveOnNoRule = !!opts.preserveOnNoRule;
  const flow = db
    .prepare("SELECT * FROM flows WHERE id=? AND book_id=?")
    .get(flowId, bookId);
  if (!flow) return;
  // 先摘除旧关联（改名/换分类/改时间后自动纠正旧账单；KW 不命中的流水必须摘除）
  const type = kwTypeOf(flow);
  const ym = String(flow.flow_time || "").slice(0, 7);
  if (!type || !/^\d{4}-\d{2}$/.test(ym)) {
    utilityRemoveFlowById(bookId, flowId);
    return;
  }
  const day = Number(String(flow.flow_time || "").slice(8, 10)) || 1;
  const { rule, cov } = ruleForFlow(bookId, type, ym, day, flow.category);
  if (!rule) {
    // 规则起始账期之前 / 该分类没有规则 / 出账窗口未命中 → 不计入。
    // 若该类型仍存在其它规则（说明用户把这笔记到了别的分类，编辑触发时从旧账单摘除）；
    // scan 场景保留原账单（幂等保底，防误删存量）。
    if (!preserveOnNoRule && hasAnyRule(bookId, type)) {
      utilityRemoveFlowById(bookId, flowId);
    }
    return;
  }
  const bStart = cov.start;
  const bEnd = cov.end;

  // 先处理该流水当前所在的历史账单：
  //  - 同覆盖区间 → 保留为目标账单（队友分拆支付并入同一张）；
  //  - 区间不同且引擎账单（auto/pending）→ 摘除（归属强制纠正，v2.2.17 根修：老引擎
  //    把区间摆错位后只 append 不纠正 → 双月账单一月多一月少）；
  //  - 区间不同但 manual/corrected → 尊重用户校正：流水留在该账单，不再新建自动账单。
  const holders = db
    .prepare("SELECT * FROM utility_records WHERE book_id=? AND type=?")
    .all(bookId, type)
    .filter((x) => flowIdsOf(x).includes(Number(flowId)));
  let target = null;
  for (const h of holders) {
    if (
      String(h.bill_start).slice(0, 7) === bStart &&
      String(h.bill_end).slice(0, 7) === bEnd
    ) {
      target = h;
      continue;
    }
    if (h.status === "auto" || h.status === "pending") {
      const ids = flowIdsOf(h).filter((x) => x !== Number(flowId));
      if (!ids.length) {
        db.prepare("DELETE FROM utility_records WHERE id=?").run(h.id);
      } else {
        db.prepare(
          `UPDATE utility_records SET flow_ids=?, updated_at=datetime('now','localtime') WHERE id=?`
        ).run(JSON.stringify(ids), h.id);
        recomputeRecord(bookId, { ...h, flow_ids: JSON.stringify(ids) }, rule, false);
      }
    } else {
      // manual/corrected：该账单归用户所有，归属不动；仅刷新 paid 后返回，避免复制一张
      recomputeRecord(bookId, h, rule, false);
      return;
    }
  }
  if (target) {
    const ids = flowIdsOf(target);
    if (!ids.includes(Number(flowId))) ids.push(Number(flowId));
    db.prepare(
      `UPDATE utility_records SET flow_ids=?, updated_at=datetime('now','localtime') WHERE id=?`
    ).run(JSON.stringify(ids), target.id);
    target = { ...target, flow_ids: JSON.stringify(ids) };
  } else {
    const exists = db
      .prepare(
        `SELECT * FROM utility_records WHERE book_id=? AND type=? AND bill_start=? AND bill_end=?`
      )
      .get(bookId, type, bStart, bEnd);
    if (exists) {
      const ids = flowIdsOf(exists);
      if (!ids.includes(Number(flowId))) ids.push(Number(flowId));
      db.prepare(
        `UPDATE utility_records SET flow_ids=?, updated_at=datetime('now','localtime') WHERE id=?`
      ).run(JSON.stringify(ids), exists.id);
      target = { ...exists, flow_ids: JSON.stringify(ids) };
    } else {
      const info = db
        .prepare(
          `INSERT INTO utility_records (book_id,type,rule_id,bill_start,bill_end,flow_ids,paid,status)
           VALUES (?,?,?,?,?,?,0,'auto')`
        )
        .run(bookId, type, rule.id, bStart, bEnd, JSON.stringify([Number(flowId)]));
      target = db.prepare("SELECT * FROM utility_records WHERE id=?").get(info.lastInsertRowid);
    }
  }
  recomputeRecord(bookId, target, rule, false);
}

// 流水删除/失效时从所有账单解绑；账单空则删除，否则重算
export function utilityRemoveFlowById(bookId, flowId) {
  const recs = db
    .prepare("SELECT * FROM utility_records WHERE book_id=?")
    .all(bookId);
  for (const rec of recs) {
    const ids = flowIdsOf(rec).filter((x) => x !== Number(flowId));
    if (ids.length === flowIdsOf(rec).length) continue;
    if (!ids.length) {
      db.prepare("DELETE FROM utility_records WHERE id=?").run(rec.id);
      continue;
    }
    db.prepare(
      `UPDATE utility_records SET flow_ids=?, updated_at=datetime('now','localtime') WHERE id=?`
    ).run(JSON.stringify(ids), rec.id);
    const rule = rec.rule_id
      ? db.prepare("SELECT * FROM utility_rules WHERE id=?").get(rec.rule_id)
      : null;
    recomputeRecord(bookId, { ...rec, flow_ids: JSON.stringify(ids) }, rule, false);
  }
}

// 手动删账本里某规则关联的所有账单用（规则删除时保留记录，不自动删）
function flowSummaryOf(bookId, ids) {
  if (!ids.length) return [];
  const ph = ids.map(() => "?").join(",");
  return db
    .prepare(
      `SELECT id, flow_time, amount, description, payment_method
         FROM flows WHERE book_id=? AND id IN (${ph}) ORDER BY flow_time`
    )
    .all(bookId, ...ids);
}

function decorate(bookId, rec) {
  const ids = flowIdsOf(rec);
  const flows = flowSummaryOf(bookId, ids);
  return { ...rec, flow_ids: ids, flows };
}
function decorateRule(rule) {
  return {
    ...rule,
    tiers: parseTiers(rule),
    season: parseSeason(rule),
    cover: parseCover(rule), // v2.2.17 显式账期；老规则无 cover_json → 按类型默认语义
  };
}

// 校验/规整前端提交的 cover（缺省/非法 → 该类型默认账期语义）
function normCoverInput(type, cover, span) {
  if (cover && Array.isArray(cover.windows) && cover.windows.length) {
    const wins = [];
    for (const w of cover.windows) {
      const from = Number(w.from);
      const to = Number(w.to);
      const start = Number(w.start);
      const spanW = Math.max(1, Number(w.span) || 1);
      if (!(from >= 1 && to >= from && to <= 31)) return null;
      if (spanW > 36) return null;
      wins.push({
        from,
        to,
        start: Number.isFinite(start) ? start : 0,
        span: spanW,
        ...(w.quarter ? { quarter: true } : {}),
      });
    }
    return { windows: wins };
  }
  return defaultCover(type, span);
}

const r = Router();
r.use(auth);

// ---------------- 规则 CRUD ----------------
r.get(
  "/rules",
  requireBook,
  wrap((req, res) => {
    const list = db
      .prepare("SELECT * FROM utility_rules WHERE book_id=? ORDER BY type, effective_from")
      .all(req.bookId)
      .map(decorateRule);
    res.json({ list });
  })
);

r.post(
  "/rules",
  requireBook,
  wrap((req, res) => {
    const b = req.body || {};
    const type = String(b.type || "");
    if (!UTILITY_TYPES.includes(type))
      return res.status(400).json({ error: "类型不正确" });
    if (!/^\d{4}-\d{2}$/.test(String(b.effective_from || "")))
      return res.status(400).json({ error: "起始账期格式应为 YYYY-MM" });
    if (b.effective_to && !/^\d{4}-\d{2}$/.test(String(b.effective_to)))
      return res.status(400).json({ error: "结束账期格式应为 YYYY-MM" });
    const tiers = Array.isArray(b.tiers) && b.tiers.length ? b.tiers : null;
    if (!tiers) return res.status(400).json({ error: "至少需要一个档位" });
    const span = Math.max(1, Number(b.bill_span) || 1);
    // v260908：规则可绑定任意消费分类（识别口径=规则分类+名称关键词）；默认住房
    const category = String(b.category || "").trim() || HOUSE_CAT;
    // v2.2.17：出账窗口→覆盖账期显式配置（缺省按类型默认）
    const cover = normCoverInput(type, b.cover, span);
    if (!cover) return res.status(400).json({ error: "出账窗口配置不正确" });
    const info = db
      .prepare(
        `INSERT INTO utility_rules
           (book_id,type,name,category,effective_from,effective_to,bill_span,cycle_type,unit,tiers_json,season_json,monthly_fee,cover_json,remark)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        req.bookId,
        type,
        String(b.name || TYPE_LABEL[type] || ""),
        category,
        b.effective_from,
        b.effective_to || null,
        span,
        String(b.cycle_type || "by_span"),
        String(b.unit || "m3"),
        JSON.stringify(tiers),
        b.season ? JSON.stringify(b.season) : null,
        b.monthly_fee ? Number(b.monthly_fee) : null,
        JSON.stringify(cover),
        String(b.remark || "")
      );
    res.json({ id: Number(info.lastInsertRowid) });
  })
);

r.put(
  "/rules/:id",
  requireBook,
  wrap((req, res) => {
    const cur = db
      .prepare("SELECT * FROM utility_rules WHERE id=? AND book_id=?")
      .get(req.params.id, req.bookId);
    if (!cur) return res.status(404).json({ error: "规则不存在" });
    const b = req.body || {};
    if (b.effective_from !== undefined && !/^\d{4}-\d{2}$/.test(String(b.effective_from)))
      return res.status(400).json({ error: "起始账期格式应为 YYYY-MM" });
    if (b.effective_to !== undefined && b.effective_to && !/^\d{4}-\d{2}$/.test(String(b.effective_to)))
      return res.status(400).json({ error: "结束账期格式应为 YYYY-MM" });
    const tiers = b.tiers !== undefined ? (Array.isArray(b.tiers) && b.tiers.length ? b.tiers : null) : null;
    if (b.tiers !== undefined && !tiers) return res.status(400).json({ error: "至少需要一个档位" });
    const nextSpan = Math.max(1, Number(b.bill_span ?? cur.bill_span) || 1);
    // v2.2.17：cover 显式传入才覆盖（null/缺省保留原值；想重置默认可传 {windows: []}）
    const cover =
      b.cover !== undefined ? normCoverInput(cur.type, b.cover, nextSpan) : null;
    if (b.cover !== undefined && !cover)
      return res.status(400).json({ error: "出账窗口配置不正确" });
    db.prepare(
      `UPDATE utility_rules SET name=?, category=?, effective_from=?, effective_to=?, bill_span=?,
              cycle_type=?, unit=?, tiers_json=?, season_json=?, monthly_fee=?, cover_json=?, remark=?,
              updated_at=datetime('now','localtime') WHERE id=?`
    ).run(
      b.name !== undefined ? String(b.name) : cur.name,
      b.category !== undefined ? (String(b.category).trim() || HOUSE_CAT) : ruleCategory(cur),
      b.effective_from !== undefined ? b.effective_from : cur.effective_from,
      b.effective_to !== undefined ? (b.effective_to || null) : cur.effective_to,
      nextSpan,
      b.cycle_type !== undefined ? String(b.cycle_type) : cur.cycle_type,
      b.unit !== undefined ? String(b.unit) : cur.unit,
      tiers ? JSON.stringify(tiers) : cur.tiers_json,
      b.season !== undefined ? (b.season ? JSON.stringify(b.season) : null) : cur.season_json,
      b.monthly_fee !== undefined ? (b.monthly_fee ? Number(b.monthly_fee) : null) : cur.monthly_fee,
      b.cover !== undefined ? JSON.stringify(cover) : cur.cover_json,
      b.remark !== undefined ? String(b.remark) : cur.remark,
      cur.id
    );
    res.json({ ok: true });
  })
);

r.delete(
  "/rules/:id",
  requireBook,
  wrap((req, res) => {
    db.prepare("DELETE FROM utility_rules WHERE id=? AND book_id=?").run(req.params.id, req.bookId);
    res.json({ ok: true });
  })
);

// ---------------- 账单记录 ----------------
r.get(
  "/records",
  requireBook,
  wrap((req, res) => {
    const type = String(req.query.type || "");
    const year = String(req.query.year || "");
    const status = String(req.query.status || "");
    const sql = [];
    const args = [req.bookId];
    if (type && UTILITY_TYPES.includes(type)) {
      sql.push("type=?");
      args.push(type);
    }
    if (/^\d{4}$/.test(year)) {
      sql.push("(substr(bill_start,1,4)=? OR substr(bill_end,1,4)=? OR (bill_start<=? AND bill_end>=?))");
      args.push(year, year, `${year}-12`, `${year}-01`);
    }
    if (status) {
      sql.push("status=?");
      args.push(status);
    }
    const list = db
      .prepare(
        `SELECT * FROM utility_records WHERE book_id=?${sql.length ? " AND " + sql.join(" AND ") : ""}
          ORDER BY bill_start DESC, id DESC`
      )
      .all(...args)
      .map((x) => decorate(req.bookId, x));
    res.json({ list });
  })
);

// 手动添加账单（用户：平时全自动，想手动补一条时用）
r.post(
  "/records",
  requireBook,
  wrap((req, res) => {
    const b = req.body || {};
    const type = String(b.type || "");
    if (!UTILITY_TYPES.includes(type)) return res.status(400).json({ error: "类型不正确" });
    if (!/^\d{4}-\d{2}$/.test(String(b.bill_start || "")))
      return res.status(400).json({ error: "起始月份格式应为 YYYY-MM" });
    const billEnd = String(b.bill_end || b.bill_start);
    if (!/^\d{4}-\d{2}$/.test(billEnd)) return res.status(400).json({ error: "结束月份格式应为 YYYY-MM" });
    if (billEnd < b.bill_start) return res.status(400).json({ error: "结束月份不能早于起始月份" });

    let flowId = null;
    if (b.flow_id) {
      const f = db
        .prepare("SELECT * FROM flows WHERE id=? AND book_id=?")
        .get(Number(b.flow_id), req.bookId);
      if (!f) return res.status(400).json({ error: "关联流水不存在" });
      flowId = Number(b.flow_id);
      utilityRemoveFlowById(req.bookId, flowId); // 防同一笔挂在多张账单
    }
    const ids = flowId ? [flowId] : [];
    const paid = b.paid !== undefined && b.paid !== "" ? round2(Number(b.paid)) : paidOfFlows(req.bookId, ids);
    const rule = pickRuleAny(req.bookId, type, b.bill_start);
    const usage = b.usage !== undefined && b.usage !== "" ? round2(Number(b.usage)) : null;
    const info = db
      .prepare(
        `INSERT INTO utility_records
           (book_id,type,rule_id,bill_start,bill_end,usage_total,tier_level,charge,discount,paid,flow_ids,usage_locked,status,remark)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        req.bookId,
        type,
        rule?.id ?? null,
        b.bill_start,
        billEnd,
        usage,
        usage != null ? 1 : 1,
        0,
        round2(Number(b.discount) || 0),
        paid,
        JSON.stringify(ids),
        usage != null ? 1 : 0,
        "manual",
        String(b.remark || "")
      );
    let rec = db.prepare("SELECT * FROM utility_records WHERE id=?").get(info.lastInsertRowid);
    if (usage == null) rec = recomputeRecord(req.bookId, rec, rule, true);
    res.json({ id: Number(info.lastInsertRowid) });
  })
);

// 校正账单：补优惠金额 / 改用量 / 改覆盖区间（用户手动介入后自动引擎不再覆盖）
r.put(
  "/records/:id",
  requireBook,
  wrap((req, res) => {
    const cur = db
      .prepare("SELECT * FROM utility_records WHERE id=? AND book_id=?")
      .get(req.params.id, req.bookId);
    if (!cur) return res.status(404).json({ error: "账单不存在" });
    const b = req.body || {};
    const discount = b.discount !== undefined ? round2(Number(b.discount) || 0) : Number(cur.discount) || 0;
    const usage = b.usage !== undefined && b.usage !== "" ? round2(Number(b.usage)) : cur.usage_total;
    const usageChanged = b.usage !== undefined && b.usage !== "";
    const locked = discount !== (Number(cur.discount) || 0) || usageChanged ? 1 : Number(cur.usage_locked) || 0;

    db.prepare(
      `UPDATE utility_records SET bill_start=?, bill_end=?, discount=?, usage_total=?,
              usage_locked=?, updated_at=datetime('now','localtime') WHERE id=?`
    ).run(
      b.bill_start || cur.bill_start,
      b.bill_end || cur.bill_end,
      discount,
      usageChanged ? usage : cur.usage_total,
      locked,
      cur.id
    );
    let rec = db.prepare("SELECT * FROM utility_records WHERE id=?").get(cur.id);
    const rule = rec.rule_id
      ? db.prepare("SELECT * FROM utility_rules WHERE id=?").get(rec.rule_id)
      : pickRuleAny(req.bookId, rec.type, rec.bill_start);
    // 用户校正后 status 语义：手动改过用量/补过优惠 → corrected（金额仍对不上则 pending）
    if (usageChanged || discount !== (Number(cur.discount) || 0)) {
      rec = recomputeRecord(req.bookId, rec, rule, true);
      const diff = round2(Number(rec.charge || 0) - (Number(rec.paid || 0) + discount));
      const finalStatus =
        rec.status === "manual" ? "manual" : Math.abs(diff) > 0.02 ? "pending" : "corrected";
      db.prepare("UPDATE utility_records SET status=? WHERE id=?").run(finalStatus, cur.id);
    }
    res.json({ ok: true });
  })
);

r.delete(
  "/records/:id",
  requireBook,
  wrap((req, res) => {
    db.prepare("DELETE FROM utility_records WHERE id=? AND book_id=?").run(req.params.id, req.bookId);
    res.json({ ok: true });
  })
);

// ---------------- 存量流水扫描（配置规则后回填；幂等） ----------------
// v260908：按「每条规则绑定的分类 + 名称关键词」扫描各自生效后的流水；
// preserveOnNoRule=true → 已存在于旧账单但不再匹配任何规则的流水保留原账单（防误删存量）。
r.post(
  "/scan",
  requireBook,
  wrap((req, res) => {
    const only = String(req.body?.type || "");
    const types = only && UTILITY_TYPES.includes(only) ? [only] : UTILITY_TYPES;
    const counts = {};
    for (const type of types) {
      const kw = kwOf(type);
      const rules = db
        .prepare(
          "SELECT * FROM utility_rules WHERE book_id=? AND type=? ORDER BY effective_from"
        )
        .all(req.bookId, type);
      if (!rules.length) {
        counts[type] = 0;
        continue;
      }
      const seen = new Set();
      for (const rule of rules) {
        const cat = ruleCategory(rule);
        const flows = db
          .prepare(
            `SELECT id FROM flows WHERE book_id=? AND type='expense' AND category=?
               AND description LIKE ? AND flow_time >= ?`
          )
          .all(req.bookId, cat, `%${kw}%`, `${rule.effective_from}-01 00:00:00`);
        for (const f of flows) {
          if (seen.has(f.id)) continue; // 同一笔被多段规则同时扫到只处理一次
          seen.add(f.id);
          utilitySyncFlowById(req.bookId, f.id, { preserveOnNoRule: true });
        }
      }
      counts[type] = seen.size;
    }
    res.json({ counts });
  })
);

// 物业应收月费（中间列/趋势图均摊值，v2.2.16）：
// 物业费每月固定 → 中间列按「规则 monthly_fee」逐月展示应收（用户明确：就按 82 平摊）；
// 支付有优惠时实付 < 应收，优惠只体现在右列实付，月费列不变。
// 规则缺失/无 monthly_fee 的旧账单退回 charge/span（应缴均摊），再退回 paid/span，
// 保证历史数据不出现 0。
function propertyFeeOf(bookId, rec, span, paid) {
  const rule = rec.rule_id
    ? db.prepare("SELECT * FROM utility_rules WHERE id=?").get(rec.rule_id)
    : null;
  const monthly = Number(rule?.monthly_fee) || 0;
  if (monthly > 0) return monthly;
  const charge = Number(rec.charge) || 0;
  if (charge > 0 && span > 0) return round2(charge / span);
  return span > 0 ? round2(paid / span) : 0;
}

// ---------------- 月度视图（按月看：某年 12 个月） ----------------
// v2.2.17 语义（用户 2026-09-11 拍板，账单区间=显式覆盖账期，与缴费月彻底解耦）：
//  - 用量归「覆盖月」：avgU = Math.round(totalU/span)，所有覆盖月都 +avgU
//    （双月完全一致，余数不补偿；视觉一致优先，月度 Σusage 可能 ±1 个单位）。
//  - 金额（右列）整额放「账期末月」= bill_end（覆盖区间的最后一个月，v2.2.17 改：
//    不再放缴费月）。电费单月账期 → 金额=用量月；水/气双月 → 放账期末月（如 3/24 缴
//    覆盖 2~3 月 → 放 3 月）；物业季度 → 放季末月 3/6/9/12。
//  - amountAvg（中间列/趋势图）：水/电/气 = paid/span（均摊到覆盖月）；物业 = 规则
//    月费（应收固定 82/月，与实付优惠解耦——支付打折只体现在右列实付，杜绝错位合并
//    账单 paid 虚高 → 均摊虚高 492/3=164）。
//  - 覆盖区间直接存库（bill_start~bill_end），无需展示层前移 hack（撤 v2.2.16 电费
//    ±1 月 SQL 窗口放宽——老 hack 是为“账单存缴费月”兜底，新引擎账单已存真实账期）。
function computeMonths(bookId, type, year) {
  // v2.2.13 字典序坑：bill_start/bill_end 存 7 位 'YYYY-MM'（如 '2025-01'），
  // 若比较参数用 10 位 'YYYY-MM-DD'，'2025-01' < '2025-01-01' → 每年 1 月账单被滤掉。
  // 统一用 substr(1,7) 在 SQL 侧归一化，兼容库内 7/10 位两种存量。
  const yStart = `${year}-01`;
  const yEnd = `${year}-12`;
  // v2.2.17：账期起点的规则段可能年中才生效（如起始账期 2025-06）——年初无生效段时
  // 再试年末，保证该年视图能取到规则单位/计费周期（7 位 YYYY-MM，规避 10 位字典序坑）
  const activeRule =
    pickRuleAny(bookId, type, `${year}-01`) || pickRuleAny(bookId, type, `${year}-12`);
  const isProperty = type === "property";

  const months = Array.from({ length: 12 }, (_, i) => ({
    month: i + 1,
    ym: `${year}-${String(i + 1).padStart(2, "0")}`,
    usage: 0,
    amount: 0,
    amountAvg: 0, // 中间列/趋势图用：物业=规则月费，水/电/气=paid/span
    tier: 0,
    hasBill: false,
    note: "",
    ruleUnit: activeRule?.unit || null,
    cycleType: activeRule?.cycle_type || null,
  }));
  const recs = db
    .prepare(
      `SELECT * FROM utility_records WHERE book_id=? AND type=?
         AND substr(bill_start,1,7)<=? AND substr(bill_end,1,7)>=?
       ORDER BY bill_start`
    )
    .all(bookId, type, yEnd, yStart);
  for (const rec of recs) {
    const span = recSpan(rec);
    const totalU = Number(rec.usage_total) || 0;
    const avgU = Math.round(totalU / span);
    const paid = round2(Number(rec.paid) || 0);
    // v2.2.17：规则起始账期过滤（EF <= 覆盖首月才计入；EF=2024-02 → 覆盖 2024-01 起
    // 的账单不计）。覆盖区间已由 sync 保证不会跨过 EF，此处兜底 legacy/手动异常区间。
    // 字典序 7 位比较（YYYY-MM vs YYYY-MM）安全，规避 v2.2.12 7 位/10 位字典序 BUG。
    if (rec.rule_id) {
      const r = db.prepare("SELECT effective_from FROM utility_rules WHERE id=?").get(rec.rule_id);
      const ef = String(r?.effective_from || "").slice(0, 7);
      const bs = String(rec.bill_start || "").slice(0, 7);
      if (ef && bs && bs < ef) continue;
    }
    const [sY, sM] = String(rec.bill_start).split("-").map(Number);
    const [eY, eM] = String(rec.bill_end).split("-").map(Number);
    // 本账单覆盖的月份集合（仅取与查询年相交部分）
    const mList = [];
    let cy = sY, cm = sM;
    while (cy < eY || (cy === eY && cm <= eM)) {
      if (cy === year) mList.push(cm);
      cm += 1;
      if (cm > 12) { cm = 1; cy += 1; }
      if (mList.length > 48) break;
    }
    // 覆盖月每日均摊（v2.2.13 视觉一致优先）；物业中间列=规则月费（应收），其余=paid/span
    const avgFee = isProperty
      ? propertyFeeOf(bookId, rec, span, paid)
      : round2(paid / span);
    for (const m of mList) {
      const row = months[m - 1];
      row.hasBill = true;
      row.tier = Math.max(row.tier, Number(rec.tier_level) || 1);
      row.usage += avgU;
      row.amountAvg = round2(row.amountAvg + avgFee);
      // v2.2.17：金额整额放账期末月（bill_end 所在月；跨年账单只在账期末月所在年出现，
      // 例如覆盖 2025-12~2026-01 → 金额在 2026-01，2025 视图只有 12 月用量没有金额）
      if (eY === year && m === eM) {
        row.amount = round2(row.amount + paid);
      }
      if (rec.status === "pending") row.note = "待校正";
    }
  }
  return months;
}

// ---------------- 月度视图（按月看：某年 12 个月） ----------------
r.get(
  "/months",
  requireBook,
  wrap((req, res) => {
    const type = String(req.query.type || "");
    const year = Number(req.query.year) || new Date().getFullYear();
    res.json({ year, months: computeMonths(req.bookId, type, year) });
  })
);

// ---------------- 年度视图（按年看：每年一行汇总 + 高亮取该年最高档） ----------------
r.get(
  "/years",
  requireBook,
  wrap((req, res) => {
    const type = String(req.query.type || "");
    // 1. 有账单覆盖的年份（跨年账单两端年份都算）
    const recs = db
      .prepare(
        `SELECT bill_start, bill_end FROM utility_records WHERE book_id=?
           AND (type=? OR ?='')`
      )
      .all(req.bookId, type, type);
    const yearSet = new Set();
    for (const rec of recs) {
      const [sY, sM] = String(rec.bill_start).split("-").map(Number);
      const [eY, eM] = String(rec.bill_end).split("-").map(Number);
      let cy = sY, cm = sM;
      let guard = 0;
      while (cy < eY || (cy === eY && cm <= eM)) {
        yearSet.add(cy);
        cm += 1;
        if (cm > 12) { cm = 1; cy += 1; }
        if (++guard > 120) break;
      }
    }
    // 2. 加上「规则覆盖的年份」—— 即使该年没账单也要显示（生效范围预览）
    //    to=null 表示 ∞，按当前年算（避免历史/未来过远年份都被包含）
    const today = new Date();
    const thisYear = today.getFullYear();
    const thisMonth = `${thisYear}-${String(today.getMonth() + 1).padStart(2, "0")}`;
    const rules = db
      .prepare(`SELECT effective_from, effective_to FROM utility_rules WHERE book_id=? AND type=?`)
      .all(req.bookId, type);
    let minRuleYear = Infinity;
    for (const r of rules) {
      const t = r.effective_to || `${thisYear}-12`;
      const fY = Number(r.effective_from.slice(0, 4));
      if (fY < minRuleYear) minRuleYear = fY;
      const tY = Number(t.slice(0, 4));
      for (let y = fY; y <= tY; y++) yearSet.add(y);
    }
    // 3. 规则起点前的年份不可切换（用户 2026-09-10 语义：规则没涉及的年份不显示，
    //    例：规则 2025-05 起 → 2024 及之前不下发）。无规则时退回老行为（有账单即可见）。
    const yearsAll = [...yearSet].filter((y) => {
      if (!rules.length) return true;
      return y >= minRuleYear;
    });
    // 4. 升序（左小右大）
    const list = yearsAll.sort((a, b) => a - b).map((year) => {
      const months = computeMonths(req.bookId, type, year);
      let usage = 0, amount = 0, tier = 0, hasBill = false;
      for (const m of months) {
        if (!m.hasBill) continue;
        hasBill = true;
        usage += m.usage;
        amount = round2(amount + m.amount);
        tier = Math.max(tier, m.tier);
      }
      return { year, usage: Math.round(usage), amount, tier, hasBill };
    });
    res.json({ list });
  })
);

// =====================================================================
// 存量校准（v2.2.14，服务启动时跑一次；服务端升级后自动生效）：
// 老引擎用「缴费月 + span-1」顺推账单区间 → 水/气/物业历史账单覆盖区间整体错位 +1 月
// （如 2026-02-05 缴燃气 219.52 应覆盖 2025-12~2026-01，库里却记 2026-01~02）。
// 本迁移：
//   1) 燃气规则生效月 2024-01 → 2023-12（用户要求，首张双月账单 2023-12~2024-01 可关联；
//      仅当该 (book, gas, category) 尚无 2023-12 起规则段时才改，避免与更早分段重叠）；
//   2) 按「真实缴费月」（首笔关联流水月）重新对齐水/气/物业账单覆盖区间，
//      与 utilitySyncFlowById 的 alignBillBlock 同一套规则；
//   3) 只动 status IN ('auto','pending') 的引擎账单（手动添加/用户校正过的不覆盖），
//      且只改 utility_records.bill_start/bill_end —— 绝不碰 flows 记账流水。
// 幂等：对齐目标是缴费月推导的唯一稳定块，重复执行结果不变；settings 打标防重复跑。
// =====================================================================
export function migrateUtilityAlignV1() {
  if (getSetting("utility_align_v1", "") === "1") return;
  let recMoved = 0, ruleMoved = 0, skipped = 0;

  // 1. 燃气规则生效月调整
  const gasRules = db
    .prepare(
      `SELECT * FROM utility_rules WHERE type='gas' AND effective_from='2024-01'
         ORDER BY book_id, category`
    )
    .all();
  for (const r of gasRules) {
    const dup = db
      .prepare(
        `SELECT 1 FROM utility_rules WHERE book_id=? AND type='gas' AND category=?
           AND effective_from='2023-12' AND id<>? LIMIT 1`
      )
      .get(r.book_id, ruleCategory(r), r.id);
    if (dup) { skipped += 1; continue; }
    db.prepare(
      "UPDATE utility_rules SET effective_from='2023-12', updated_at=datetime('now','localtime') WHERE id=?"
    ).run(r.id);
    ruleMoved += 1;
  }

  // 2. 水/气/物业账单覆盖区间对齐
  const recs = db
    .prepare(
      `SELECT * FROM utility_records WHERE type IN ('water','gas','property')
         AND status IN ('auto','pending')`
    )
    .all();
  for (const rec of recs) {
    const ids = flowIdsOf(rec);
    if (!ids.length) { skipped += 1; continue; } // 无流水的手动账单不动
    const payYm = payMonthOf(rec.book_id, rec);
    if (!payYm) { skipped += 1; continue; }
    const rule = rec.rule_id
      ? db.prepare("SELECT * FROM utility_rules WHERE id=?").get(rec.rule_id)
      : pickRuleAny(rec.book_id, rec.type, payYm);
    const { start, end } = alignBillBlock(
      rec.type,
      payYm,
      rule || { bill_span: recSpan(rec) }
    );
    if (
      String(rec.bill_start).slice(0, 7) === start &&
      String(rec.bill_end).slice(0, 7) === end
    ) continue; // 已对齐
    db.prepare(
      `UPDATE utility_records SET bill_start=?, bill_end=?, updated_at=datetime('now','localtime') WHERE id=?`
    ).run(start, end, rec.id);
    recMoved += 1;
  }
  setSetting("utility_align_v1", "1");
  console.log(
    `[utility-migrate] v2.2.14 存量校准完成：账单区间对齐 ${recMoved} 条、` +
      `燃气规则生效月调整 ${ruleMoved} 条、跳过 ${skipped} 条（手动/校正/无流水/已对齐）`
  );
}

// =====================================================================
// 存量校准 V2（v2.2.17 显式账期，服务启动时在 V1 之后跑一次）：
// v2.2.14/2.2.15 靠「缴费月奇偶」猜覆盖块 → 区间错位、一笔流水生成 2 张账单、
// 双月均摊一月多一月少、物业跨季错误合并（5/11 + 7/12 → 492）等顽疾。
// 新引擎把「出账日窗口 → 覆盖账期」显式写进规则（cover_json），本迁移：
//   1) 删除全部引擎账单（status IN ('auto','pending')）——manual/corrected 一律保留
//      （用户手工添加/校正过的账单视为用户所有，不覆盖）；
//   2) 按这些账单关联的流水，用新 utilitySyncFlowById 逐笔重建（覆盖区间由流水日号
//      命中规则窗口推导，天然归位、天然合并队友分拆、天然同季合并物业）；
//   3) 老规则无 cover_json → 读取端按类型默认账期兜底，无需回写。
// 幂等：settings 打标 utility_align_v2 只跑一次；重建目标唯一（窗口互斥），可安全重放。
// =====================================================================
export function migrateUtilityAlignV2() {
  if (getSetting("utility_align_v2", "") === "1") return;
  let del = 0, resynced = 0;
  // 1. 收集引擎账单关联流水（按账本分组），删除引擎账单
  const recs = db
    .prepare(
      `SELECT * FROM utility_records
        WHERE type IN ('water','electric','gas','property') AND status IN ('auto','pending')`
    )
    .all();
  const byBook = new Map();
  const delIds = [];
  for (const rec of recs) {
    delIds.push(rec.id);
    const ids = flowIdsOf(rec);
    if (!ids.length) continue;
    if (!byBook.has(rec.book_id)) byBook.set(rec.book_id, new Set());
    for (const fid of ids) byBook.get(rec.book_id).add(fid);
  }
  if (delIds.length) {
    const ph = delIds.map(() => "?").join(",");
    db.prepare(`DELETE FROM utility_records WHERE id IN (${ph})`).run(...delIds);
    del = delIds.length;
  }
  // 2. 按流水重建（新语义：出账窗口 → 覆盖账期；规则不匹配的流水自然不再生成账单）
  for (const [bookId, fset] of byBook) {
    for (const fid of fset) {
      try {
        utilitySyncFlowById(bookId, fid, { preserveOnNoRule: false });
        resynced += 1;
      } catch (e) {
        console.warn(`[utility-migrate] v2.2.17 流水 ${fid} 重建失败:`, e.message);
      }
    }
  }
  setSetting("utility_align_v2", "1");
  console.log(
    `[utility-migrate] v2.2.17 显式账期校准完成：删除引擎账单 ${del} 条、重建流水 ${resynced} 笔` +
      `（manual/corrected 保留；老规则按类型默认账期兜底）`
  );
}

// =====================================================================
// 存量校准 V3（v2.2.18 corrected 归位，服务启动时在 V2 之后跑一次）：
// 背景：V2 只删除重建 auto/pending，corrected/manual 一律保留 → 老引擎时代
// （v2.2.14 V1 对齐前）生成的错位 corrected 账单被「尊重」冻结：
//   例：物业 2024-02-03 缴「1～3月」→ 应 Q1=2024-01~03，库里却 2024-02~04；
//       水费 2024-03-24 缴 → 应 2024-02~03（16-31 → 上月+当月），库里却 2024-03~04。
//   结果：与相邻正确账单（auto 重建产物）在边界月重叠 → 月视图 amountAvg 双倍
//   （物业 4 月 164=82+82、水 4 月 116=67.8+48.4）、整额落错月、部分月份缺失。
// 本迁移：
//   1) 只处理 status='corrected'（引擎生成后用户校正过金额/用量/优惠 → 区间仍可能是
//      老引擎错位值；manual=用户手动新建的无流水/自定义账单，一律尊重不动）；
//   2) 对账单内全部关联流水用「出账窗口→账期」逐一推导覆盖区间——全部一致才归位
//      （多笔流水跨窗口推导不一致 → 无法唯一确定，跳过保留现状）；
//   3) 归位仅平移 bill_start/bill_end（span 不变），绝不改 usage/charge/paid/discount/
//      usage_locked/status——用户对金额/用量的校正完整保留；
//   4) 目标区间若已被同账本同类型其它账单占用 → 跳过（避免制造重叠）。
// 幂等：settings 打标 utility_align_v3 只跑一次；归位目标 = 窗口互斥推导，稳定可重放。
// =====================================================================
export function migrateUtilityAlignV3() {
  if (getSetting("utility_align_v3", "") === "1") return;
  let fixed = 0, skippedNoFlow = 0, skippedAmbiguous = 0, skippedDup = 0, skippedOK = 0;
  const recs = db
    .prepare(
      `SELECT * FROM utility_records
        WHERE type IN ('water','electric','gas','property') AND status='corrected'`
    )
    .all();
  for (const rec of recs) {
    const ids = flowIdsOf(rec);
    if (!ids.length) { skippedNoFlow += 1; continue; }
    // 逐笔流水推导覆盖区间（出账日窗口 → 账期），收集唯一候选
    const covSet = new Set();
    let determinable = true;
    for (const fid of ids) {
      const flow = db
        .prepare("SELECT * FROM flows WHERE id=? AND book_id=?")
        .get(fid, rec.book_id);
      if (!flow) continue;
      const type = kwTypeOf(flow);
      if (type !== rec.type) continue;
      const ym = String(flow.flow_time || "").slice(0, 7);
      if (!/^\d{4}-\d{2}$/.test(ym)) continue;
      const day = Number(String(flow.flow_time || "").slice(8, 10)) || 1;
      const { rule, cov } = ruleForFlow(rec.book_id, type, ym, day, flow.category);
      if (!rule || !cov) { determinable = false; break; }
      covSet.add(`${cov.start}~${cov.end}`);
    }
    if (!determinable || covSet.size !== 1) { skippedAmbiguous += 1; continue; }
    const [start, end] = [...covSet][0].split("~");
    const curStart = String(rec.bill_start || "").slice(0, 7);
    const curEnd = String(rec.bill_end || "").slice(0, 7);
    if (curStart === start && curEnd === end) { skippedOK += 1; continue; }
    // 目标区间已被同账本同类型其它账单占用 → 跳过（不制造重叠）
    const dup = db
      .prepare(
        `SELECT id FROM utility_records WHERE book_id=? AND type=? AND bill_start=? AND bill_end=? AND id<>? LIMIT 1`
      )
      .get(rec.book_id, rec.type, start, end, rec.id);
    if (dup) { skippedDup += 1; continue; }
    db.prepare(
      `UPDATE utility_records SET bill_start=?, bill_end=?, updated_at=datetime('now','localtime') WHERE id=?`
    ).run(start, end, rec.id);
    fixed += 1;
    console.log(
      `[utility-migrate] v3 归位 corrected 账单 #${rec.id} ${rec.type} ${curStart}~${curEnd} → ${start}~${end}`
    );
  }
  setSetting("utility_align_v3", "1");
  console.log(
    `[utility-migrate] v2.2.18 corrected 区间归位完成：修正 ${fixed} 条、` +
      `跳过（无流水 ${skippedNoFlow}/推导不定 ${skippedAmbiguous}/区间占用 ${skippedDup}/已正确 ${skippedOK}）`
  );
}

export default r;
