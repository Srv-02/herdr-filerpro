// Writes the perf fixture: a Markdown file of exactly 200,000 characters with 20 different flowcharts.
//   node scripts/make-perf-fixture.mjs <out.md>
import fs from "node:fs";

export function perfFixture() {
  const parts = ["# Perf fixture\n\n"];
  for (let d = 0; d < 20; d++) {
    const nodes = 5 + Math.floor((25 * d) / 19), lines = ["```mermaid", "flowchart LR"];
    for (let i = 1; i < nodes; i++) lines.push(`  N${d}_${i - 1}["step ${d}.${i - 1}"] --> N${d}_${i}["step ${d}.${i}"]`);
    lines.push("```", "");
    parts.push(`## Section ${d}\n\nSome prose with **bold**, a [link](https://example.com) and \`code\`.\n\n`, lines.join("\n"), "\n");
  }
  let text = parts.join("");
  const filler = "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt.\n\n";
  while (text.length < 200000) text += filler;
  return text.slice(0, 200000);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  if (!process.argv[2]) { console.error("usage: node scripts/make-perf-fixture.mjs <out.md>"); process.exit(1); }
  fs.writeFileSync(process.argv[2], perfFixture());
}
