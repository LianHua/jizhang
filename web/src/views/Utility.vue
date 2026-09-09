<script setup>
import { ref, computed, onMounted, watch } from "vue";
import { useRouter } from "vue-router";
import api from "../api.js";
import { toast } from "../toast.js";
import EChart from "../components/EChart.vue";

const router = useRouter();
const TYPES = [
  { type: "water", label: "水费", unit: "m³" },
  { type: "electric", label: "电费", unit: "kWh" },
  { type: "gas", label: "燃气费", unit: "m³" },
  { type: "property", label: "物业费", unit: "元" },
];
const TYPE_ICON = { water: "💧", electric: "⚡", gas: "🔥", property: "🏢" };
const TYPE_LABEL = Object.fromEntries(TYPES.map((t) => [t.type, t.label]));

const segType = ref("electric");
// v260908：视图粒度「按月 / 按年」复用账单页 seg（月=某年12个月；年=历年汇总行）
const viewMode = ref("month");
const year = ref(new Date().getFullYear());
const loading = ref(false);
const months = ref([]);
const years = ref([]);
// v260910：规则起点前年份不可切换（翻年下限 = /years 升序首年；无数据时 null 不限）
const minYear = ref(null);
const rules = ref([]);
const records = ref([]);
const scanning = ref(false);

// 详情弹窗
const showDetail = ref(false);
const detailMonth = ref(null); // 'YYYY-MM'
const detailBills = ref([]);
const selBill = ref(null);
// v260908：详情弹窗改为录入「实际账单金额」（账单原价），优惠 = 该金额 − 实付
const editActual = ref(0);
const editUsage = ref("");

// 手动添加弹窗
const showAdd = ref(false);
const addBillStart = ref("");
const addBillEnd = ref("");
const addUsage = ref("");
const addPaid = ref("");
const addRemark = ref("");

const curType = computed(() => TYPES.find((t) => t.type === segType.value));
const curRuleCount = computed(
  () => rules.value.filter((x) => x.type === segType.value).length
);
const hasRule = computed(() => curRuleCount.value > 0);

const ym = (m) => `${year.value}-${String(m).padStart(2, "0")}`;
// 高亮：第2档橙黄，第3档及以上红色强警示
const tierClass = (tier) => (tier >= 3 ? "t3" : tier === 2 ? "t2" : "");
const tierText = (tier) =>
  tier >= 3 ? "第3档" : tier === 2 ? "第2档" : "";

// ---------------- 趋势图（v260908 金额柱+用量折线；v260909 改：物业=金额柱 / 水电气=用量柱 + 档位虚线） ----------------
// 按月视图：当年有账单的月份（按 type 选柱字段）；按年视图：历年汇总
const chartRows = computed(() =>
  viewMode.value === "year"
    ? years.value.filter((y) => y.hasBill)
    : months.value.filter((m) => m.hasBill)
);
const isProperty = computed(() => segType.value === "property");
const chartUnit = computed(() => curType.value.unit);
// 档位阈值：取第一条有账单行的 tierThresholds（同一类型/年内的规则一致；跨年可能变，按行取更准）
function tierMarkLine(seriesName) {
  // 收集所有有账单行的非 null 阈值
  const s = new Set();
  for (const r of chartRows.value) {
    if (r.tierThresholds) {
      for (const t of r.tierThresholds) if (t != null) s.add(t);
    }
  }
  const arr = [...s].sort((a, b) => a - b);
  if (!arr.length) return undefined;
  // 第2档=第1个阈值（橙），第3档=第2个阈值（红）
  return {
    symbol: "none",
    silent: true,
    data: arr.map((v, i) => ({
      yAxis: v,
      lineStyle: {
        type: "dashed",
        color: i === 0 ? "#f59e0b" : "#ef4444",
        width: 1,
      },
      label: { show: false },
    })),
  };
}
const chartOpt = computed(() => {
  const rows = chartRows.value;
  if (!rows.length) return null;
  const labels = rows.map((r) =>
    viewMode.value === "year" ? r.year + "年" : r.month + "月"
  );
// 物业=金额柱；水电气=用量柱
    const values = rows.map((r) =>
      isProperty.value ? Number(r.amount || 0) : Number(r.usage || 0)
    );
    const mark = tierMarkLine();
    // v260910：yAxis.max 至少覆盖到最大档位阈值（避免档位虚线被裁到图表外看不到）
    // echarts 默认 dataMax 自动包含 markLine，但显式设更稳
    const tierArr = mark ? mark.data.map((d) => d.yAxis) : [];
    const maxValue = values.length
      ? values.reduce((a, b) => (b > a ? b : a), values[0])
      : 0;
    const maxTier = tierArr.length ? tierArr.reduce((a, b) => (b > a ? b : a), tierArr[0]) : 0;
    const yMax = Math.ceil(Math.max(maxValue, maxTier) * 1.1) || 1;
    const series = [
      {
        name: isProperty.value ? "金额" : "用量",
        type: "bar",
        data: values,
        barWidth: "38%",
        itemStyle: { color: isProperty.value ? "#6366f1" : "#10b981", borderRadius: [4, 4, 0, 0] },
        // 档位虚线（无档位不画；mark=undefined 时不设）
        ...(mark ? { markLine: mark } : {}),
      },
    ];
  return {
    tooltip: {
      trigger: "axis",
      formatter: (ps) => {
        const i = ps[0]?.dataIndex ?? 0;
        const r = rows[i];
        let s = `<b>${labels[i]}</b><br/>`;
        // 物业=只显示金额；水电气=只显示用量（与柱对齐）；不画"金额"列
        if (isProperty.value) {
          s += `${ps[0].marker} 金额：¥${Number(r.amount || 0).toFixed(2)}`;
        } else {
          const u = Number(r.usage || 0);
          s += `${ps[0].marker} 用量：${u} ${chartUnit.value}`;
        }
        if (r.tier >= 2) s += `<br/><span style="color:${r.tier >= 3 ? "#ef4444" : "#f59e0b"}">● 第${r.tier}档</span>`;
        return s;
      },
    },
    grid: { left: 50, right: 18, top: 16, bottom: 24 },
    xAxis: { type: "category", data: labels, axisLine: { lineStyle: { color: "var(--border, #e5e7eb)" } } },
    yAxis: {
      type: "value",
      name: isProperty.value ? "金额(¥)" : `用量(${chartUnit.value})`,
      max: yMax,
      splitLine: { lineStyle: { color: "var(--border, #e5e7eb)" } },
    },
    series,
  };
});
// 数据点告警标注（不参与渲染，仅提示）
const hasOverTier = computed(() => chartRows.value.some((r) => r.tier >= 2));

async function loadAll() {
  const [r1, r2] = await Promise.all([
    api.get("/utility/rules"),
    api.get("/utility/records", { params: { type: segType.value, year: year.value } }),
  ]);
  rules.value = r1.data.list || [];
  records.value = r2.data.list || [];
}

async function loadMonths() {
  loading.value = true;
  try {
    const { data } = await api.get("/utility/months", {
      params: { type: segType.value, year: year.value },
    });
    months.value = data.months || [];
  } finally {
    loading.value = false;
  }
}
async function loadYears() {
  loading.value = true;
  try {
    const { data } = await api.get("/utility/years", {
      params: { type: segType.value },
    });
    years.value = data.list || [];
    // 升序首年 = 可切换年份下限（规则起点前的年份服务端不下发）
    minYear.value = years.value.length ? years.value[0].year : null;
    return years.value;
  } finally {
    loading.value = false;
  }
}

async function refresh() {
  // 始终拉 years 以维护翻年下限（规则起点前年份不可切换，v260910）
  await loadYears();
  await Promise.all([
    loadAll(),
    viewMode.value === "year" ? Promise.resolve() : loadMonths(),
  ]);
}

function switchMode(m) {
  if (m === viewMode.value) return;
  viewMode.value = m;
  refresh();
}
// 年视图点某一年 → 切回按月并定位到该年
function viewYear(y) {
  if (year.value !== y) year.value = y;
  switchMode("month");
}

function switchType(t) {
  if (t === segType.value) return;
  segType.value = t;
  refresh();
}
function shiftYear(d) {
  // v260910：规则起点前年份不可切换（下限 = /years 升序首年）；上限同安卓 +3 年
  const next = year.value + d;
  if (next < (minYear.value ?? -9999)) return;
  if (next > new Date().getFullYear() + 3) return;
  year.value = next;
  refresh();
}

function fmtUsage(row) {
  if (row.usage == null || row.usage === 0) return "—";
  return String(Math.round(row.usage)); // 均摊展示整数（用户确认）
}
function fmtAmount(v) {
  if (!v) return "—";
  return "¥" + Number(v).toFixed(2);
}

// ---------------- 详情 ----------------
function openDetail(m) {
  detailMonth.value = ym(m);
  const bills = records.value.filter(
    (b) => b.bill_start <= detailMonth.value && b.bill_end >= detailMonth.value
  );
  if (!bills.length) return; // 无账单的月不可点
  detailBills.value = bills;
  selBill.value = bills[0];
  resetEdit();
  showDetail.value = true;
}
function pickBill(b) {
  selBill.value = b;
  resetEdit();
}
function resetEdit() {
  // 输入框默认 = 原价（实付+既有优惠）；无优惠时即实付金额
  editActual.value = selBill.value
    ? Number((Number(selBill.value.paid || 0) + Number(selBill.value.discount || 0)).toFixed(2))
    : 0;
  editUsage.value =
    selBill.value && selBill.value.usage_total != null
      ? String(selBill.value.usage_total)
      : "";
}
async function saveCorrection() {
  const b = selBill.value;
  if (!b) return;
  const payload = {};
  if (String(editActual.value).trim() !== "") {
    const actual = Number(editActual.value);
    if (isNaN(actual) || actual < 0) {
      toast("金额格式不对");
      return;
    }
    const paid = Number(b.paid || 0);
    if (actual + 0.005 < paid) {
      toast(`实际账单金额不能小于实付合计 ¥${paid.toFixed(2)}（没有优惠时请填实付金额本身）`);
      return;
    }
    payload.discount = Math.round((actual - paid) * 100) / 100; // 优惠 = 原价 − 实付
  }
  if (String(editUsage.value).trim() !== "") payload.usage = Number(editUsage.value);
  try {
    await api.put(`/utility/records/${b.id}`, payload);
    toast("已保存");
    await refresh();
    // 重新定位弹窗数据
    detailBills.value = records.value.filter(
      (x) => x.bill_start <= detailMonth.value && x.bill_end >= detailMonth.value
    );
    selBill.value = detailBills.value.find((x) => x.id === b.id) || detailBills.value[0];
    resetEdit();
  } catch (e) {
    toast(e.message);
  }
}
async function removeBill(b) {
  if (!confirm(`删除这张${TYPE_LABEL[b.type]}账单（${b.bill_start}~${b.bill_end}）？`)) return;
  try {
    await api.delete(`/utility/records/${b.id}`);
    toast("已删除");
    showDetail.value = false;
    await refresh();
  } catch (e) {
    toast(e.message);
  }
}
function statusText(b) {
  return (
    { auto: "自动", pending: "待校正", corrected: "已校正", manual: "手动" }[b.status] || b.status
  );
}

// ---------------- 手动添加 ----------------
function openAdd() {
  addBillStart.value = ym(new Date().getMonth() + 1);
  addBillEnd.value = addBillStart.value;
  addUsage.value = "";
  addPaid.value = "";
  addRemark.value = "";
  showAdd.value = true;
}
async function saveAdd() {
  const payload = {
    type: segType.value,
    bill_start: addBillStart.value,
    bill_end: addBillEnd.value || addBillStart.value,
    remark: addRemark.value.trim(),
  };
  if (String(addUsage.value).trim() !== "") payload.usage = Number(addUsage.value);
  if (String(addPaid.value).trim() !== "") payload.paid = Number(addPaid.value);
  if (!("usage" in payload) && !("paid" in payload)) {
    toast("请填写用量或金额至少一项");
    return;
  }
  try {
    await api.post("/utility/records", payload);
    toast("已添加");
    showAdd.value = false;
    await refresh();
  } catch (e) {
    toast(e.message);
  }
}

// ---------------- 扫描历史 ----------------
async function scan() {
  if (!confirm(`扫描「${TYPE_LABEL[segType.value]}」规则生效后的历史流水，生成/并入账单？`)) return;
  scanning.value = true;
  try {
    const { data } = await api.post("/utility/scan", { type: segType.value });
    toast(`扫描完成：${data.counts?.[segType.value] ?? 0} 笔流水已处理`);
    await refresh();
  } catch (e) {
    toast(e.message);
  } finally {
    scanning.value = false;
  }
}

onMounted(async () => {
  const today = new Date();
  segType.value = "electric";
  year.value = today.getFullYear();
  await refresh();
});
watch(year, refresh);
</script>

<template>
  <div>
    <div class="head-line">
      <h2 class="page-title" style="margin-bottom: 0">水电气用量</h2>
      <div class="head-actions">
        <button class="btn btn-sm" @click="scan" :disabled="scanning || !hasRule">
          {{ scanning ? "扫描中…" : "扫描历史" }}
        </button>
        <button class="btn btn-sm btn-primary" @click="openAdd">+ 手动添加</button>
        <button class="btn btn-sm" @click="router.push({ name: 'utility-rules' })">⚙️ 规则设置</button>
      </div>
    </div>

    <!-- 顶部固定两行：类型 seg + 月份/年切换 -->
    <div class="fixed-bar">
      <div class="seg-row">
        <span
          v-for="t in TYPES"
          :key="t.type"
          :class="['seg', { on: segType === t.type }]"
          @click="switchType(t.type)"
        >
          {{ TYPE_ICON[t.type] }}{{ t.label }}
        </span>
      </div>
      <div class="sub-row">
        <!-- v260908：按月/按年视图（复用账单页 seg 交互） -->
        <div class="vseg" style="margin-right: 4px">
          <button :class="['vseg-btn', { on: viewMode === 'month' }]" @click="switchMode('month')">按月</button>
          <button :class="['vseg-btn', { on: viewMode === 'year' }]" @click="switchMode('year')">按年</button>
        </div>
        <template v-if="viewMode === 'month'">
          <button class="btn btn-sm" :disabled="minYear != null && year <= minYear" @click="shiftYear(-1)">←</button>
          <span class="year-txt">{{ year }} 年</span>
          <button class="btn btn-sm" @click="shiftYear(1)">→</button>
        </template>
        <span class="muted note" style="margin-left: 6px">第2档起橙黄高亮，第3档及以上红色警示</span>
      </div>
    </div>

    <div v-if="!hasRule" class="card no-rule">
      <b>「{{ TYPE_LABEL[segType] }}」还没有计价规则</b>
      <p class="muted" style="margin: 6px 0 0">
        规则带生效时间，生效日期之前的流水不会自动计入；添加规则后新保存的流水自动生成账单，也可点右上角「扫描历史」回填。
      </p>
      <button class="btn btn-sm btn-primary" style="margin-top: 10px" @click="router.push({ name: 'utility-rules' })">
        去添加规则
      </button>
    </div>

    <div v-else-if="loading" class="card muted">加载中…</div>
    <template v-else>
      <!-- v260909：趋势图（物业=金额柱 / 水电气=用量柱 + 档位虚线） -->
      <div class="card" style="padding: 14px 16px; margin-bottom: 12px" v-if="chartOpt">
        <div class="section-title" style="margin-bottom: 6px">
          {{ viewMode === "month" ? year + " 年趋势" : "历年趋势" }}（柱={{ isProperty ? "金额" : "用量" }}{{ chartOpt.series[0]?.markLine ? " · 虚线=档位" : "" }}）
        </div>
        <EChart :option="chartOpt" height="210px" />
      </div>

      <!-- 按年：历年汇总行（等距 4 列：年份-用量-档位-金额） -->
      <div v-if="viewMode === 'year'" class="card month-card">
        <div v-for="y in years" :key="y.year" :class="['month-row', tierClass(y.tier), { off: !y.hasBill }]" @click="y.hasBill && viewYear(y.year)">
          <span class="col-name">{{ y.year }}年</span>
          <span class="col-usage">{{ y.hasBill ? y.usage : "—" }}<em class="unit">{{ y.hasBill ? curType.unit : "" }}</em></span>
          <span class="col-tier">
            <span v-if="tierText(y.tier)" class="tier-badge" :class="tierClass(y.tier)">{{ tierText(y.tier) }}</span>
            <span v-else class="muted slot">—</span>
          </span>
          <span class="col-amt">{{ fmtAmount(y.amount) }}</span>
        </div>
        <div v-if="!years.length" class="muted" style="padding: 14px 4px">还没有任何账单</div>
      </div>

      <!-- 按月：等距 4 列（月份-用量-档位-金额；第1档不显示但位置留出） -->
      <div v-else class="card month-card">
        <div
          v-for="m in months"
          :key="m.ym"
          :class="['month-row', tierClass(m.tier), { off: !m.hasBill }]"
          @click="m.hasBill && openDetail(m.month)"
        >
          <span class="col-name">{{ m.month }}月</span>
          <span class="col-usage">{{ fmtUsage(m) }}<em class="unit">{{ m.hasBill ? curType.unit : "" }}</em></span>
          <span class="col-tier">
            <span v-if="tierText(m.tier)" class="tier-badge" :class="tierClass(m.tier)">{{ tierText(m.tier) }}</span>
            <span v-else-if="m.note" class="pend">{{ m.note }}</span>
            <span v-else class="muted slot">—</span>
          </span>
          <span class="col-amt">{{ fmtAmount(m.amount) }}</span>
        </div>
      </div>
    </template>

    <!-- 详情弹窗：补优惠 / 改用量 -->
    <div v-if="showDetail" class="modal-mask" @click.self="showDetail = false">
      <div class="modal">
        <h3 class="modal-title">{{ detailMonth }} {{ TYPE_LABEL[segType] }}明细</h3>
        <template v-if="detailBills.length > 1">
          <div class="sub-tabs">
            <span v-for="b in detailBills" :key="b.id" :class="['chip', { on: selBill?.id === b.id }]" @click="pickBill(b)">
              {{ b.bill_start }}~{{ b.bill_end }}
            </span>
          </div>
        </template>

        <template v-if="selBill">
          <div class="bill-head">
            <div>
              <div class="kv"><span>账单区间</span><b>{{ selBill.bill_start }} ~ {{ selBill.bill_end }}</b></div>
              <div class="kv"><span>本期用量</span><b>{{ selBill.usage_total != null ? selBill.usage_total + " " + curType.unit : "—" }}</b></div>
              <div class="kv"><span>用量档位</span><b :class="tierClass(selBill.tier_level)">{{ selBill.tier_level >= 2 ? "第" + selBill.tier_level + "档" : "第1档（正常）" }}</b></div>
            </div>
            <div style="text-align: right">
              <div class="kv"><span>应缴</span><b>¥{{ Number(selBill.charge || 0).toFixed(2) }}</b></div>
              <div class="kv"><span>优惠</span><b>−¥{{ Number(selBill.discount || 0).toFixed(2) }}</b></div>
              <div class="kv"><span>实付</span><b>¥{{ Number(selBill.paid || 0).toFixed(2) }}</b></div>
            </div>
          </div>
          <div class="status-line">
            状态：<b :class="['pend', { ok: selBill.status === 'auto' || selBill.status === 'corrected' || selBill.status === 'manual' }]">{{ statusText(selBill) }}</b>
            <span class="muted" v-if="selBill.status === 'pending'">｜ 实付与规则应缴不一致（可能有优惠），请补优惠或改用量</span>
            <span class="muted" v-else-if="selBill.discount > 0">｜ 已含优惠 {{ selBill.discount }} 元</span>
          </div>

          <div class="corr">
            <div class="corr-row">
              <label>实际账单金额（账单上写的应缴金额；优惠 = 该金额 − 实付，自动计算）</label>
              <input class="input" type="number" min="0" step="0.01" v-model="editActual" />
              <button class="btn btn-sm btn-primary" @click="saveCorrection">保存</button>
            </div>
            <div class="corr-row">
              <label>用量修正（按抄表/实际填写后自动重算应缴）</label>
              <input class="input" type="number" min="0" step="0.01" v-model="editUsage" placeholder="按实际用量填写" />
              <button class="btn btn-sm" @click="saveCorrection">保存</button>
            </div>
          </div>

          <div v-if="selBill.flows?.length" class="flows">
            <div class="section-title" style="margin-bottom: 6px">关联流水（{{ selBill.flows.length }}笔）</div>
            <div v-for="f in selBill.flows" :key="f.id" class="flow-line">
              <span>{{ f.flow_time?.slice(0, 10) }}</span>
              <span class="fname">{{ f.description }}</span>
              <span class="famt">¥{{ Number(f.amount).toFixed(2) }}</span>
            </div>
          </div>

          <div class="modal-foot">
            <button class="btn btn-sm btn-danger" @click="removeBill(selBill)">删除此账单</button>
            <button class="btn btn-sm" @click="showDetail = false">关闭</button>
          </div>
        </template>
      </div>
    </div>

    <!-- 手动添加弹窗 -->
    <div v-if="showAdd" class="modal-mask" @click.self="showAdd = false">
      <div class="modal">
        <h3 class="modal-title">手动添加{{ TYPE_LABEL[segType] }}账单</h3>
        <div class="form-grid">
          <label>覆盖起始月
            <input class="input" type="month" v-model="addBillStart" />
          </label>
          <label>覆盖结束月
            <input class="input" type="month" v-model="addBillEnd" />
          </label>
          <label>本期用量{{ curType.unit }}
            <input class="input" type="number" min="0" step="0.01" v-model="addUsage" placeholder="抄表数差值" />
          </label>
          <label>实付金额（可选，填了可自动反推用量）
            <input class="input" type="number" min="0" step="0.01" v-model="addPaid" placeholder="如 246" />
          </label>
          <label class="full">备注
            <input class="input" v-model="addRemark" placeholder="选填" />
          </label>
        </div>
        <div class="muted" style="font-size: 12px; margin-bottom: 14px">
          提示：平时由流水自动生成，此入口用于抄表补录 / 一笔合并缴费等特殊情况。
        </div>
        <div class="modal-foot">
          <button class="btn btn-sm" @click="showAdd = false">取消</button>
          <button class="btn btn-sm btn-primary" @click="saveAdd">保存</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.head-line { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 14px; flex-wrap: wrap; }
.head-actions { display: flex; gap: 8px; flex-wrap: wrap; }

.fixed-bar { position: sticky; top: 60px; z-index: 9; background: var(--bg); margin: -2px -4px 0; padding: 2px 4px 10px; }
.seg-row { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; }
/* v260908：视图 seg（按月/按年）独立类名，勿用 .seg（那是类型切换胶囊，两套样式互不干扰） */
.vseg { display: inline-flex; background: var(--surface-2); border: 1px solid var(--border); border-radius: 10px; padding: 3px; flex-shrink: 0; }
.vseg-btn { border: 0; background: transparent; color: var(--text-2); padding: 6px 14px; font-size: 13px; border-radius: 8px; cursor: pointer; white-space: nowrap; }
.vseg-btn.on { background: var(--surface); color: var(--primary); font-weight: 600; box-shadow: var(--shadow); }
.seg { padding: 7px 16px; border-radius: 999px; background: var(--surface-2); cursor: pointer; font-size: 14px; color: var(--text-2); user-select: none; }
.seg.on { background: var(--primary-soft); color: var(--primary); font-weight: 600; }
.sub-row { display: flex; align-items: center; gap: 10px; }
.year-txt { font-weight: 700; font-size: 15px; min-width: 70px; text-align: center; }
.note { font-size: 12px; margin-left: 6px; }

.no-rule { border-left: 4px solid var(--primary); }
.month-card { padding: 8px 14px; }
/* v260909：4 列等距（月份-用量-档位-金额），档位列空时占位保持对齐 */
.month-row { display: grid; grid-template-columns: 1fr 1.4fr 1fr 1.4fr; align-items: center; padding: 11px 10px; border-radius: 10px; cursor: pointer; border-bottom: 1px solid var(--border); }
.month-row:last-child { border-bottom: none; }
.month-row:hover { background: var(--surface-2); }
.month-row.off { opacity: 0.45; cursor: default; }
/* 高亮：第2档橙黄（弱），第3档及以上红色（强） */
.month-row.t2 { background: rgba(245, 158, 11, 0.10); box-shadow: inset 3px 0 0 #f59e0b; }
.month-row.t2:hover { background: rgba(245, 158, 11, 0.16); }
.month-row.t3 { background: rgba(239, 68, 68, 0.10); box-shadow: inset 3px 0 0 var(--expense, #ef4444); }
.month-row.t3:hover { background: rgba(239, 68, 68, 0.16); }
.col-name { font-weight: 600; padding-left: 4px; }
.col-usage { font-size: 17px; font-weight: 700; text-align: right; padding-right: 12px; }
.col-usage .unit { font-size: 11px; font-weight: 400; color: var(--text-2); margin-left: 3px; font-style: normal; }
.col-tier { text-align: center; }
.col-amt { text-align: right; font-weight: 600; padding-right: 4px; }
.tier-badge { display: inline-block; font-size: 11px; padding: 2px 8px; border-radius: 999px; font-weight: 700; min-width: 38px; text-align: center; }
.tier-badge.t2 { background: #f59e0b; color: #fff; }
.tier-badge.t3 { background: var(--expense, #ef4444); color: #fff; }
.month-row.t3 .col-usage, .month-row.t3 .col-amt { color: var(--expense, #ef4444); }
.slot { color: transparent; user-select: none; }  /* 占位保持对齐 */
.pend { font-size: 12px; color: var(--expense, #ef4444); font-weight: 600; }
.pend.ok { color: #10b981; font-weight: 500; }

.bill-head { display: flex; justify-content: space-between; gap: 16px; background: var(--surface-2); border-radius: 10px; padding: 12px 14px; margin-bottom: 8px; }
.kv { margin: 3px 0; font-size: 13px; }
.kv span { color: var(--text-2); margin-right: 8px; }
.status-line { font-size: 13px; margin: 8px 0; }
.corr { border-top: 1px dashed var(--border); padding-top: 10px; }
.corr-row { display: flex; align-items: center; gap: 8px; margin: 8px 0; flex-wrap: wrap; }
.corr-row label { font-size: 12px; color: var(--text-2); width: 100%; }
.corr-row .input { flex: 1; min-width: 120px; }
.flows { margin-top: 10px; border-top: 1px dashed var(--border); padding-top: 8px; }
.flow-line { display: flex; gap: 10px; font-size: 13px; padding: 4px 0; align-items: center; }
.fname { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.famt { font-weight: 600; }
.sub-tabs { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 10px; }
.chip { font-size: 12px; padding: 4px 10px; border-radius: 999px; background: var(--surface-2); cursor: pointer; }
.chip.on { background: var(--primary); color: #fff; }
.modal-foot { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
.form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px 14px; margin-bottom: 8px; }
.form-grid label { font-size: 13px; display: flex; flex-direction: column; gap: 5px; color: var(--text-2); }
.form-grid .full { grid-column: 1 / -1; }
</style>
