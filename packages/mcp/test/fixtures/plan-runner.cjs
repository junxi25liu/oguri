// A runner that does what an agent would: start oguri's MCP server the way a
// run does (OGURI_TASK_ID in its environment), split its task with
// `oguri_task action=plan`, and write result.json. Used by
// task-run-tools.test.ts; argv[2] is the built CLI.
const { spawn } = require("node:child_process");
const fs = require("node:fs");

process.stdin.resume();
process.stdin.on("end", () => {
  const child = spawn(process.execPath, [process.argv[2], "mcp", "--direct"], {
    env: process.env,
    stdio: ["pipe", "pipe", "inherit"],
  });
  const send = (message) =>
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let index = buffer.indexOf("\n");
    while (index !== -1) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf("\n");
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message.id === 1) {
        send({ method: "notifications/initialized", params: {} });
        send({
          id: 2,
          method: "tools/call",
          params: {
            name: "oguri_task",
            arguments: {
              action: "plan",
              plan: {
                title: "Split",
                tasks: [
                  { key: "a", title: "Part A", body: "Do A." },
                  { key: "b", title: "Part B", body: "Do B.", dependsOn: ["a"] },
                ],
              },
            },
          },
        });
      } else if (message.id === 2) {
        const ok = message.result?.isError !== true;
        const text = (message.result?.content ?? []).map((part) => part.text).join("");
        fs.writeFileSync(
          process.env.OGURI_RESULT_FILE,
          JSON.stringify({ summary: ok ? "Split into two subtasks." : `plan refused: ${text}` }),
        );
        console.log(text);
        child.kill();
        process.exit(ok ? 0 : 1);
      }
    }
  });
  send({
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "plan-runner", version: "1.0.0" },
    },
  });
});
