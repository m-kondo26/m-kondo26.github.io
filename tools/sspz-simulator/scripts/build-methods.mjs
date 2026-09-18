import { readFile, writeFile } from 'node:fs/promises';

const topics = {
  aperture: { ja: ['開口幅と計算方法', '検出器の開口幅'], en: ['Detector aperture and calculation methods', 'Detector aperture'] },
  axial: { ja: ['体軸方向の補間とモデルSSPz', '補間とSSPz'], en: ['Axial interpolation and model SSPz', 'Interpolation and SSPz'] },
  focus: { ja: ['焦点ボケの計算方法', '焦点ボケ'], en: ['Focal-blur calculation', 'Focal blur'] },
  zffs: { ja: ['焦点の交互移動と倍密度サンプリング', '焦点の交互移動'], en: ['Alternating focal positions and denser sampling', 'Alternating focal positions'] },
  static: { ja: ['寝台静止時の再構成位置とSSPz', '寝台静止時の参照計算'], en: ['Reconstruction positions and SSPz with a stationary table', 'Stationary-table reference'] }
};

export async function buildMethods() {
  const result = {};
  for (const [key, languages] of Object.entries(topics)) {
    result[key] = {};
    for (const [lang, [title, label]] of Object.entries(languages)) {
      const html = await readFile(new URL(`../docs/content/${key}-${lang}.html`, import.meta.url), 'utf8');
      if (/<(?:script|br)\b/i.test(html) || /href=["'][^"']+\.md(?:["'?#])/i.test(html)) {
        throw new Error(`Reader guide ${key}-${lang} contains script, forced line breaks or raw Markdown links`);
      }
      result[key][lang] = { title, label, html };
    }
  }
  await writeFile(new URL('../methods-content.js', import.meta.url), `globalThis.SSPZ_METHODS = ${JSON.stringify({ topics: result })};\n`, 'utf8');
}
