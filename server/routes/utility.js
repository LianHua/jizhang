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
// pickRule(cat)，由「该类型在当月生效的规则里 category 是否等于流水分类」决定是否计入。
export function matchUtilityType(flow) {
  if (!flow || flow.type !== "expense") return null;
  return kwTypeOf(flow);
}

// 关键词 → 类型（不含分类判断；分类判断在 pickRule 按规则绑定分类精确匹配）
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

// 取该类型在 ym（'YYYY-MM'）生效、且绑定分类=cat 的规则段；
// 无生效段（含规则生效日期之前 / 该分类没有规则）返回 null
function pickRule(bookId, type, ym, cat) {
  const c = String(cat || "").trim() || HOUSE_CAT;
  const rows = db
    .prepare(
      `SELECT * FROM utility_rules WHERE book_id=? AND type=? AND category=?
         AND effective_from <= ? AND (effective_to IS NULL OR effective_to >= ?)
         ORDER BY effective_from DESC LIMIT 1`
    )
    .all(bookId, type, c, ym, ym);
  return rows[0] || null;
}

// 取该类型在 ym 生效的任一规则（不区分分类，取最新生效段）；
// 手动添加账单等无流水上下文时使用
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

// 该 type 在 ym 是否“存在任意生效规则”（用于判定流水是否因换分类/规则集变更而不再匹配）
function hasAnyRule(bookId, type, ym) {
  const r = db
    .prepare(
      `SELECT 1 FROM utility_rules WHERE book_id=? AND type=?
         AND effective_from <= ? AND (effective_to IS NULL OR effective_to >= ?) LIMIT 1`
    )
    .get(bookId, type, ym, ym);
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

// 该类型当年（缴费自然年）按「规则绑定分类」口径的流水金额合计 —— 燃气年累计
// v260908：category 按生成该账单的规则绑定分类过滤（不同分类各自独立年累计）
function annualPaidOf(bookId, type, year, cat) {
  const kw = kwOf(type);
  const c = String(cat || "").trim() || HOUSE_CAT;
  const r = db
    .prepare(
      `SELECT COALESCE(SUM(amount),0) t FROM flows
        WHERE book_id=? AND type='expense' AND category=?
          AND flow_time>=? AND flow_time<? AND description LIKE ?`
    )
    .get(bookId, c, `${year}-01-01`, `${year + 1}-01-01`, `%${kw}%`);
  return Number(r.t) || 0;
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

// 账单覆盖区间由「缴费月」按规则块对齐推导（v2.2.14 第5轮定论，与展示模型配套：
// 用量归覆盖月（双月各半）、金额归真实缴费月）：
//   electric(span1)         → 覆盖 = 缴费月
//   water(span2, 单月出账)  → 出账覆盖「本月+上月」：缴费奇数月 M → [M-1, M]；
//                             缴费月偶数（迟缴上月账）→ 归到前一块（末=上月奇数月）
//   gas(span2, 双月出账)    → 出的是前面 2 个月的量：缴费偶数月 M → [M-2, M-1]；
//                             缴费月奇数（迟缴）→ 归到前一块（末=缴月-2）
//   物业(span3)             → 缴费时间不定，对齐自然季度（1/4/7/10 起）：缴费月所在季
// 双月/季度账单与缴费月解耦后，流水月可能落在覆盖区间外（燃气缴 2026-02 → 覆盖
// 2025-12~2026-01）；金额展示由 computeMonths 按 payMonthOf 另行锚定。
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
  // 规则被删除后账单仍要可重算：兜底取该类型当月生效的最新规则（可能仍为 null）
  if (!rule) rule = pickRuleAny(bookId, rec.type, rec.bill_start);
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
    // 燃气：年累计。paidBefore = 当年总额 − 本账单总额（按规则绑定分类的年累计口径）。
    // 年份锚「缴费自然年」（真实缴费月，payMonthOf）——覆盖块可跨年
    // （缴 2026-02 → 覆盖 2025-12~2026-01，金额计入 2026 年累计）。
    const payYm = payMonthOf(bookId, rec) || rec.bill_start;
    const year = Number(String(payYm).slice(0, 4));
    const annual = annualPaidOf(bookId, rec.type, year, ruleCategory(rule));
    const paidBefore = Math.max(0, round2(annual - paid));
    const tiers = parseTiers(rule);
    usageTotal = gasBreakdown(round2(paid + discount), paidBefore, tiers);
    // 本期用量不再二次正向验算（反推按年累计扣出，天然自洽）；charge 取实付+优惠
    charge = round2(paid + discount);
    tier = gasTierByMoney(round2(annual + discount), tiers);
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
  // v260908：按「规则绑定分类」精确匹配（老规则默认住房 → 老行为不变）
  const rule = pickRule(bookId, type, ym, flow.category);
  if (!rule) {
    // 规则生效日期之前 / 该分类没有规则 → 不计入。
    // 若该类型当月仍存在其他分类的生效规则（说明用户把这笔记到了别的分类，
    // 编辑触发时从旧账单摘除）；scan 场景保留原账单（幂等保底，防误删存量）。
    if (!preserveOnNoRule && hasAnyRule(bookId, type, ym)) {
      utilityRemoveFlowById(bookId, flowId);
    }
    return;
  }
  // v2.2.14：账单覆盖区间按「规则块」对齐推导（水单月→本月+上月；气双月→前 2 个月；
  // 物业→自然季度），不再用「缴费月 + span-1」顺推（那会把覆盖区间整体错位 +1 月，
  // 如 2026-02-05 缴燃气 → 正确覆盖 2025-12~2026-01，旧逻辑却记成 2026-01~02）。
  const { start: bStart, end: bEnd } = alignBillBlock(type, ym, rule);

  // v260908 双月账单错位修复：队友分拆支付的尾款若落在相邻月（双月账单 8/25 付一笔、
  // 9/2 再付一笔），老逻辑按各自支付月各生成一张错位账单 → 均摊金额一月多一月少。
  // 现优先并入「同类型 + 覆盖本月的现有账单」；无覆盖才按支付月新建账单。
  let rec = db
    .prepare(
      `SELECT * FROM utility_records WHERE book_id=? AND type=? AND bill_start<=? AND bill_end>=?
         ORDER BY bill_start LIMIT 1`
    )
    .get(bookId, type, ym, ym);
  if (!rec) {
    rec = db
      .prepare(
        `SELECT * FROM utility_records WHERE book_id=? AND type=? AND bill_start=? AND bill_end=?`
      )
      .get(bookId, type, bStart, bEnd);
  }
  if (rec) {
    const ids = flowIdsOf(rec);
    if (!ids.includes(Number(flowId))) ids.push(Number(flowId));
    db.prepare(
      `UPDATE utility_records SET flow_ids=?, updated_at=datetime('now','localtime') WHERE id=?`
    ).run(JSON.stringify(ids), rec.id);
    rec = { ...rec, flow_ids: JSON.stringify(ids) };
  } else {
    const info = db
      .prepare(
        `INSERT INTO utility_records (book_id,type,rule_id,bill_start,bill_end,flow_ids,paid,status)
         VALUES (?,?,?,?,?,?,0,'auto')`
      )
      .run(bookId, type, rule.id, bStart, bEnd, JSON.stringify([Number(flowId)]));
    rec = db.prepare("SELECT * FROM utility_records WHERE id=?").get(info.lastInsertRowid);
  }
  recomputeRecord(bookId, rec, rule, false);
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
  return { ...rule, tiers: parseTiers(rule), season: parseSeason(rule) };
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
      return res.status(400).json({ error: "生效月份格式应为 YYYY-MM" });
    if (b.effective_to && !/^\d{4}-\d{2}$/.test(String(b.effective_to)))
      return res.status(400).json({ error: "结束月份格式应为 YYYY-MM" });
    const tiers = Array.isArray(b.tiers) && b.tiers.length ? b.tiers : null;
    if (!tiers) return res.status(400).json({ error: "至少需要一个档位" });
    const span = Math.max(1, Number(b.bill_span) || 1);
    // v260908：规则可绑定任意消费分类（识别口径=规则分类+名称关键词）；默认住房
    const category = String(b.category || "").trim() || HOUSE_CAT;
    const info = db
      .prepare(
        `INSERT INTO utility_rules
           (book_id,type,name,category,effective_from,effective_to,bill_span,cycle_type,unit,tiers_json,season_json,monthly_fee,remark)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
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
      return res.status(400).json({ error: "生效月份格式应为 YYYY-MM" });
    if (b.effective_to !== undefined && b.effective_to && !/^\d{4}-\d{2}$/.test(String(b.effective_to)))
      return res.status(400).json({ error: "结束月份格式应为 YYYY-MM" });
    const tiers = b.tiers !== undefined ? (Array.isArray(b.tiers) && b.tiers.length ? b.tiers : null) : null;
    if (b.tiers !== undefined && !tiers) return res.status(400).json({ error: "至少需要一个档位" });
    db.prepare(
      `UPDATE utility_rules SET name=?, category=?, effective_from=?, effective_to=?, bill_span=?,
              cycle_type=?, unit=?, tiers_json=?, season_json=?, monthly_fee=?, remark=?,
              updated_at=datetime('now','localtime') WHERE id=?`
    ).run(
      b.name !== undefined ? String(b.name) : cur.name,
      b.category !== undefined ? (String(b.category).trim() || HOUSE_CAT) : ruleCategory(cur),
      b.effective_from !== undefined ? b.effective_from : cur.effective_from,
      b.effective_to !== undefined ? (b.effective_to || null) : cur.effective_to,
      Math.max(1, Number(b.bill_span ?? cur.bill_span) || 1),
      b.cycle_type !== undefined ? String(b.cycle_type) : cur.cycle_type,
      b.unit !== undefined ? String(b.unit) : cur.unit,
      tiers ? JSON.stringify(tiers) : cur.tiers_json,
      b.season !== undefined ? (b.season ? JSON.stringify(b.season) : null) : cur.season_json,
      b.monthly_fee !== undefined ? (b.monthly_fee ? Number(b.monthly_fee) : null) : cur.monthly_fee,
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

// ---------------- 月度视图（按月看：某年 12 个月） ----------------
// v2.2.14 语义（用户 2026-09-10 第 5 轮定论，覆盖区间与缴费月解耦后）：
//  - 用量归「覆盖月」：avgU = Math.round(totalU/span)，所有覆盖月都 +avgU
//    （双月完全一致，余数不补偿；视觉一致优先，月度 Σusage 可能 ±1 个单位）。
//  - 金额归「真实缴费月」（payMonthOf = 首笔流水月）：paid 全额累加在缴费月（右列），
//    覆盖的其余月金额为 0。缴费月可能不在覆盖区间内（燃气缴 2026-02 → 覆盖
//    2025-12~2026-01，金额显示在 2026-02）。
//  - amountAvg = paid 均摊到覆盖月（物业 246/3=82 每月；供中间列/趋势图用）。
//  - 取消下发 tierThresholds：用户要求趋势图不再画档位虚线。
function computeMonths(bookId, type, year) {
  // v2.2.13 字典序坑：bill_start/bill_end 存 7 位 'YYYY-MM'（如 '2025-01'），
  // 若比较参数用 10 位 'YYYY-MM-DD'，'2025-01' < '2025-01-01' → 每年 1 月账单被滤掉。
  // 统一用 substr(1,7) 在 SQL 侧归一化，兼容库内 7/10 位两种存量。
  const yStart = `${year}-01`;
  const yEnd = `${year}-12`;
  const activeRule = pickRuleAny(bookId, type, `${year}-01-01`);
  const isProperty = type === "property";

  const months = Array.from({ length: 12 }, (_, i) => ({
    month: i + 1,
    ym: `${year}-${String(i + 1).padStart(2, "0")}`,
    usage: 0,
    amount: 0,
    amountAvg: 0, // v2.2.13：账单 paid 均摊到覆盖月（物业/水/气中间列与趋势图用）
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
    // v2.2.13：用量展示层均摊，所有覆盖月一律 +avgU，无余数补偿
    const avgU = Math.round(totalU / span);
    const paid = round2(Number(rec.paid) || 0);
    // v2.2.15：按规则 effective_from 过滤（用户 2026-09-10 反馈）
    // 账单右端 < 规则起点 → 这条账单在规则生效之前产生，不计入月份视图
    // （如规则水 effective_from=2024-02 → 覆盖 2023-12~2024-01 的 11.22 账单应消失）。
    // 字典序 7 位比较（YYYY-MM vs YYYY-MM）安全，规避 v2.2.12 7 位/10 位字典序 BUG。
    if (rec.rule_id) {
      const r = db.prepare("SELECT effective_from FROM utility_rules WHERE id=?").get(rec.rule_id);
      const ef = String(r?.effective_from || "").slice(0, 7);
      const be = String(rec.bill_end || "").slice(0, 7);
      if (ef && be && ef > be) continue;
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
    for (const m of mList) {
      const row = months[m - 1];
      row.hasBill = true;
      row.tier = Math.max(row.tier, Number(rec.tier_level) || 1);
      // 用量均摊：所有覆盖月相等（v2.2.13 视觉一致优先）
      row.usage += avgU;
      // amountAvg = 该账单 paid 均摊到覆盖月（物业 246/3=82 每月；水/气同），
      // 供「中间列/趋势图」用均摊月值展示。
      row.amountAvg = round2(row.amountAvg + paid / span);
      if (rec.status === "pending") row.note = "待校正";
    }
    // v2.2.14 金额锚「真实缴费月」（首笔流水月，payMonthOf）：
    // 缴费月可能不在覆盖区间内——燃气双月缴 → 覆盖前 2 个月
    // （缴 2026-02 → 覆盖 2025-12~2026-01），金额只出现在缴费月（右列），
    // 其余覆盖月金额为 0（v2.2.6「缴费月累计」语义）。
    // 缴费月行无用量但需标 hasBill（/years 年度金额汇总依赖行数据）。
    const payYm = payMonthOf(bookId, rec);
    if (payYm && String(payYm).slice(0, 4) === String(year)) {
      const pM = Number(String(payYm).slice(5, 7));
      const prow = months[pM - 1];
      prow.hasBill = true;
      prow.tier = Math.max(prow.tier, Number(rec.tier_level) || 1);
      prow.amount = round2(prow.amount + paid);
      if (rec.status === "pending") prow.note = "待校正";
    }
  }
  // 物业费无需档位字段，但保留 cycleType 与 ruleUnit 方便前端展示
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

export default r;
