#!/usr/bin/env node
// WorkSync MCP server.
// 让一个 AI agent 作为附属芯片出现在它"主人"那张卡片下面。
// 数据模型一对多：rooms/{room}/agents/{ownerUid}/{agentId} —— 一个 ownerUid 可挂多个 agentId。
//
// 配置（环境变量，全部可选，给了才生效）：
//   WS_ROOM           房间名（默认 main）
//   WS_OWNER_UID      主人在页面里的 ID（页面"复制我的ID"按钮拿到）；不填则作为独立 AI 卡显示
//   WS_OWNER_NAME     主人显示名（页面没开时用它兜底，默认 "AI"）
//   WS_AGENT_NAME     这个 agent 的显示名（默认 "Claude"）
//   WS_AGENT_ID       固定 agentId（默认随机；同名重启想复用同一节点时可固定）
// Firebase 配置必须由调用方提供（不再内置任何凭证）：
//   WS_FIREBASE_CONFIG  完整 JSON，如 '{"apiKey":"...","databaseURL":"...","projectId":"..."}'
//   或至少 WS_DATABASE_URL（+可选 WS_API_KEY / WS_PROJECT_ID）

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { initializeApp } from "firebase/app";
import { getDatabase, ref, set, update, get, onValue, onDisconnect, remove } from "firebase/database";

const ROOM = process.env.WS_ROOM || "lobby";
const OWNER_UID = process.env.WS_OWNER_UID || ("a_solo_" + Math.random().toString(36).slice(2, 8));
const OWNER_NAME = process.env.WS_OWNER_NAME || "AI";
const AGENT_NAME = process.env.WS_AGENT_NAME || "Claude";
const AGENT_ID = process.env.WS_AGENT_ID || ("a_" + Math.random().toString(36).slice(2, 10));

function loadConfig() {
  if (process.env.WS_FIREBASE_CONFIG) {
    try { return JSON.parse(process.env.WS_FIREBASE_CONFIG); }
    catch (e) { throw new Error("WS_FIREBASE_CONFIG 不是合法 JSON：" + e.message); }
  }
  if (process.env.WS_DATABASE_URL) {
    return { databaseURL: process.env.WS_DATABASE_URL, apiKey: process.env.WS_API_KEY, projectId: process.env.WS_PROJECT_ID };
  }
  throw new Error("缺少 Firebase 配置：请设置 WS_FIREBASE_CONFIG（完整 JSON）或至少 WS_DATABASE_URL。");
}
const app = initializeApp(loadConfig());
const db = getDatabase(app);

const agentPath = `rooms/${ROOM}/agents/${OWNER_UID}/${AGENT_ID}`;
const agentRef = ref(db, agentPath);
// 信箱（持久路径，不随 onDisconnect 删）：别人向这个 agent 提的问题落在这里
const qaPath = `rooms/${ROOM}/qa/${OWNER_UID}/${AGENT_ID}`;

let joined = false;
let heartbeat = null;
const state = { status: "working", task: "", accepting: false };

const STATUS_LABELS = {
  working: "工作中", focus: "专注勿扰", meeting: "开会中", break: "休息",
  lunch: "吃饭", away: "离开", offline: "下班", idle: "空闲",
};
const label = (s) => STATUS_LABELS[s] || s || "未知";

function nodePayload() {
  return {
    name: AGENT_NAME,
    ownerName: OWNER_NAME,
    status: state.status,
    task: state.task || "",
    accepting: !!state.accepting,
    updatedAt: Date.now(),
    startedAt: state._startedAt || (state._startedAt = Date.now()),
  };
}

async function writeNode() {
  await set(agentRef, nodePayload());
}

function startHeartbeat() {
  if (heartbeat) return;
  // 用完整 set 做心跳：即便被一次 onDisconnect 抹掉也能在下次心跳整体恢复
  heartbeat = setInterval(() => {
    if (joined) writeNode().catch(() => {});
  }, 15000);
}

let connWatch = null;
async function doJoin() {
  await writeNode();
  joined = true;
  // 健壮在场：每次(重)连都先重挂 onDisconnect 再重写完整节点
  // （Node 下 Firebase 偶发重连，onDisconnect().remove() 会触发，必须重新建立）
  if (!connWatch) {
    connWatch = onValue(ref(db, ".info/connected"), (snap) => {
      if (snap.val() === true && joined) {
        onDisconnect(agentRef).remove().then(() => writeNode()).catch(() => {});
      }
    });
  }
  startHeartbeat();
}

async function doLeave() {
  joined = false;
  if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
  await remove(agentRef).catch(() => {});
}

function fmtLocalTime(tz) {
  try {
    return new Intl.DateTimeFormat("zh-CN", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date());
  } catch { return "--:--"; }
}

// ---------- MCP ----------
const server = new McpServer({ name: "worksync", version: "0.1.0" });

server.tool(
  "worksync_join",
  "加入 WorkSync 房间：把这个 AI 作为附属芯片挂到主人(ownerUid)卡片下。可选初始 status/task。",
  { status: z.string().optional(), task: z.string().optional() },
  async ({ status, task }) => {
    if (status) state.status = status;
    if (task != null) state.task = task;
    await doJoin();
    return { content: [{ type: "text", text:
      `已加入房间「${ROOM}」。\n身份：${AGENT_NAME}（agentId=${AGENT_ID}）挂在 ownerUid=${OWNER_UID}（${OWNER_NAME}）下。\n状态=${label(state.status)}　任务=${state.task || "(空)"}\n这是 onDisconnect 自动清理的实时节点；进程退出会自动消失。` }] };
  }
);

server.tool(
  "worksync_set",
  "更新这个 AI 的状态/任务/是否接受提问。任意字段可单独传。",
  { status: z.string().optional(), task: z.string().optional(), accepting: z.boolean().optional() },
  async ({ status, task, accepting }) => {
    if (status != null) state.status = status;
    if (task != null) state.task = task;
    if (accepting != null) state.accepting = accepting;
    if (joined) await writeNode();
    return { content: [{ type: "text", text:
      `${joined ? "已更新" : "（尚未 join，仅暂存）"}：状态=${label(state.status)}　任务=${state.task || "(空)"}　接受提问=${state.accepting ? "是" : "否"}` }] };
  }
);

server.tool(
  "worksync_who",
  "列出房间里当前的人(presence)和所有 AI agent（按主人分组）。",
  {},
  async () => {
    const [uSnap, aSnap] = await Promise.all([
      get(ref(db, `rooms/${ROOM}/users`)),
      get(ref(db, `rooms/${ROOM}/agents`)),
    ]);
    const users = uSnap.val() || {};
    const agents = aSnap.val() || {};
    const lines = [`房间「${ROOM}」：`];

    const userIds = Object.keys(users);
    lines.push(`\n👤 在线的人（${userIds.length}）：`);
    if (!userIds.length) lines.push("  （无）");
    for (const id of userIds) {
      const u = users[id];
      const nm = u.enc ? "🔒加密" : (u.name || "匿名");
      lines.push(`  · ${nm} — ${label(u.status)}　${fmtLocalTime(u.tz)} (${u.tz || "?"})`);
      const mine = agents[id] || {};
      for (const aid of Object.keys(mine)) {
        const a = mine[aid];
        lines.push(`      🤖 ${a.name || "AI"} — ${label(a.status)}${a.task ? "：" + a.task : ""}${a.accepting ? "　[可提问]" : ""}`);
      }
    }

    // 主人不在线、但 agent 还挂着的（孤儿）
    const orphanOwners = Object.keys(agents).filter((oid) => !users[oid]);
    if (orphanOwners.length) {
      lines.push(`\n🤖 仅 AI 在线（主人页面未开）：`);
      for (const oid of orphanOwners) {
        const mine = agents[oid];
        for (const aid of Object.keys(mine)) {
          const a = mine[aid];
          lines.push(`  · ${a.ownerName || "AI"} / ${a.name || "AI"} — ${label(a.status)}${a.task ? "：" + a.task : ""}${a.accepting ? "　[可提问]" : ""}`);
        }
      }
    }
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

server.tool(
  "worksync_timeline",
  "读取某人最近 N 小时的状态历史时间线（默认 24h）。uid 不填则读全房所有人。",
  { uid: z.string().optional(), hours: z.number().optional() },
  async ({ uid, hours }) => {
    const win = (hours || 24) * 3600 * 1000;
    const cut = Date.now() - win;
    const snap = await get(ref(db, `rooms/${ROOM}/hist`));
    const all = snap.val() || {};
    const targets = uid ? (all[uid] ? { [uid]: all[uid] } : {}) : all;
    const lines = [`时间线（近 ${hours || 24}h）：`];
    const ids = Object.keys(targets);
    if (!ids.length) return { content: [{ type: "text", text: lines.concat("  （无记录）").join("\n") }] };
    for (const id of ids) {
      const entries = Object.values(targets[id])
        .filter((e) => e && e.ts >= cut)
        .sort((a, b) => a.ts - b.ts);
      if (!entries.length) continue;
      lines.push(`\n· ${id}：`);
      for (const e of entries) {
        const t = new Date(e.ts).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
        lines.push(`    ${t}  ${label(e.status)}`);
      }
    }
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

server.tool(
  "worksync_inbox",
  "查看别人向这个 AI 提出、尚未回答的问题（信箱）。先 worksync_set({accepting:true}) 才会有人能提问。",
  { includeAnswered: z.boolean().optional() },
  async ({ includeAnswered }) => {
    const snap = await get(ref(db, qaPath));
    const all = snap.val() || {};
    let items = Object.keys(all).map((qid) => ({ qid, ...all[qid] }));
    if (!includeAnswered) items = items.filter((e) => !e.answer);
    items.sort((a, b) => (a.qts || 0) - (b.qts || 0));
    if (!items.length) return { content: [{ type: "text", text: "信箱里没有待回答的问题。" }] };
    const lines = items.map((e) =>
      `qid=${e.qid}  来自 ${e.fromName || "匿名"}：${e.question}${e.answer ? "\n    已答：" + e.answer : ""}`);
    return { content: [{ type: "text", text: `信箱（${items.length}）：\n` + lines.join("\n") + "\n\n用 worksync_answer({qid, answer}) 回答；答案会即时出现在提问者页面。" }] };
  }
);

server.tool(
  "worksync_answer",
  "回答信箱里的某个问题（写回答案，提问者页面即时可见）。",
  { qid: z.string(), answer: z.string() },
  async ({ qid, answer }) => {
    await update(ref(db, `${qaPath}/${qid}`), { answer, ats: Date.now() });
    return { content: [{ type: "text", text: `已回答 qid=${qid}。` }] };
  }
);

server.tool(
  "worksync_leave",
  "离开房间：删除这个 AI 的节点（停止心跳）。",
  {},
  async () => {
    await doLeave();
    return { content: [{ type: "text", text: `已离开房间「${ROOM}」，节点已删除。` }] };
  }
);

// 进程退出兜底
async function shutdown() { try { await doLeave(); } catch {} process.exit(0); }
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

const transport = new StdioServerTransport();
await server.connect(transport);
