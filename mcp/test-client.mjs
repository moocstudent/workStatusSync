// 冒烟测试：用 MCP 客户端 spawn server.js，跑通 list/join/who/leave。
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "node",
  args: ["server.js"],
  cwd: process.cwd(),
  env: { ...process.env, WS_OWNER_UID: "u_jh6uuo4ompdseodo", WS_OWNER_NAME: "我", WS_AGENT_NAME: "Claude-MCP", WS_ROOM: "main" },
});

const client = new Client({ name: "smoke", version: "1.0.0" }, { capabilities: {} });
await client.connect(transport);

const tools = await client.listTools();
console.log("TOOLS:", tools.tools.map((t) => t.name).join(", "));

const j = await client.callTool({ name: "worksync_join", arguments: { task: "跑 MCP 冒烟测试" } });
console.log("\nJOIN ->\n" + j.content[0].text);

const w = await client.callTool({ name: "worksync_who", arguments: {} });
console.log("\nWHO ->\n" + w.content[0].text);

const l = await client.callTool({ name: "worksync_leave", arguments: {} });
console.log("\nLEAVE ->\n" + l.content[0].text);

await client.close();
process.exit(0);
