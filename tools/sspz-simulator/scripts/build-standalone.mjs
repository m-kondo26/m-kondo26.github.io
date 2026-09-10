import { readFile, writeFile } from "node:fs/promises";
import { finalizeEnglishHtml, translateEnglishSource } from "./english-replacements.mjs";

const stripImports = source => source.replace(/^import\s*\{[\s\S]*?\}\s*from\s*["']\.\/sim-core\.js["'];\s*/m, "");
const stripExports = source => source.replace(/^export\s+/gm, "");

const core = stripExports(await readFile(new URL("../sim-core.js", import.meta.url), "utf8"));
const worker = stripImports(await readFile(new URL("../worker.js", import.meta.url), "utf8"));
const app = (await readFile(new URL("../shape-export.js", import.meta.url), "utf8")) + '\n' + stripImports(await readFile(new URL("../app.js", import.meta.url), "utf8"));
const indexHtml = await readFile(new URL("../index.html", import.meta.url), "utf8");

const workerBundle = `"use strict";\n${core}\n${worker}\n`;
const appBundle = `(() => {\n"use strict";\n${core}\n${app}\n})();\n`;
const workerSource = `globalThis.SSPZ_WORKER_SOURCE = ${JSON.stringify(workerBundle)};\n`;
const englishCore = translateEnglishSource(core);
const englishWorker = translateEnglishSource(worker);
const englishApp = translateEnglishSource(app);
const englishWorkerBundle = `"use strict";\n${englishCore}\n${englishWorker}\n`;
const englishAppBundle = `(() => {\n"use strict";\n${englishCore}\n${englishApp}\n})();\n`;
const englishWorkerSource = `globalThis.SSPZ_WORKER_SOURCE = ${JSON.stringify(englishWorkerBundle)};\n`;
const englishHtml = finalizeEnglishHtml(indexHtml);

await writeFile(new URL("../worker-source.js", import.meta.url), workerSource, "utf8");
await writeFile(new URL("../app-bundle.js", import.meta.url), appBundle, "utf8");
await writeFile(new URL("../worker-en.js", import.meta.url), englishWorkerBundle, "utf8");
await writeFile(new URL("../worker-source-en.js", import.meta.url), englishWorkerSource, "utf8");
await writeFile(new URL("../app-bundle-en.js", import.meta.url), englishAppBundle, "utf8");
await writeFile(new URL("../index-en.html", import.meta.url), englishHtml, "utf8");
console.log("Built Japanese and English bundles for direct file:// and HTTP use.");
