// Cone geometry is shared; the visible choice changes only axial interpolation.
// Keep the hidden geometry select for the existing shared-condition bridge.
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
  scope.textContent = fdkText('回転中心からの評価位置 r を動かすと、その位置を通るX線と検出器列の関係が変わります。同じ撮影条件のまま、展開図の配置とSSPzへの現れ方を確認します。r はFOV内で調べる点の位置で、表示するFOVの大きさではありません。', 'Moving the evaluation position r away from the rotation center changes how rays and detector rows intersect that position. Keep the acquisition settings fixed and inspect the arrangement in the unwrapped diagram and its effect on SSPz. Here r locates the point within the FOV; it is not the displayed FOV size.');
  introduction.append(chip, scope);

  const ruleLabel = document.createElement('label');
  ruleLabel.className = 'model-choice-rule';
  ruleLabel.htmlFor = 'fdk-method';
  const ruleTitle = document.createElement('strong');
  ruleTitle.textContent = fdkText('体軸方向の補間規則を選ぶ', 'Choose the axial interpolation rule');
  const ruleSelect = document.createElement('select');
  ruleSelect.id = 'fdk-method';
  ruleSelect.name = 'axialRule';
  ruleSelect.add(new Option(fdkText('実・対向を分けて列間補間', 'Row interpolation by direction'), 'rri'));
  ruleSelect.add(new Option(fdkText('実・対向をまとめて2点補間', 'Combined two-point interpolation'), 'merged'));
  ruleSelect.value = fdkInterpolationRule(initial);
  ruleSelect.setAttribute('aria-describedby', 'model-choice-rule-description model-choice-rule-scope');
  ruleLabel.append(ruleTitle, ruleSelect);
  const ruleDescription = document.createElement('p');
  ruleDescription.id = 'model-choice-rule-description';
  ruleDescription.className = 'model-choice-rule-description';
  const ruleScope = document.createElement('p');
  ruleScope.id = 'model-choice-rule-scope';
  ruleScope.className = 'model-choice-rule-scope';
  ruleScope.textContent = fdkText('両者は同じコーン幾何・取得角度範囲・検出器開口・焦点寸法を使います。体軸補間の規則を比較する選択肢であり、2次元・3次元の画像再構成を行うものではありません。', 'Both use the same cone geometry, acquisition-angle support, detector aperture and focal size. These choices compare axial interpolation rules; they do not perform 2D or 3D image reconstruction.');

  const steps = document.createElement('ol');
  steps.className = 'model-choice-reading-steps';
  for (const [title, description] of [
    [
      fdkText('評価位置を動かす', 'Move the evaluation position'),
      fdkText('r = 0 mm が回転中心です。周辺へ動かすと、方向ごとの列間隔や実・対向データの位置関係が変わります。', 'r = 0 mm is the rotation center. Moving towards the periphery changes row spacing and the relation between direct and opposing data in each direction.'),
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
  diagramKey.textContent = fdkText('実・対向データを重ねる展開図は、横軸が体軸位置 z (mm)、縦軸が補間対象方向（上から下へ0～360°）です。色は検出器列、実線・○は実データ側、破線・△は対向データ側を示します。重み付きの点では、塗りの濃さが補間重み w を表します。', 'The paired unwrapped diagram uses axial position z (mm) horizontally and output interpolation direction vertically (0–360° from top to bottom). Color identifies detector rows. Solid lines and circles show direct data; dashed lines and triangles show opposing data. For weighted markers, fill intensity represents interpolation weight w.');
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
      definition: fdkText('列間補間：実・対向それぞれで隣接列に重みを付け、全体を正規化します（RRI相当）。2点補間：実・対向を合わせた候補から、目的断面の前後で最も近い2位置を選びます。同じ位置に複数のデータがあれば、その位置の重みを分けます。', 'Row interpolation: weight adjacent rows within each direct and opposing set, then normalize all valid weights (RRI-equivalent). Two-point interpolation: select the nearest positions on either side of the target plane from the combined candidates. Coincident data share the weight at that position.'),
      source: fdkText('列間補間：Hsiehら（2007）、図5・式(6)', 'Row interpolation: Hsieh et al. (2007), Fig.5 and Eq.(6)'),
      href: 'https://doi.org/10.1117/1.2746866',
      additionalSource: fdkText('隣接2点による補間：Taguchi・Aradate（1998）、式(6)・付録', 'Neighboring-sample interpolation: Taguchi and Aradate (1998), Eq.(6) and Appendix'),
      additionalHref: 'https://doi.org/10.1118/1.598230',
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
    if (entry.additionalHref) {
      const additional = document.createElement('p');
      const link = document.createElement('a');
      link.href = entry.additionalHref;
      link.textContent = entry.additionalSource;
      additional.append(link);
      cell.append(additional);
    }
  }
  searchRange.append(rangeTable);
  const limits = document.createElement('p');
  limits.textContent = fdkText('設定スライス厚 T は平均する幅であり、候補を探す距離の上限ではありません。列間補間では検出器端に存在する列の重みを正規化します。2点補間では目的断面を挟む2位置を要求します。必要な候補がなければ支持不足として停止します。取得範囲や重みの正規化は本モデルで採用した定義であり、引用文献の画像再構成全体を再現するものではありません。', 'Slice thickness T specifies the averaging width, not a candidate-distance limit. Row interpolation normalizes available detector-edge rows; two-point interpolation requires positions bracketing the target plane. Calculation stops when the necessary candidates are unavailable. Acquisition support and weight normalization are definitions adopted by this model, not a reproduction of the cited papers\' complete image reconstruction.');
  const sourceLink = document.createElement('a');
  sourceLink.href = fdkText('methods.html?topic=axial&lang=ja#rri-search-basis', 'methods.html?topic=axial&lang=en#rri-search-basis');
  sourceLink.textContent = fdkText('根拠文献・式・適用範囲', 'Sources, equations and applicability');
  details.append(summary, diagramKey, searchRange, limits, sourceLink);

  function sync() {
    select.value = 'fdk';
    element.dataset.model = 'fdk';
    ruleSelect.value = fdkInterpolationRule({method: ruleSelect.value});
    element.dataset.interpolationRule = ruleSelect.value;
    ruleDescription.textContent = ruleSelect.value === 'merged'
      ? fdkText('文献との比較用：実・対向を合わせ、目的断面の前後で最も近い2位置を線形補間します。幾何・取得範囲を保ったまま、候補の選び方を比較できます。', 'For literature comparisons: combine direct and opposing candidates and linearly interpolate the nearest positions on either side of the target plane. Compare candidate selection while retaining the geometry and acquisition support.')
      : fdkText('主解析：実・対向の各方向で、目的断面に隣接する列を線形補間し、有効な重み全体を正規化します。実測との比較には、この規則を用います。', 'Primary analysis: linearly interpolate adjacent rows within each direct and opposing set and normalize all valid weights. This is the rule used for comparison with measurements.');
  }
  select.addEventListener('change', () => {
    sync();
    if (typeof changed === 'function') changed('fdk');
  });
  ruleSelect.addEventListener('change', () => { sync(); if (typeof changed === 'function') changed(ruleSelect.value); });
  element.append(legend, select, introduction, ruleLabel, ruleDescription, ruleScope, steps, geometry, details);
  sync();
  return {element, select, sync};
}
