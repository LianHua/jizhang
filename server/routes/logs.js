import { Router } from "express";
import { db } from "../db.js";
import { auth, wrap } from "../mw.js";

/**
 * 客户端（安卓）自动记账【运行日志】上传 / 查询。
 *
 * 为什么有这条通道：安卓端本地日志只留最近 300 条（重启/长期不开 App 就会滚动丢掉），
 * 而「某笔支付为什么没自动记账」往往要事后回溯（家人反馈时已经过去几小时甚至几天）。
 * 所以客户端把日志缓冲整包同步上来，服务端**不限条数**长期留存，网页端/接口可随时查。
 *
 * 幂等设计：client_logs 上 (book_id, device, ts, line) 唯一 + INSERT OR IGNORE，
 * 客户端可以无脑全量重传（不必维护上传游标），重复行自然被忽略。
 *
 *   POST /api/logs/client   批量上传 {lines[], device, platform, app_version}
 *   GET  /api/logs/client   查询（bookId?/device?/q?/limit/offset/order）
 *   GET  /api/logs/client/devices  设备清单（含各设备条数/最近时间/账本/账号）
 */
const r = Router();
r.use(auth);

const MAX_LINES = 500; // 单次上传行数上限（客户端本地缓冲 300 条，留余量）
const MAX_LINE_LEN = 2000; // 单行长度上限（防脏数据撑爆库）
const TS_RE = /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\]/;

/** 当前用户可见的账本 id 列表（admin = 全部账本） */
function visibleBookIds(user) {
  const rows =
    user.role === "admin"
      ? db.prepare("SELECT id FROM books").all()
      : db.prepare("SELECT book_id AS id FROM book_members WHERE user_id=?").all(user.id);
  return rows.map((x) => Number(x.id));
}

function isMember(user, bookId) {
  if (!bookId) return false;
  if (user.role === "admin") return true;
  return !!db
    .prepare("SELECT 1 FROM book_members WHERE book_id=? AND user_id=?")
    .get(bookId, user.id);
}

const clamp = (s, n) => String(s == null ? "" : s).replace(/[\r\n]+/g, " ").slice(0, n);

// ---------------- 上传 ----------------
r.post(
  "/client",
  wrap((req, res) => {
    const b = req.body || {};
    let bookId = Number(b.bookId || req.query.bookId || 0) || 0;
    if (!bookId) {
      // 兜底：客户端没带账本时挂到该账号的第一个账本，避免日志无归属
      const first = db
        .prepare("SELECT book_id AS id FROM book_members WHERE user_id=? ORDER BY book_id LIMIT 1")
        .get(req.user.id);
      bookId = first ? Number(first.id) : 0;
    }
    if (bookId && !isMember(req.user, bookId)) {
      return res.status(403).json({ error: "无权访问该账本" });
    }
    const rawLines = Array.isArray(b.lines) ? b.lines : [];
    if (!rawLines.length) return res.json({ ok: true, inserted: 0, skipped: 0, total: 0 });

    const device = clamp(b.device, 64) || "unknown";
    const platform = clamp(b.platform, 16) || "android";
    const appVersion = clamp(b.app_version || b.appVersion, 32);

    const ins = db.prepare(
      `INSERT OR IGNORE INTO client_logs
         (book_id, user_id, device, platform, app_version, ts, line)
       VALUES (?,?,?,?,?,?,?)`
    );
    const tx = db.transaction((lines) => {
      let inserted = 0;
      for (const ln of lines.slice(0, MAX_LINES)) {
        const line = clamp(ln, MAX_LINE_LEN).trim();
        if (!line) continue;
        const ts = (TS_RE.exec(line)?.[1] || "").trim();
        inserted += ins.run(bookId, req.user.id, device, platform, appVersion, ts, line).changes;
      }
      return inserted;
    });
    const inserted = tx(rawLines);
    const total = db
      .prepare("SELECT COUNT(*) AS n FROM client_logs WHERE book_id=?")
      .get(bookId).n;
    res.json({
      ok: true,
      inserted,
      skipped: rawLines.length - inserted,
      total,
    });
  })
);

// ---------------- 设备清单（网页端筛选下拉用） ----------------
r.get(
  "/client/devices",
  wrap((req, res) => {
    const ids = visibleBookIds(req.user);
    if (!ids.length) return res.json({ list: [] });
    const ph = ids.map(() => "?").join(",");
    const rows = db
      .prepare(
        `SELECT l.book_id       AS book_id,
                b.name          AS book_name,
                l.device        AS device,
                l.platform      AS platform,
                MAX(l.app_version) AS app_version,
                COUNT(*)        AS count,
                MAX(l.ts)       AS last_ts,
                MAX(l.created_at) AS last_upload
           FROM client_logs l
           LEFT JOIN books b ON b.id = l.book_id
          WHERE l.book_id IN (${ph})
          GROUP BY l.book_id, l.device
          ORDER BY last_upload DESC`
      )
      .all(...ids);
    res.json({ list: rows });
  })
);

// ---------------- 查询 ----------------
r.get(
  "/client",
  wrap((req, res) => {
    const limit = Math.min(Number(req.query.limit) || 200, 1000);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const order = String(req.query.order || "desc").toLowerCase() === "asc" ? "ASC" : "DESC";
    const q = String(req.query.q || "").trim();
    const device = String(req.query.device || "").trim();
    const bookId = Number(req.query.bookId || 0) || 0;

    let ids;
    if (bookId) {
      if (!isMember(req.user, bookId)) return res.status(403).json({ error: "无权访问该账本" });
      ids = [bookId];
    } else {
      ids = visibleBookIds(req.user);
    }
    if (!ids.length) return res.json({ list: [], total: 0, books: [] });

    const ph = ids.map(() => "?").join(",");
    const where = [`l.book_id IN (${ph})`];
    const args = [...ids];
    if (device) {
      where.push("l.device = ?");
      args.push(device);
    }
    if (req.query.from) {
      where.push("l.ts >= ?");
      args.push(String(req.query.from));
    }
    if (req.query.to) {
      where.push("l.ts <= ?");
      args.push(String(req.query.to) + " 23:59:59");
    }
    if (q) {
      where.push("l.line LIKE ?");
      args.push(`%${q}%`);
    }
    const wh = where.join(" AND ");
    const total = db
      .prepare(`SELECT COUNT(*) AS n FROM client_logs l WHERE ${wh}`)
      .get(...args).n;
    const list = db
      .prepare(
        `SELECT l.id, l.book_id, l.user_id, l.device, l.platform, l.app_version,
                l.ts, l.line, l.created_at,
                b.name AS book_name, u.nickname AS nickname
           FROM client_logs l
           LEFT JOIN books b ON b.id = l.book_id
           LEFT JOIN users u ON u.id = l.user_id
          WHERE ${wh}
          ORDER BY l.id ${order}
          LIMIT ? OFFSET ?`
      )
      .all(...args, limit, offset);
    const books = db
      .prepare(
        `SELECT b.id, b.name, COUNT(l.id) AS count
           FROM books b LEFT JOIN client_logs l ON l.book_id = b.id
          WHERE b.id IN (${ph})
          GROUP BY b.id ORDER BY count DESC`
      )
      .all(...ids);
    res.json({ list, total, books });
  })
);

export default r;
