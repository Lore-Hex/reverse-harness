let input = "";
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
const prompt = String(request.messages.at(-1)?.content ?? "");
const context = `${prompt}|${process.env.TR_MODEL}|${process.env.TR_KIND}|${process.env.TR_API_KEY ?? "no-key"}`;
process.stdout.write(`${JSON.stringify({ delta: context })}\n`);
process.stdout.write(`${JSON.stringify({ delta: " done" })}\n`);
process.stdout.write(`${JSON.stringify({ done: true, usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } })}\n`);
