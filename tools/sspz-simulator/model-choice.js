// Method selection only. The retained select is the public parameter bridge;
// the cards never alter acquisition settings or scientific calculations.
function initializeAxialModelChoice(initial = 'fdk', changed) {
  const element = document.createElement('fieldset');
  element.className = 'model-choice';
  const initialValue = typeof initial === 'string' ? initial : initial?.computationModel;
  const methods = [
    {
      value: 'fdk', number: '①',
      title: fdkText('コーン幾何を反映する', 'Include cone geometry'),
      chip: fdkText('コーン幾何', 'Cone geometry'),
      description: fdkText('取得範囲内で、方向別に目的断面の前後の隣接列を補間します。重みが付くのは、対象位置での列間隔より近い列です。', 'Within the acquisition interval, interpolate adjacent rows around the plane in each direction. Only rows closer than one row spacing at the target position receive weight.'),
      detail: fdkText('RRI相当（row-to-row interpolation）の線形補間です。点数は常に4点とは限りません。', 'This is RRI-equivalent linear interpolation (row-to-row interpolation). The number of points is not always four.'),
    },
    {
      value: 'parallel', number: '②',
      title: fdkText('発散なしの基準と比較する', 'Use the nondivergent reference'),
      chip: fdkText('比較基準', 'Reference'),
      description: fdkText('面内・体軸方向ともX線が広がらない幾何を仮定し、①と同じ列間補間・取得角度範囲を使います。', 'Assume no transverse or axial divergence, with the same row interpolation and acquisition-angle support as ①.'),
      detail: fdkText('寝台移動・検出器開口・回転中心換算の焦点ぼけは残します。列間隔は回転中心の値で一定です。', 'Table motion, detector aperture and isocentre-projected focal blur are retained. Row spacing stays at its isocentre value.'),
    },
  ];
  const legend = document.createElement('legend');
  legend.textContent = fdkText('体軸補間モデルを選ぶ', 'Choose an axial interpolation model');
  const scope = document.createElement('p');
  scope.className = 'model-choice-scope';
  scope.textContent = fdkText('同じ列間補間・取得角度範囲で、X線の発散が候補の位置・重みとシミュレーションによるSSPzに与える影響を比較します。', 'Use matched row interpolation and acquisition support to compare how ray divergence affects candidate positions, interpolation weights and simulated SSPz.');
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
    diagram.innerHTML = axialModelCandidateSketch(method.value);
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
  note.textContent = fdkText('左右は同じ条件・同じ縮尺の模式図です。○は実データ、△は対向データ。点の上は重みw、下は位置z（mm）です。共通例：4列×1 mm、ピッチ1、回転中心から150 mm。幅Tで平均する前の一組の方向を示しており、現在の入力値による計算結果ではありません。', 'Both schematics use the same conditions and scale. Circles denote direct data; triangles denote opposing data. Weight w is above each point; position z (mm) is below. Shared example: 4 × 1 mm rows, pitch 1, radius 150 mm. One direction pair is shown before averaging over T; these are not results for the current inputs.');
  const comparison = document.createElement('p');
  comparison.className = 'model-choice-comparison';
  const pairRule = document.createElement('span');
  pairRule.textContent = fdkText('①↔②：列間補間と取得角度範囲をそろえて、幾何の違いを比較。', '①↔②: compare geometry with matched row interpolation and acquisition-angle support.');
  const pairReference = document.createElement('span');
  pairReference.textContent = fdkText('重みの付いた点は、取得範囲内に存在する候補すべてを表すものではありません。', 'Samples assigned interpolation weights are a subset of the candidates available within the acquisition interval.');
  comparison.append(pairRule, pairReference);
  const searchRange = document.createElement('div');
  searchRange.className = 'model-choice-range';
  const rangeTable = document.createElement('table');
  const rangeCaption = rangeTable.createCaption();
  rangeCaption.textContent = fdkText('①②に共通する候補範囲と根拠', 'Candidate ranges shared by ① and ②');
  const headRow = rangeTable.createTHead().insertRow();
  for (const text of [fdkText('範囲', 'Range'), fdkText('現在の定義と根拠', 'Current definition and basis')]) {
    const cell = document.createElement('th'); cell.scope = 'col'; cell.textContent = text; headRow.append(cell);
  }
  const rangeBody = rangeTable.createTBody();
  for (const entry of [
    {
      title: fdkText('重みを付ける列の範囲', 'Rows receiving weight'),
      definition: fdkText('実・対向それぞれで、目的断面に隣接する列を線形補間します。', 'Linearly interpolate adjacent rows around the target plane separately on the direct and complementary sides.'),
      source: fdkText('Hsiehら（2007）：p.067001-2、図5・式(6)', 'Hsieh et al. (2007): p.067001-2, Fig.5 and Eq.(6)'),
      href: 'https://doi.org/10.1117/1.2746866',
    },
    {
      title: fdkText('探索する取得角度の範囲', 'Acquired angles searched'),
      definition: fdkText('360°＋全ファン角の2倍。古典的な対向ビーム補間を参照し、比較条件をそろえるため②にも同じ範囲を採用します。全ファン角50°なら両者とも460°です。', '360° plus twice the full fan opening, following classical opposing-beam interpolation. The reference ② uses the same interval as a comparison control. A 50° full opening gives 460° for both.'),
      source: fdkText('Toki：EP0450152B1、図4～6・図10B', 'Toki: EP0450152B1, Figs.4–6 and 10B'),
      href: 'https://patents.google.com/patent/EP0450152B1/en',
    },
  ]) {
    const row = rangeBody.insertRow(), title = document.createElement('th');
    title.scope = 'row'; title.textContent = entry.title; row.append(title);
    const cell = row.insertCell(), definition = document.createElement('p'), source = document.createElement('a');
    definition.textContent = entry.definition; source.href = entry.href; source.textContent = entry.source;
    cell.append(definition, source);
  }
  const localRange = document.createElement('p');
  localRange.textContent = fdkText('両者とも、目的断面からの距離が列間隔sより小さい列に重みが付きます。①のsは対象位置と方向で変わり、②は入力した1列幅で一定です。設定スライス厚Tは平均する幅であり、候補を探す距離の上限ではありません。', 'Both assign positive weight at distances below the local row spacing s. In ①, s varies with position and direction; in ② it equals the input row width. Thickness T is the averaging width, not a candidate-distance limit.');
  const searchBasis = document.createElement('p');
  searchBasis.className = 'model-choice-range-policy';
  searchBasis.append(document.createTextNode(fdkText('取得角度範囲の多列モデルへの適用、検出器端の残存列や複数回転の重みの正規化は、本モデルで採用した定義です。', 'Applying this acquisition interval to the multirow model, and normalizing available detector-edge rows and multiple-turn weights, are definitions adopted by this model.')));
  const searchBasisLink = document.createElement('a');
  searchBasisLink.href = fdkText('methods.html?topic=axial&lang=ja#rri-search-basis', 'methods.html?topic=axial&lang=en#rri-search-basis');
  searchBasisLink.textContent = fdkText('根拠文献・式・適用範囲', 'Sources, equations and applicability');
  searchBasis.append(document.createTextNode(' '), searchBasisLink);
  searchRange.append(rangeTable, localRange, searchBasis);
  const details = document.createElement('details');
  details.className = 'model-choice-notes';
  const summary = document.createElement('summary');
  summary.textContent = fdkText('模式図と計算方法の補足', 'Schematic and calculation details');
  const selectionLimits = document.createElement('p');
  selectionLimits.textContent = fdkText('両者とも、検出器端では存在する列だけを使って重みを正規化します。どの列にも重みが付かなければ支持不足として停止します。これは体軸方向の応答モデルであり、画像再構成は行いません。', 'Both normalize over available detector-edge rows. If no row has positive weight, calculation stops for insufficient support. These are axial response models without image reconstruction.');
  const detailText = document.createElement('p');
  detailText.textContent = fdkText('同一位置のデータ、隣接回転や検出器端の条件によって、点数や合成比は変わります。②は面内の発散と再配列も省略するため、①との差はコーン角だけの効果を単独で取り出したものではありません。従来の最寄り2点モデルは主比較から外しました。', 'Coincident data, neighboring turns and detector boundaries change the point count and combined weights. Reference ② also omits transverse divergence and fan rebinning; the difference is not an isolated cone-angle effect. The former nearest-pair model is no longer part of the main comparison.');
  const weightExplanation = document.createElement('p');
  weightExplanation.textContent = fdkText('模式図の共通条件は、4列×1 mm、ピッチ1、焦点–回転中心距離600 mm、横断面内位置(x,y)=(150,0) mm、開始角度90°、目的断面z=0です。実データ側の再配列角0°と対向側180°を示します。この例の列間隔は①では0.75/1.25 mm、②では両方1.00 mmです。各方向の列間隔に基づく線形補間の重みを合成し、4点の合計を1に正規化しています。表示した重みと位置は小数第2位に丸めています。同じ補間ペアでは近い側ほど重みが大きくなります。異なる方向の点どうしは、距離だけでは比較できません。', 'Shared schematic conditions: 4 × 1 mm rows, pitch 1, source-to-isocentre distance 600 mm, transverse position (x,y)=(150,0) mm, start angle 90°, target plane z=0. The direct and opposing rebinned directions are 0° and 180°. Row spacings are 0.75/1.25 mm in ① and 1.00/1.00 mm in ②. Linear interpolation weights based on each direction’s row spacing are combined and normalized to sum to 1 across the four points. Displayed weights and positions are rounded to two decimal places. Within each pair, the nearer point has greater weight; distance alone cannot compare points across directions.');
  details.append(summary, selectionLimits, detailText, weightExplanation);
  const selected = document.createElement('p');
  selected.className = 'model-choice-selected';
  selected.setAttribute('aria-live', 'polite');
  selected.setAttribute('aria-atomic', 'true');
  function sync() {
    if (!methods.some(method => method.value === select.value)) select.value = 'fdk';
    for (const entry of radios) {
      const active = entry.radio.value === select.value;
      entry.radio.checked = active;
      entry.card.classList.toggle('is-selected', active);
      if (active) selected.textContent = fdkText('選択中：', 'Selected: ') + `${entry.method.number} ${entry.method.title}`;
    }
    element.dataset.model = select.value;
  }
  select.value = methods.some(method => method.value === initialValue) ? initialValue : 'fdk';
  select.addEventListener('change', () => {sync();if (typeof changed === 'function') changed(select.value);});
  element.append(legend, scope, select, grid, note, comparison, searchRange, details, selected);
  sync();
  return {element, select, sync};
}

// Fixed illustration, checked against sourceAxialGroups and
// sourceSupportedAxialWeights: N=4, d=1, pitch=1, R=600, r=150,
// phase=pi/2, theta=0/pi, z=0, matched-rri, before averaging over T.
function axialModelSketchData(model) {
  return model === 'parallel'
    ? [
      {spacing: 1, points: [{z: -.5, weight: .25}, {z: .5, weight: .25}]},
      {spacing: 1, points: [{z: -.5, weight: .25}, {z: .5, weight: .25}]},
    ]
    : [
      {spacing: .75, points: [{z: -.625, weight: 1/12}, {z: .125, weight: 5/12}]},
      {spacing: 1.25, points: [{z: -.875, weight: .15}, {z: .375, weight: .35}]},
    ];
}

function axialModelCandidateSketch(model) {
  const id = `model-choice-sketch-${model}`;
  const title = model === 'parallel'
    ? fdkText('②：発散なし。①と同じ条件・同じ位置軸で、実データと対向データの位置・列間隔・重みを比較', '②: nondivergent reference. Compare direct and opposing positions, row spacings and weights on the same axis and under the same conditions as ①')
    : fdkText('①：コーン幾何。②と同じ条件・同じ位置軸で、実データと対向データの位置・列間隔・重みを比較', '①: cone geometry. Compare direct and opposing positions, row spacings and weights on the same axis and under the same conditions as ②');
  const rows = axialModelSketchData(model);
  const x = z => 245 + 95 * z;
  const point = (z, y, direction, weight) => {
    const px = x(z), color = direction ? '#b55b13' : '#2166a5', fill = weight > 0 ? color : '#fff';
    const shape = direction
      ? `<path d="M${px},${y-6} L${px-6.5},${y+5.5} L${px+6.5},${y+5.5} Z"/>`
      : `<circle cx="${px}" cy="${y}" r="5.5"/>`;
    return `<g class="model-choice-sample" data-direction="${direction}" data-z="${z}" data-weight="${weight}"><g stroke="${color}" fill="${fill}" stroke-width="1.8">${shape}</g><text class="model-choice-weight" x="${px}" y="${y-18}" text-anchor="middle">w = ${weight.toFixed(2)}</text><text class="model-choice-position" x="${px}" y="${y+21}" text-anchor="middle">z = ${z > 0 ? '+' : '−'}${Math.abs(z).toFixed(2)}</text></g>`;
  };
  const row = (data, direction) => {
    const y = 60 + direction * 88, left = x(data.points[0].z), right = x(data.points[1].z);
    return `<g data-spacing="${data.spacing}">
      <text x="6" y="${y+5}">${direction ? fdkText('対向データ', 'Opposing') : fdkText('実データ', 'Direct')}</text>
      <line x1="108" y1="${y}" x2="378" y2="${y}" stroke="${direction ? '#d9c4b0' : '#bdcddd'}" stroke-width="1" ${direction ? 'stroke-dasharray="4 3"' : ''}/>
      ${data.points.map(p => point(p.z, y, direction, p.weight)).join('')}
      <path d="M${left} ${y+31} v6 H${right} v-6" fill="none" stroke="#7b8d9c"/>
      <text class="model-choice-position" x="${(left+right)/2}" y="${y+53}" text-anchor="middle">${fdkText('列間隔', 'Row spacing')} ${data.spacing.toFixed(2)} mm</text>
    </g>`;
  };
  return `<svg viewBox="0 0 390 260" role="img" aria-labelledby="${id}-title"><title id="${id}-title">${title}</title>
    <line x1="245" y1="23" x2="245" y2="220" stroke="#b61d37" stroke-width="1.6"/>
    <text x="245" y="16" text-anchor="middle" fill="#a51a31">${fdkText('目的断面 z = 0', 'Target plane z = 0')}</text>
    ${rows.map(row).join('')}
    <line x1="108" y1="220" x2="378" y2="220" stroke="#7b8d9c"/>
    ${[-1,0,1].map(z => `<path d="M${x(z)} 220 v5" stroke="#7b8d9c"/><text x="${x(z)}" y="239" text-anchor="middle">${z > 0 ? '+' : ''}${z}</text>`).join('')}
    <text x="245" y="258" text-anchor="middle" fill="#596b79">${fdkText('位置 z (mm)', 'Position z (mm)')}</text></svg>`;
}
