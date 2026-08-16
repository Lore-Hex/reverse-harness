import { createInterface } from "node:readline";

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  const request = JSON.parse(line);
  const prompt = String(request.messages.at(-1)?.content ?? "");
  process.stdout.write(`${JSON.stringify({ delta: `${prompt}:persistent` })}\n`);
  process.stdout.write(`${JSON.stringify({ done: true })}\n`);
}
