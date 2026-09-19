// Method selection only. The retained select is the public parameter bridge;
// the cards never alter acquisition settings or scientific calculations.
function initializeAxialModelChoice(initial = 'axial', changed) {
  const element = document.createElement('fieldset');
  element.className = 'model-choice';
  const initialValue = typeof initial === 'string' ? initial : initial?.computationModel;
  const methods = [
    {
      value: 'axial', number: '①',
      title: fdkText('実・対向をまとめて2点を選ぶ', 'Select two points from both directions'),
      chip: fdkText('コーン幾何', 'Cone geometry'),
      description: fdkText('実・対向データから、断面の前後で最も近い2位置を選びます。', 'Pool direct and complementary data, then select the nearest position on either side of the plane.'),
      detail: fdkText('同じ位置に複数のデータがある場合は、その位置の重みを分けます。', 'When several data occupy the same position, they share that position’s weight.'),
    },
    {
      value: 'fdk', number: '②',
      title: fdkText('実・対向を分けて列間補間', 'Interpolate rows in each direction'),
      chip: fdkText('コーン幾何', 'Cone geometry'),
      description: fdkText('取得範囲内で、方向別に目的断面の前後の隣接列を補間します。重みが付くのは、対象位置での列間隔より近い列です。', 'Within the acquisition interval, interpolate adjacent rows around the plane in each direction. Only rows closer than one row spacing at the target position receive weight.'),
      detail: fdkText('RRI相当（row-to-row interpolation）の線形補間です。点数は常に4点とは限りません。', 'This is RRI-equivalent linear interpolation (row-to-row interpolation). The number of points is not always four.'),
    },
    {
      value: 'parallel', number: '③',
      title: fdkText('発散なしで2点を選ぶ', 'Select two points without divergence'),
      chip: fdkText('比較基準', 'Reference'),
      description: fdkText('面内・体軸方向ともX線が広がらない幾何を仮定し、①と同じ2点選択を行います。', 'Assume no X-ray divergence in either direction and apply the same two-position selection as in ①.'),
      detail: fdkText('取得角度範囲も異なります。①との比較は、コーン角だけの影響を分離するものではありません。', 'The acquisition-angle support also differs. Comparing with ① does not isolate the cone-angle effect alone.'),
    },
  ];
  const legend = document.createElement('legend');
  legend.textContent = fdkText('体軸補間モデルを選ぶ', 'Choose an axial interpolation model');
  const scope = document.createElement('p');
  scope.className = 'model-choice-scope';
  scope.textContent = fdkText('候補データの選び方と重みが、モデルSSPzにどう影響するかを比較します。', 'Compare how candidate selection and weighting affect the model SSPz.');
  const select = document.createElement('select');
  select.id = 'computationModel';
  select.name = 'computationModel';
  select.hidden = true;
  const grid = document.createElement('div');
  grid.className = 'model-choice-grid';
  const radios = [];
  for (const method of methods) {
    select.add(new Option(method.title, method.value));
    const card = document.createElement('label');
    card.className = 'model-choice-card';
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'axialModelChoice';
    radio.value = method.value;
    radio.id = `axial-model-${method.value}`;
    radio.setAttribute('aria-labelledby', `${radio.id}-title`);
    radio.setAttribute('aria-describedby', `${radio.id}-description`);
    const heading = document.createElement('span');
    heading.className = 'model-choice-heading';
    const title = document.createElement('span');
    title.id = `${radio.id}-title`;
    title.className = 'model-choice-title';
    title.textContent = `${method.number} ${method.title}`;
    heading.append(radio, title);
    const chip = document.createElement('span');
    chip.className = 'model-choice-chip';
    chip.textContent = method.chip;
    const description = document.createElement('span');
    description.id = `${radio.id}-description`;
    description.className = 'model-choice-description';
    description.textContent = method.description;
    const diagram = document.createElement('span');
    diagram.className = 'model-choice-diagram';
    diagram.innerHTML = method.value === 'parallel' ? axialModelParallelSketch() : axialModelCandidateSketch(method.value);
    const detail = document.createElement('span');
    detail.className = 'model-choice-detail';
    detail.textContent = method.detail;
    card.append(heading, chip, description, diagram, detail);
    radio.addEventListener('change', () => {
      if (!radio.checked) return;
      select.value = radio.value;
      select.dispatchEvent(new Event('change', {bubbles: true}));
    });
    radios.push({radio, card, method});
    grid.append(card);
  }
  const note = document.createElement('p');
  note.className = 'model-choice-sketch-note';
  note.textContent = fdkText('模式図：点の上は重み w、下は位置 z（mm）です。塗りつぶした点を選択し、各図の重みの合計は1です。①②は2方向・各2列の例で、現在の入力値による結果ではありません。', 'Schematics: weight w is above each point; position z (mm) is below. Filled points are selected; weights sum to 1 in each diagram. These two-direction, two-row examples are not results for the current inputs.');
  const comparison = document.createElement('p');
  comparison.className = 'model-choice-comparison';
  const pairRule = document.createElement('span');
  pairRule.textContent = fdkText('①↔②：同じ取得データで補間規則を比較。', '①↔②: compare interpolation rules using the same acquired data.');
  const pairReference = document.createElement('span');
  pairReference.textContent = fdkText('①↔③：発散なしの比較基準との差を見る。', '①↔③: compare against the nondivergent reference.');
  comparison.append(pairRule, pairReference);
  const details = document.createElement('details');
  details.className = 'model-choice-notes';
  const summary = document.createElement('summary');
  summary.textContent = fdkText('候補を探す範囲・模式図の補足', 'Candidate search limits and schematic details');
  const searchLimits = document.createElement('ul');
  for (const text of [
    fdkText('①②共通：評価する断面を基準に、X線管角360°＋全ファン角の2倍の取得範囲から探します。全ファン角50°なら460°です。', 'For ① and ②, search acquired tube angles over 360° plus twice the full fan opening, centred on the evaluation plane. A 50° full opening gives a 460° interval.'),
    fdkText('②：各方向・各回転について、目的断面に隣接する取得済みの列を使います。その方向の列間隔を対象位置へ投影した幅より遠い列、またはちょうどその距離の列は重み0です。列間隔1 mmなら距離1 mm未満が対象です。', 'For ②, use acquired adjacent rows in each supported direction and turn. A row at or beyond one target-projected row spacing from the plane has zero weight. With a 1 mm projected spacing, only distances below 1 mm contribute.'),
    fdkText('①：同じ取得範囲内で断面を挟む最近傍の2位置を選びます。②のような列間隔による距離制限はありません。', 'For ①, select the nearest bracketing positions within the same acquisition interval. There is no row-spacing distance limit as in ②.'),
    fdkText('設定スライス厚Tは平均する幅であり、候補を探す距離の上限ではありません。②の検出器端では存在する列だけを使って重みを正規化し、どの列にも重みが付かなければ支持不足として停止します。', 'Configured thickness T is the averaging width, not a candidate-distance limit. At detector edges, ② normalizes weights over available rows; if no row has positive weight, calculation stops for insufficient support.'),
  ]) { const item = document.createElement('li'); item.textContent = text; searchLimits.append(item); }
  const searchBasis = document.createElement('p');
  searchBasis.append(document.createTextNode(fdkText('範囲の根拠：②の局所範囲はHsiehら（2007）の隣接列間の線形補間、取得角度範囲は古典的な対向ビーム補間の説明を参照しています。検出器端の処理と複数回転の合成は、本モデルで定義しています。', 'Basis: the local range in ② follows adjacent-row linear interpolation described by Hsieh et al. (2007). The acquisition-angle interval refers to classical opposing-beam interpolation. Detector-edge handling and combination across turns are defined by this model.')));
  const searchBasisLink = document.createElement('a');
  searchBasisLink.href = fdkText('methods.html?topic=axial&lang=ja#rri-search-basis', 'methods.html?topic=axial&lang=en#rri-search-basis');
  searchBasisLink.textContent = fdkText('根拠文献・式・適用範囲', 'Sources, equations and applicability');
  searchBasis.append(document.createTextNode(' '), searchBasisLink);
  const detailText = document.createElement('p');
  detailText.textContent = fdkText('①②の模式図は、実データの位置 −0.8、+0.2 mm、対向データの位置 −0.3、+0.7 mm、目的断面 0 mm の例です。①は −0.3、+0.2 mm の2位置を選び、②は4点に重みを付けます。実際には、同一位置のデータ、隣接回転や焦点移動、検出器端の条件によって点数や合成比が変わります。③の取得角度範囲は360°、①②は360°＋全ファン角の2倍です。いずれも体軸方向の応答モデルで、画像再構成は行いません。', 'In schematics ① and ②, direct data lie at −0.8 and +0.2 mm, complementary data at −0.3 and +0.7 mm, and the target plane at 0 mm. Method ① selects −0.3 and +0.2 mm; method ② weights all four points. Coincident data, neighboring turns, focal shifts and detector boundaries can change the point count and combined weights. The acquisition-angle support is 360° for ③ and 360° plus twice the full fan angle for ① and ②. All three are axial response models, without image reconstruction.');
  const weightExplanation = document.createElement('p');
  weightExplanation.textContent = fdkText('この例では、①は位置 −0.3 mm に重み0.40、+0.2 mm に0.60を付けます。②は実データ −0.8/+0.2 mm に0.10/0.40、対向データ −0.3/+0.7 mm に0.35/0.15を付けます。同じ補間ペアでは近い側ほど重みが大きくなります。②では各方向の列間隔を基準に重みを決めるため、異なる方向の点どうしは距離だけで重みを比較できません。', 'In this example, ① assigns weights 0.40 and 0.60 to positions −0.3 and +0.2 mm. In ②, the direct positions −0.8/+0.2 mm receive 0.10/0.40, and the complementary positions −0.3/+0.7 mm receive 0.35/0.15. Within an interpolation pair, the nearer point has greater weight. In ② the row spacing in each direction sets the weights, so distance alone does not determine weight across different directions.');
  details.append(summary, searchLimits, searchBasis, detailText, weightExplanation);
  const selected = document.createElement('p');
  selected.className = 'model-choice-selected';
  selected.setAttribute('aria-live', 'polite');
  selected.setAttribute('aria-atomic', 'true');
  function sync() {
    if (!methods.some(method => method.value === select.value)) select.value = 'axial';
    for (const entry of radios) {
      const active = entry.radio.value === select.value;
      entry.radio.checked = active;
      entry.card.classList.toggle('is-selected', active);
      if (active) selected.textContent = fdkText('選択中：', 'Selected: ') + `${entry.method.number} ${entry.method.title}`;
    }
    element.dataset.model = select.value;
  }
  select.value = methods.some(method => method.value === initialValue) ? initialValue : 'axial';
  select.addEventListener('change', () => {sync();if (typeof changed === 'function') changed(select.value);});
  element.append(legend, scope, select, grid, note, comparison, details, selected);
  sync();
  return {element, select, sync};
}

function axialModelCandidateSketch(model) {
  const id = `model-choice-sketch-${model}`;
  const title = model === 'axial'
    ? fdkText('①：目的断面を挟む最も近い2位置を選択', '①: select the nearest position on each side of the target plane')
    : fdkText('②：各方向の隣接列を補間し、4点に重みを付与する例', '②: interpolate adjacent rows in each direction; this example weights four points');
  const x = z => 170 + 75 * z;
  const point = (z, y, direction, weight) => {
    const px = x(z), color = direction ? '#b55b13' : '#2166a5', fill = weight > 0 ? color : '#fff';
    const shape = direction
      ? `<path d="M${px},${y-6} L${px-6.5},${y+5.5} L${px+6.5},${y+5.5} Z"/>`
      : `<circle cx="${px}" cy="${y}" r="5.5"/>`;
    return `<g class="model-choice-sample" data-z="${z}" data-weight="${weight}"><g stroke="${color}" fill="${fill}" stroke-width="1.8">${shape}</g><text class="model-choice-weight" x="${px}" y="${y-18}" text-anchor="middle">w = ${weight.toFixed(2)}</text><text class="model-choice-position" x="${px}" y="${y+22}" text-anchor="middle">z = ${z > 0 ? '+' : '−'}${Math.abs(z).toFixed(1)}</text></g>`;
  };
  const rowWeights = model === 'fdk' ? [.10,.40,.35,.15] : [0,.60,.40,0];
  return `<svg viewBox="0 0 290 166" role="img" aria-labelledby="${id}-title"><title id="${id}-title">${title}</title>
    <line x1="170" y1="23" x2="170" y2="148" stroke="#b61d37" stroke-width="1.6"/>
    <text x="170" y="16" text-anchor="middle" fill="#a51a31">${fdkText('目的断面 z = 0', 'Target plane z = 0')}</text>
    <text x="5" y="60">${fdkText('実データ', 'Direct')}</text><text x="5" y="125">${fdkText('対向データ', 'Opposing')}</text>
    <line x1="99" y1="55" x2="257" y2="55" stroke="#c7d5e1" stroke-width="1"/>
    <line x1="99" y1="120" x2="257" y2="120" stroke="#e3d1c1" stroke-width="1" stroke-dasharray="4 3"/>
    ${point(-.8,55,0,rowWeights[0])}${point(.2,55,0,rowWeights[1])}${point(-.3,120,1,rowWeights[2])}${point(.7,120,1,rowWeights[3])}
    <text x="279" y="162" text-anchor="end" fill="#596b79">${fdkText('位置 z (mm)', 'Position z (mm)')}</text></svg>`;
}

function axialModelParallelSketch() {
  const id = 'model-choice-sketch-parallel';
  return `<svg viewBox="0 0 290 126" role="img" aria-labelledby="${id}-title"><title id="${id}-title">${fdkText('③：面内・体軸方向とも発散しない平行なX線の模式図', '③: schematic rays with no transverse or axial divergence')}</title>
    <text x="145" y="16" text-anchor="middle">${fdkText('X線は平行', 'Parallel X-rays')}</text>
    <g stroke="#638094" stroke-width="1.8" fill="none"><path d="M42 42 H248 M42 68 H248 M42 94 H248"/><path d="M238 37 L248 42 L238 47 M238 63 L248 68 L238 73 M238 89 L248 94 L238 99"/></g>
    <text x="145" y="119" text-anchor="middle" fill="#596b79">${fdkText('2点の選び方は①と共通', 'Same two-position selection as ①')}</text></svg>`;
}
