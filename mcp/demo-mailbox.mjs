// 自包含冒烟测试：信箱 inbox/answer 全流程（隔离的 owner/agent，跑完自清理）。
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { initializeApp } from "firebase/app";
import { getDatabase, ref, set } from "firebase/database";

// 配置从环境变量读取（不再内置任何凭证）：WS_FIREBASE_CONFIG（JSON）或 WS_DATABASE_URL
const CONFIG = process.env.WS_FIREBASE_CONFIG ? JSON.parse(process.env.WS_FIREBASE_CONFIG)
  : (process.env.WS_DATABASE_URL ? { databaseURL: process.env.WS_DATABASE_URL, apiKey: process.env.WS_API_KEY, projectId: process.env.WS_PROJECT_ID } : null);
if (!CONFIG) { console.error("请先设置 WS_FIREBASE_CONFIG（完整 JSON）或 WS_DATABASE_URL 再运行。"); process.exit(1); }
const ROOM = "main", OWNER = "u_demo_owner", AID = "demo-agent";

const db = getDatabase(initializeApp(CONFIG));
const qid = "q_" + Date.now().toString(36);
// 模拟一个"提问者"写进信箱
await set(ref(db, `rooms/${ROOM}/qa/${OWNER}/${AID}/${qid}`), {
  fromUid: "u_tester", fromName: "测试提问者", question: "你现在在忙什么？", qts: Date.now(),
});

const transport = new StdioClientTransport({
  command: "node", args: ["server.js"], cwd: process.cwd(),
  env: { ...process.env, WS_ROOM: ROOM, WS_OWNER_UID: OWNER, WS_AGENT_ID: AID, WS_AGENT_NAME: "DemoBot" },
});
const client = new Client({ name: "demo", version: "1.0.0" }, { capabilities: {} });
await client.connect(transport);

await client.callTool({ name: "worksync_join", arguments: { task: "演示信箱" } });
await client.callTool({ name: "worksync_set", arguments: { accepting: true } });

const before = await client.callTool({ name: "worksync_inbox", arguments: {} });
console.log("INBOX(回答前) ->\n" + before.content[0].text);

await client.callTool({ name: "worksync_answer", arguments: { qid, answer: "我在跑信箱功能的冒烟测试。" } });

const after = await client.callTool({ name: "worksync_inbox", arguments: { includeAnswered: true } });
console.log("\nINBOX(回答后, 含已答) ->\n" + after.content[0].text);

await client.callTool({ name: "worksync_leave", arguments: {} });
await set(ref(db, `rooms/${ROOM}/qa/${OWNER}/${AID}`), null); // 清理
await client.close();
process.exit(0);
