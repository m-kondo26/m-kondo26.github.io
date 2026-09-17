import { readFile, writeFile } from "node:fs/promises";
import { finalizeEnglishHtml, translateEnglishSource } from "./english-replacements.mjs";

const stripImports = source => source.replace(/^import\s*\{[\s\S]*?\}\s*from\s*["']\.\/(?:sim-core|fdk-core|cba-core|detector-aperture|axial-response-core)\.js["'];\s*/gm, "");
const stripExports = source => source.replace(/^export\s+/gm, "");

const detector = stripExports(await readFile(new URL("../detector-aperture.js", import.meta.url), "utf8"));
const core = detector+'\n'+stripExports(stripImports(await readFile(new URL("../sim-core.js", import.meta.url), "utf8")));
const fdk = stripExports(stripImports(await readFile(new URL("../fdk-core.js", import.meta.url), "utf8")));
const cba = stripExports(stripImports(await readFile(new URL("../cba-core.js", import.meta.url), "utf8")));
const axialResponse=stripExports(stripImports(await readFile(new URL("../axial-response-core.js",import.meta.url),'utf8')));
const worker = stripImports(await readFile(new URL("../worker.js", import.meta.url), "utf8"));
const shapeExport=await readFile(new URL("../shape-export.js", import.meta.url), "utf8");
const shapeDisplay=await readFile(new URL("../shape-display.js", import.meta.url), "utf8");
const fdkUi=(await readFile(new URL("../fdk-workflow.js", import.meta.url), "utf8"))+'\n'+(await readFile(new URL("../fdk-ui.js", import.meta.url), "utf8"));
const mainApp=stripImports(await readFile(new URL("../app.js", import.meta.url), "utf8"));
const app = shapeExport + '\n' + shapeDisplay + '\n' + fdkUi + '\n' + mainApp;
const indexHtml = await readFile(new URL("../index.html", import.meta.url), "utf8");

const workerBundle = `"use strict";\n${core}\n${fdk}\n${cba}\n${axialResponse}\n${worker}\n`;
const appBundle = `(() => {\n"use strict";\n${core}\n${app}\n})();\n`;
const workerSource = `globalThis.SSPZ_WORKER_SOURCE = ${JSON.stringify(workerBundle)};\n`;
const englishCore = translateEnglishSource(core);
const englishWorker = translateEnglishSource(worker);
// FDK UI strings have explicit Japanese/English alternatives. Remove only
// Japanese string literals in the English build; the English branch remains.
const englishFdkUi=fdkUi.replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g, literal=>/[ぁ-んァ-ヶ一-龠々〇]/.test(literal)?"''":literal);
const englishApp = translateEnglishSource(shapeExport+'\n'+shapeDisplay+'\n'+englishFdkUi+'\n'+mainApp);
const englishWorkerBundle = `"use strict";\n${englishCore}\n${fdk}\n${cba}\n${axialResponse}\n${englishWorker}\n`;
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
