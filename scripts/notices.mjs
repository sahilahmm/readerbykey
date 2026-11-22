// Writes www/licenses.txt: the licence of every library that ships inside the app
// (Apache-2.0 and MIT both require the notice to travel with the app).
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const names = Object.keys(pkg.dependencies).sort();

let out = "Reader by Key uses these open-source libraries.\n\n";
for (const name of names) {
  const dir = join(root, "node_modules", name);
  const p = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const file = readdirSync(dir).find((f) => /^licen[cs]e(\.(md|txt))?$/i.test(f));
  out += `${"=".repeat(70)}\n${p.name} ${p.version} (${p.license})\n${p.homepage || ""}\n${"=".repeat(70)}\n`;
  out += file ? readFileSync(join(dir, file), "utf8").trim() + "\n\n" : "(see the package's repository for the licence text)\n\n";
}
writeFileSync(join(root, "www", "licenses.txt"), out);
console.log(`www/licenses.txt written (${names.length} packages)`);
