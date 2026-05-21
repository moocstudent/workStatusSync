// 常驻连接：用真实 MCP 客户端 spawn server.js，join 后保持在线（心跳由服务端维持）。
// Ctrl-C / kill 时服务端 SIGTERM -> worksync_leave 自动删节点。
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "node",
  args: ["server.js"],
  cwd: process.cwd(),
  // 身份用环境变量传入（不传则用 server.js 的默认值）：
  //   WS_OWNER_UID  你在页面「复制我的ID」拿到的 id（不传=显示成独立的"仅 AI 在线"卡）
  //   WS_OWNER_NAME 主人显示名    WS_AGENT_NAME 这个 agent 的名字    WS_ROOM 房间名
  env: { ...process.env, WS_ROOM: process.env.WS_ROOM || "main" },
});

const client = new Client({ name: "claude-code", version: "1.0.0" }, { capabilities: {} });
await client.connect(transport);
const j = await client.callTool({
  name: "worksync_join",
  arguments: { status: "working", task: "通过 MCP 连进 WorkSync 房间" },
});
console.log(j.content[0].text);
const accepting = process.env.WS_ACCEPTING !== "0"; // 默认接受提问；WS_ACCEPTING=0 关闭
await client.callTool({ name: "worksync_set", arguments: { accepting } });
console.log("\n[connect.mjs] 已连接并保持在线，心跳中… accepting=" + accepting + " (kill 本进程即自动离开房间)");

// 保持进程存活，服务端会每 15s 心跳
setInterval(() => {}, 1 << 30);
