<script setup>
import { ref, onMounted, computed } from "vue";
import { useRouter } from "vue-router";
import api from "../api.js";
import { toast } from "../toast.js";

const router = useRouter();
const TYPES = [
  { type: "water", label: "水费", unit: "m³", span: 2, icon: "💧" },
  { type: "electric", label: "电费", unit: "kWh", span: 1, icon: "⚡" },
  { type: "gas", label: "燃气费", unit: "m³", span: 2, icon: "🔥" },
  { type: "property", label: "物业费", unit: "元", span: 3, icon: "🏢" },
];
const MONTH_CHIPS = Array.from({ length: 12 }, (_, i) => i + 1);

const rules = ref([]);
const loading = ref(false);
// 关联分类选项（v260908：规则可绑定任意消费分类，识别=规则分类+名称关键词）
const cats = ref([]);
const DEFAULT_CAT = "住房";
const expenseCats = computed(() => cats.value.filter((c) => c.type === "expense"));

const showEdit = ref(false);
const editingId = ref(null); // null = 新建
const f = ref(null); // 编辑表单对象

function defaultTiers(type) {
  const map = {
    water: [
      { cap: "41", price: "3.5" },
      { cap: "11", price: "5.25" },
      { cap: "", price: "10.5" },
    ],
    electric: [
      { cap: "200", price: "0.5889" },
      { cap: "199", price: "0.6389" },
      { cap: "", price: "0.8889" },
    ],
    gas: [
      { cap: "320", price: "3.45" },
      { cap: "80", price: "4.14" },
      { cap: "", price: "5.18" },
    ],
    property: [{ cap: "", price: "82" }],
  };
  return map[type] || [{ cap: "", price: "" }];
}
function metaOf(type) {
  return TYPES.find((t) => t.type === type) || TYPES[0];
}
function blankForm(type) {
  const m = metaOf(type);
  const now = new Date();
  const thisYm = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const fm = {
    type,
    name: "",
    category: DEFAULT_CAT,
    effective_from: thisYm,
    effective_to: "",
    bill_span: m.span,
    cycle_type: type === "gas" ? "by_year" : "by_span",
    unit: type === "electric" ? "kWh" : type === "property" ? "元" : "m³",
    tiers: defaultTiers(type),
    season:
      type === "electric"
        ? { months: [5, 6, 7, 8, 9, 10], tiers: [{ cap: "260", price: "0.5889" }, { cap: "339", price: "0.6389" }, { cap: "", price: "0.8889" }] }
        : null,
    monthly_fee: type === "property" ? "82" : "",
  };
  return fm;
}

async function load() {
  loading.value = true;
  try {
    const [{ data }, catRes] = await Promise.all([
      api.get("/utility/rules"),
      api.get("/categories"),
    ]);
    rules.value = data.list || [];
    cats.value = Array.isArray(catRes.data) ? catRes.data : [];
  } finally {
    loading.value = false;
  }
}

function openNew() {
  editingId.value = null;
  f.value = blankForm("electric");
  showEdit.value = true;
}
function openEdit(rule) {
  editingId.value = rule.id;
  f.value = {
    type: rule.type,
    name: rule.name || "",
    category: rule.category || DEFAULT_CAT,
    effective_from: rule.effective_from,
    effective_to: rule.effective_to || "",
    bill_span: rule.bill_span,
    cycle_type: rule.cycle_type,
    unit: rule.unit || "m³",
    tiers: (rule.tiers || []).map((t) => ({
      cap: t.cap == null ? "" : String(t.cap),
      price: String(t.price),
    })),
    season: rule.season
      ? {
          months: [...(rule.season.months || [])],
          tiers: rule.season.tiers.map((t) => ({
            cap: t.cap == null ? "" : String(t.cap),
            price: String(t.price),
          })),
        }
      : null,
    monthly_fee: rule.monthly_fee != null ? String(rule.monthly_fee) : "",
  };
  showEdit.value = true;
}
function onTypeChange() {
  if (editingId.value) return; // 编辑中不改类型
  f.value = blankForm(f.value.type);
}
function addTierRow(list) {
  list.push({ cap: "", price: "" });
}
function rmTierRow(list, i) {
  if (list.length <= 1) return;
  list.splice(i, 1);
  // 保证末行 cap 为空（∞）
  const last = list[list.length - 1];
  if (last && String(last.cap).trim() !== "") list.push({ cap: "", price: "" });
}
function normTiers(list) {
  const out = [];
  for (const t of list) {
    const price = Number(t.price);
    if (!price || price <= 0) continue;
    const capRaw = String(t.cap ?? "").trim();
    out.push({ cap: capRaw === "" ? null : Number(capRaw), price });
  }
  if (!out.length) return null;
  // 保证最后一档是 ∞
  if (out[out.length - 1].cap != null) out.push({ cap: null, price: out[out.length - 1].price });
  return out;
}
async function save() {
  if (!/^\d{4}-\d{2}$/.test(f.value.effective_from)) {
    toast("请选择生效起始月");
    return;
  }
  if (f.value.effective_to && !/^\d{4}-\d{2}$/.test(f.value.effective_to)) {
    toast("结束月格式不对");
    return;
  }
  const tiers = normTiers(f.value.tiers);
  if (!tiers) {
    toast("至少填写一个有效档位（单价>0）");
    return;
  }
  const payload = {
    type: f.value.type,
    name: f.value.name.trim(),
    category: f.value.category || DEFAULT_CAT,
    effective_from: f.value.effective_from,
    effective_to: f.value.effective_to || "",
    bill_span: Math.max(1, Number(f.value.bill_span) || metaOf(f.value.type).span),
    cycle_type: f.value.type === "gas" ? "by_year" : "by_span",
    unit: f.value.unit,
    tiers,
    monthly_fee: f.value.type === "property" ? Number(f.value.monthly_fee) || 0 : undefined,
  };
  if (f.value.type === "electric") {
    const sTiers = normTiers(f.value.season?.tiers || []);
    if (!sTiers) {
      toast("电费需要填写夏季档位");
      return;
    }
    payload.season = { months: f.value.season?.months?.length ? f.value.season.months : [5, 6, 7, 8, 9, 10], tiers: sTiers };
  }
  try {
    if (editingId.value) {
      await api.put(`/utility/rules/${editingId.value}`, payload);
      toast("已保存");
    } else {
      await api.post("/utility/rules", payload);
      toast("已创建规则（生效月份之前的流水不会自动计入）");
    }
    showEdit.value = false;
    await load();
  } catch (e) {
    toast(e.message);
  }
}
async function removeRule(rule) {
  if (!confirm(`删除「${rule.name || "未命名"}」规则？（已有账单保留，新流水不再按此规则生成）`)) return;
  try {
    await api.delete(`/utility/rules/${rule.id}`);
    toast("已删除");
    await load();
  } catch (e) {
    toast(e.message);
  }
}
function summary(rule) {
  const tiers = rule.tiers || [];
  const parts = tiers.map((t) =>
    t.cap == null ? `超第${tiers.length}档 ¥${t.price}` : `0~${t.cap} ¥${t.price}`
  );
  let s = `每笔覆盖 ${rule.bill_span} 个月｜档位：${parts.join("，")}`;
  if (rule.type === "electric" && rule.season) {
    s += `｜夏季(${rule.season.months.join("/")}月)：${rule.season.tiers.map((t) => (t.cap == null ? `超¥${t.price}` : `≤${t.cap} ¥${t.price}`)).join("，")}`;
  }
  if (rule.type === "property" && rule.monthly_fee != null) s = `每笔覆盖 ${rule.bill_span} 个月｜月费 ¥${rule.monthly_fee}`;
  return s;
}
function effText(r) {
  return `${r.effective_from}${r.effective_to ? " ~ " + r.effective_to : " ~ 至今"}`;
}
const grouped = computed(() =>
  TYPES.map((t) => ({ ...t, list: rules.value.filter((x) => x.type === t.type) }))
);

function toggleMonth(m) {
  if (!f.value.season) return;
  const ms = f.value.season.months;
  const i = ms.indexOf(m);
  if (i >= 0) ms.splice(i, 1);
  else ms.push(m);
}
function rmSeasonTier(i) {
  if (!f.value.season || f.value.season.tiers.length <= 1) return;
  f.value.season.tiers.splice(i, 1);
  const last = f.value.season.tiers[f.value.season.tiers.length - 1];
  if (last && String(last.cap).trim() !== "") f.value.season.tiers.push({ cap: "", price: "" });
}

onMounted(load);
</script>

<template>
  <div>
    <div class="head-line">
      <h2 class="page-title" style="margin-bottom: 0">水电气规则</h2>
      <div class="head-actions">
        <button class="btn btn-sm" @click="router.push({ name: 'utility' })">← 返回用量</button>
        <button class="btn btn-sm btn-primary" @click="openNew">+ 新建规则</button>
      </div>
    </div>
    <p class="muted intro">
      同一类型可配置多段规则（换城市 / 调价 = 新建一段并设置生效时间）。<b>规则生效月份之前的流水不会自动计入</b>；账单生成时按缴费当月匹配生效中的规则段。
    </p>

    <div v-if="loading" class="card muted">加载中…</div>
    <template v-else>
      <div v-for="g in grouped" :key="g.type" class="card rule-group">
        <div class="group-title">
          <span>{{ g.icon }} {{ g.label }}</span>
          <button class="btn btn-sm" @click="f = blankForm(g.type); editingId = null; showEdit = true">+ 添加{{ g.label }}规则</button>
        </div>
        <div v-if="!g.list.length" class="muted" style="font-size: 13px">还没有该类型的规则（可点右上角添加）</div>
        <div v-for="rl in g.list" :key="rl.id" class="rule-line">
          <div class="rule-main">
            <div class="rule-name">
              {{ rl.name || g.label + "规则" }}
              <span class="eff">{{ effText(rl) }}</span>
              <span v-if="rl.category && rl.category !== DEFAULT_CAT" class="cat-chip">分类 {{ rl.category }}</span>
              <span v-else class="cat-chip muted-chip">分类 {{ DEFAULT_CAT }}</span>
            </div>
            <div class="muted rule-sum">{{ summary(rl) }}</div>
          </div>
          <div class="rule-ops">
            <button class="btn btn-sm" @click="openEdit(rl)">编辑</button>
            <button class="btn btn-sm btn-danger" @click="removeRule(rl)">删除</button>
          </div>
        </div>
      </div>
    </template>

    <!-- 新建 / 编辑弹窗 -->
    <div v-if="showEdit" class="modal-mask" @click.self="showEdit = false">
      <div class="modal wide">
        <h3 class="modal-title">{{ editingId ? "编辑规则" : "新建规则" }}</h3>
        <div class="form-grid">
          <label>类型
            <select class="select" v-model="f.type" :disabled="!!editingId" @change="onTypeChange">
              <option v-for="t in TYPES" :key="t.type" :value="t.type">{{ t.icon }} {{ t.label }}</option>
            </select>
          </label>
          <label>关联消费分类（识别该分类下含「水费/电费/燃气费/物业费」的支出流水）
            <select class="select" v-model="f.category">
              <option v-for="c in expenseCats" :key="c.name" :value="c.name">{{ c.icon }} {{ c.name }}</option>
              <option v-if="f.category && !expenseCats.some((c) => c.name === f.category)" :value="f.category">{{ f.category }}（分类已删除）</option>
            </select>
          </label>
          <label>规则名称（选填，如 广州水费2026）
            <input class="input" v-model="f.name" placeholder="选填" />
          </label>
          <label>生效起始月（含）
            <input class="input" type="month" v-model="f.effective_from" />
          </label>
          <label>生效结束月（留空 = 至今）
            <input class="input" type="month" v-model="f.effective_to" />
          </label>
          <label>每笔覆盖月数
            <input class="input" type="number" min="1" v-model="f.bill_span" :disabled="f.type === 'gas'" />
          </label>
          <label>用量单位
            <select class="select" v-model="f.unit">
              <option v-for="u in ['m³', 'kWh', '元', '吨']" :key="u" :value="u">{{ u }}</option>
            </select>
          </label>
        </div>

        <div class="tier-block" v-if="f.type !== 'property'">
          <div class="section-title">阶梯档位（最后一行留空容量 = 不限量档；单价为实付单价）</div>
          <div v-for="(t, i) in f.tiers" :key="i" class="tier-row">
            <span class="cap-lbl">{{ i === f.tiers.length - 1 && !String(t.cap).trim() ? "超出部分" : "档内用量上限" }}</span>
            <input class="input" type="number" min="0" v-model="t.cap" placeholder="∞" style="width: 110px" />
            <span class="x">×</span>
            <input class="input" type="number" min="0" step="0.0001" v-model="t.price" placeholder="单价" style="width: 120px" />
            <button class="btn btn-sm" @click="rmTierRow(f.tiers, i)">✕</button>
          </div>
          <button class="btn btn-sm" @click="addTierRow(f.tiers)">+ 加一档</button>
        </div>

        <div class="tier-block" v-if="f.type === 'property'">
          <div class="section-title">物业费（固定月费，无阶梯）</div>
          <div class="tier-row">
            <span>每月物业费</span>
            <input class="input" type="number" min="0" step="0.01" v-model="f.monthly_fee" style="width: 130px" />
            <span class="x">元</span>
          </div>
        </div>

        <div class="tier-block" v-if="f.type === 'electric'">
          <div class="section-title">夏季档（夏季月份用电价高，按以下档位计）</div>
          <div class="month-chips">
            <span v-for="m in MONTH_CHIPS" :key="m" :class="['mchip', { on: f.season?.months?.includes(m) }]" @click="toggleMonth(m)">{{ m }}月</span>
          </div>
          <div v-for="(t, i) in f.season?.tiers || []" :key="'s' + i" class="tier-row">
            <span class="cap-lbl">{{ i === (f.season?.tiers?.length || 0) - 1 && !String(t.cap).trim() ? "超出部分" : "档内用量上限" }}</span>
            <input class="input" type="number" min="0" v-model="t.cap" placeholder="∞" style="width: 110px" />
            <span class="x">×</span>
            <input class="input" type="number" min="0" step="0.0001" v-model="t.price" placeholder="单价" style="width: 120px" />
            <button class="btn btn-sm" @click="rmSeasonTier(i)">✕</button>
          </div>
          <button class="btn btn-sm" @click="f.season.tiers.push({ cap: '', price: '' })">+ 加一档</button>
        </div>

        <div class="modal-foot">
          <button class="btn btn-sm" @click="showEdit = false">取消</button>
          <button class="btn btn-sm btn-primary" @click="save">保存</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.head-line { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 6px; flex-wrap: wrap; }
.head-actions { display: flex; gap: 8px; }
.intro { font-size: 13px; margin-bottom: 14px; }
.rule-group { margin-bottom: 14px; padding: 14px 16px; }
.group-title { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; font-weight: 700; }
.rule-line { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 10px 4px; border-bottom: 1px solid var(--border); }
.rule-line:last-child { border-bottom: none; }
.rule-main { flex: 1; min-width: 0; }
.rule-name { font-weight: 600; font-size: 14px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.eff { font-size: 12px; font-weight: 400; color: var(--primary); background: var(--primary-soft); padding: 1px 8px; border-radius: 999px; }
.cat-chip { font-size: 11px; font-weight: 400; padding: 1px 8px; border-radius: 999px; background: var(--surface-2); color: var(--text-2); }
.cat-chip.muted-chip { background: transparent; border: 1px dashed var(--border); }
.rule-sum { font-size: 12px; margin-top: 4px; }
.rule-ops { display: flex; gap: 6px; flex-shrink: 0; }

.modal.wide { width: 640px; max-width: 96vw; }
.form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px 14px; margin-bottom: 12px; }
.form-grid label { font-size: 13px; display: flex; flex-direction: column; gap: 5px; color: var(--text-2); }
.tier-block { border-top: 1px dashed var(--border); padding-top: 10px; margin-bottom: 12px; }
.tier-block .section-title { margin-bottom: 8px; }
.tier-row { display: flex; align-items: center; gap: 8px; margin: 7px 0; flex-wrap: wrap; }
.cap-lbl { font-size: 12px; color: var(--text-2); width: 90px; }
.x { color: var(--text-2); }
.month-chips { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 10px; }
.mchip { font-size: 12px; padding: 3px 9px; border-radius: 999px; background: var(--surface-2); cursor: pointer; user-select: none; }
.mchip.on { background: var(--primary); color: #fff; }
.modal-foot { display: flex; justify-content: flex-end; gap: 8px; margin-top: 8px; }
</style>
