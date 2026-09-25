// The normal workflow uses cone geometry. Keep the hidden select as the
// existing parameter bridge so reset and shared-condition controls still work.
function initializeAxialModelChoice(initial = 'fdk', changed) {
  const element = document.createElement('fieldset');
  element.className = 'model-choice';
  const legend = document.createElement('legend');
  legend.textContent = fdkText('評価位置によって、データの並びはどう変わる？', 'How does evaluation position change the data arrangement?');
  const select = document.createElement('select');
  select.id = 'computationModel';
  select.name = 'computationModel';
  select.hidden = true;
  select.add(new Option(fdkText('コーン幾何', 'Cone geometry'), 'fdk'));

  const introduction = document.createElement('div');
  introduction.className = 'model-choice-introduction';
  const chip = document.createElement('span');
  chip.className = 'model-choice-chip';
  chip.textContent = fdkText('コーン幾何で計算', 'Calculated with cone geometry');
  const scope = document.createElement('p');
  scope.className = 'model-choice-scope';
  scope.textContent = fdkText('回転中心からの評価位置 r を動かすと、その位置を通るX線と検出器列の関係が変わります。同じ撮影条件のまま、展開図の配置とSSPzへの現れ方を確認します。r はFOV内で調べる点の位置で、表示するFOVの大きさではありません。', 'Moving the evaluation position r away from the rotation centre changes how rays and detector rows intersect that position. Keep the acquisition settings fixed and inspect the arrangement in the unwrapped diagram and its effect on SSPz. Here r locates the point within the FOV; it is not the displayed FOV size.');
  introduction.append(chip, scope);

  const steps = document.createElement('ol');
  steps.className = 'model-choice-reading-steps';
  for (const [title, description] of [
    [
      fdkText('評価位置を動かす', 'Move the evaluation position'),
      fdkText('r = 0 mm が回転中心です。周辺へ動かすと、方向ごとの列間隔や実・対向データの位置関係が変わります。', 'r = 0 mm is the rotation centre. Moving towards the periphery changes row spacing and the relation between direct and opposing data in each direction.'),
    ],
    [
      fdkText('展開図で配置と重みを読む', 'Read positions and weights in the diagram'),
      fdkText('同じ開始角度で、列の軌跡、目的断面の前後で補間に使う点、その重みを確認します。', 'At the same start angle, inspect the row trajectories, the samples used around the target plane and their interpolation weights.'),
    ],
    [
      fdkText('SSPzへの現れ方を見る', 'Inspect the resulting SSPz'),
      fdkText('同じ位置のSSPzを確認します。配置が変わっても、補間・平均後の形状や幅が同じ程度に変わるとは限りません。', 'Inspect SSPz at that position. A change in arrangement need not produce a comparable change in profile shape or width after interpolation and averaging.'),
    ],
  ]) {
    const step = document.createElement('li');
    const heading = document.createElement('strong');
    heading.textContent = title;
    const text = document.createElement('p');
    text.textContent = description;
    step.append(heading, text);
    steps.append(step);
  }

  const geometry = document.createElement('p');
  geometry.className = 'model-choice-geometry';
  const geometryTitle = document.createElement('strong');
  geometryTitle.textContent = fdkText('展開図の幾何：', 'Diagram geometry: ');
  geometry.append(geometryTitle, document.createTextNode(fdkText('面内はファンパラ変換後の方向で整理し、体軸方向はコーン角による広がりを反映します。ファンパラ変換をしても、体軸方向の広がりは残ります。', 'Transverse rays are organized by their directions after fan-to-parallel rebinning; axial divergence from the cone angle is retained. Fan-to-parallel rebinning does not remove axial divergence.')));

  const details = document.createElement('details');
  details.className = 'model-choice-notes';
  const summary = document.createElement('summary');
  summary.textContent = fdkText('展開図の読み方・補間方法と根拠', 'Diagram key, interpolation and sources');
  const diagramKey = document.createElement('p');
  diagramKey.textContent = fdkText('実・対向データを重ねる展開図は、横軸が体軸位置 z (mm)、縦軸が補間対象方向（上から下へ0～360°）です。色は検出器列、実線・○は実データ側、破線・△は対向データ側を示します。重み付きの点では、塗りの濃さが補間重み w を表します。', 'The paired unwrapped diagram uses axial position z (mm) horizontally and output interpolation direction vertically (0–360° from top to bottom). Colour identifies detector rows. Solid lines and circles show direct data; dashed lines and triangles show opposing data. For weighted markers, fill intensity represents interpolation weight w.');
  const searchRange = document.createElement('div');
  searchRange.className = 'model-choice-range';
  const rangeTable = document.createElement('table');
  rangeTable.createCaption().textContent = fdkText('補間候補の範囲', 'Interpolation candidate support');
  const headRow = rangeTable.createTHead().insertRow();
  for (const text of [fdkText('範囲', 'Range'), fdkText('現在の定義と根拠', 'Current definition and basis')]) {
    const cell = document.createElement('th');
    cell.scope = 'col';
    cell.textContent = text;
    headRow.append(cell);
  }
  const rangeBody = rangeTable.createTBody();
  for (const entry of [
    {
      title: fdkText('重みを付ける列の範囲', 'Rows receiving weight'),
      definition: fdkText('実・対向それぞれで、目的断面に隣接する列を線形補間します（RRI相当）。対象位置・方向ごとの列間隔 s より近い列に重みが付きます。点数は常に4点とは限りません。', 'Linearly interpolate adjacent rows around the target plane on each direct and opposing side (RRI-equivalent). Rows closer than the local spacing s receive weight; s varies with position and direction. The number of points is not always four.'),
      source: fdkText('Hsiehら（2007）：p.067001-2、図5・式(6)', 'Hsieh et al. (2007): p.067001-2, Fig.5 and Eq.(6)'),
      href: 'https://doi.org/10.1117/1.2746866',
    },
    {
      title: fdkText('探索する取得角度の範囲', 'Acquired angles searched'),
      definition: fdkText('360°＋全ファン角の2倍。古典的な対向ビーム補間を参照して採用した範囲です。全ファン角50°なら460°です。', '360° plus twice the full fan opening, adopted with reference to classical opposing-beam interpolation. A 50° full opening gives 460°.'),
      source: fdkText('Toki：EP0450152B1、図4～6・図10B', 'Toki: EP0450152B1, Figs.4–6 and 10B'),
      href: 'https://patents.google.com/patent/EP0450152B1/en',
    },
  ]) {
    const row = rangeBody.insertRow();
    const title = document.createElement('th');
    title.scope = 'row';
    title.textContent = entry.title;
    row.append(title);
    const cell = row.insertCell();
    const definition = document.createElement('p');
    definition.textContent = entry.definition;
    const source = document.createElement('a');
    source.href = entry.href;
    source.textContent = entry.source;
    cell.append(definition, source);
  }
  searchRange.append(rangeTable);
  const limits = document.createElement('p');
  limits.textContent = fdkText('設定スライス厚 T は平均する幅であり、候補を探す距離の上限ではありません。検出器端では存在する列の重みを正規化し、重みが付く列がなければ支持不足として停止します。取得角度範囲の多列への適用、検出器端や複数回転の重みの正規化は本モデルで採用した定義です。これは体軸方向の応答モデルであり、画像再構成は行いません。', 'Slice thickness T specifies the averaging width, not a candidate-distance limit. Available detector-edge rows are normalized; if none receives weight, calculation stops for insufficient support. Applying this angular interval to multiple rows and normalizing detector-edge and multiple-turn weights are definitions adopted by this model. This is an axial response model without image reconstruction.');
  const sourceLink = document.createElement('a');
  sourceLink.href = fdkText('methods.html?topic=axial&lang=ja#rri-search-basis', 'methods.html?topic=axial&lang=en#rri-search-basis');
  sourceLink.textContent = fdkText('根拠文献・式・適用範囲', 'Sources, equations and applicability');
  details.append(summary, diagramKey, searchRange, limits, sourceLink);

  function sync() {
    // Old saved conditions can still request a removed model. The UI and
    // parameter bridge always represent the cone-geometry workflow.
    select.value = 'fdk';
    element.dataset.model = 'fdk';
  }
  select.addEventListener('change', () => {
    sync();
    if (typeof changed === 'function') changed('fdk');
  });
  element.append(legend, select, introduction, steps, geometry, details);
  sync();
  return {element, select, sync};
}
