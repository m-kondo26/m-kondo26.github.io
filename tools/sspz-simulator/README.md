## Cached start-angle playback — 2026-09-25.3

At the chosen radius, Prepare computes all 360 start angles and compact display audits. Playback and angle scrubbing then reuse those results: all native SSPz curves remain grey, the selected curve and angle are red, and the production unwrapped diagram switches in the same frame. Both axes stay fixed across the series. This compares separate starting conditions, not tube motion during one acquisition. Numerical view sampling, interpolation and thickness averaging are unchanged.

Changing radius or another condition stops playback and preserves the previous plots, explicitly labelled as previous settings, until the new pair is ready. Display JSON identifies sampled diagram weights separately; complete weights remain available through the detailed selected-angle export.

## Current position-linked interface — 2026-09-25.2

The public interface is fixed to cone geometry with RRI-equivalent row interpolation. Changing the radius (slider, numeric input or preset) recalculates one start angle with the production response function; its unwrapped diagram and SSPz share one result object and retain the result-screen drawing conventions. No reduced view count or substitute numerical model is used. Full 360-start-angle analysis remains an explicit calculation. Old results and exports are invalidated immediately when conditions change; superseded preview workers are terminated and responses are correlated by request id.

Legacy parallel URLs/settings are mapped to cone geometry with a notice. The parallel and other historical numerical APIs remain for reproducibility; they are not selectable in the normal UI. The dated comparisons below describe earlier interfaces. Position-dependent SSPz reflects geometry, finite aperture/focus, rebinning, interpolation and thickness averaging; it does not isolate axial cone angle or simulate a reconstructed image volume.
## Current matched comparison — 2026-09-24.1

The main UI now has two choices: cone geometry with RRI-equivalent row interpolation (①), and a nondivergent reference with **the same row interpolation and finite source-angle support** (②). Both use 360° + 2Φ, with Φ the declared full fan opening, the same input detector/focal sizes and rectangular T average. The reference retains helical table motion, finite aperture and centre-projected focal blur; it omits fan rebinning and fixes axial row spacing to d. This comparison does not isolate the axial cone angle alone. Keep z-FFS OFF in both for this comparison.

The previous parallel nearest-pair/360° calculation is historical: reproduce it only with explicit `axialRule:'parallel', comparisonMode:'legacy'`. The merged model remains in the numerical API for reproducibility but is removed from the main UI. Old UI URLs are explicitly migrated with a notice. API defaults now select RRI. New numerical exports record `comparisonMode`, `interpolationRule` and source support. Earlier sections describing two cone rules or a 360° parallel reference are retained as historical implementation notes, not the current main comparison.

Candidate availability, positive interpolation weights and SSPz remain separate concepts. No dose-efficiency or complete image-reconstruction claim follows from this reduced response.

## Dense-row candidate display (2026-09-18.16)

The 2B and 2C diagrams now share a display selector: the existing full-turn view samples at most 72 directions, while a 30-degree detail window retains every calculated direction in that interval. The twelve windows cover the full turn without dropping or duplicating selected points. The display reports its direction and weighted-point counts; detail PNG filenames include the angular interval. Numerical SSPz, coefficients, row/turn/focus identities and full numerical exports are unchanged. Background trajectories still include every detector row, with density-dependent fading.

Increasing row count at fixed row width and beam pitch increases detector coverage and feed per rotation, not local row spacing. Selected points near the target therefore need not multiply with the row count. Nevertheless, row changes become faster in angle, and full-turn display sampling can miss intermediate selected rows. Use the detail view to inspect those changes; a similar number of plotted markers does not establish an unchanged candidate population. See the display-audit section in `AXIAL_RESPONSE_METHOD.md`.

## Static-table response linked to current settings (2026-09-18.15)

The reference link is now named by its subject: reconstruction positions and SSPz with a stationary table. It transfers the current row count (1–320), row width, source distances, effective axial focus, radius, view count and z step. Row selection, all-plane curves, CSV and SVG use that configuration; returning to the main page preserves the main conditions. This independent axial model uses row interpolation, distance weighting and full-turn accumulation, not complete Feldkamp image reconstruction. It does not inherit helical motion, the main interpolation rule, T averaging, transverse aperture/rebinning or z-FFS. A direct legacy link without settings retains the original 16 × 2 mm reference conditions.

Static core 2026-09-18.3 reuses angle geometry and provides row-by-row progress without reducing view count or z resolution. Default and 320-row profiles remain bitwise equal to the prior core. The main helical calculation is unchanged. Exact acquired angles are retained for calculation; only visible angle text is rounded.

## Playback angle controls (2026-09-18.14)

Panel 2C now has a permanent acquisition-start-angle slider shared by (a), (b), and (c). The plane-position slider is separate; the output-direction selector lives in the angle details and only highlights a direction within the same acquisition. A pending start-angle change clears all three old panels, disables profile export, and rejects superseded replies. Playback, manual selection, and PNG export use the same selected profile. Numerical acquisition and response calculations are unchanged.

## Finite axial focal blur in the main simulator (2026-09-18.13)

Both cone interpolation models now average the signal within each acquired detector cell over a uniform effective axial focal width, before rebinning and axial interpolation. New/reset conditions use 1.2 mm and a common source–detector distance of 1070 mm, following the adopted book example. Focal width 0 reproduces the previous point-source result. Old URLs/saved conditions without focal fields remain at 0; new URLs record `ff` and `fd`. z-FFS uses the same detector distance and preserves each physical exposure's identity. The nondivergent comparator uses a constant, isocentre-matched axial blur as an explicit reference assumption. See `FOCAL_BLUR_METHOD.md` for equations and limits. This is an axial acquisition model; it does not add transverse focal blur, target-angle-dependent apparent focus, or full image reconstruction.

## Selected SSPz shown once (2026-09-18.12)

Playback panel (c) and the former selected-profile panel (d) read the same saved profile at matching start angles. The duplicate selected-profile card was removed; panel (c) retains the half-maximum arrow, adds FWTM, and saves its displayed angle as a 600-dpi PNG. The movie angle can be inspected independently until applied to the other figures. Section 3 now contains only the all-360 overlay, followed by the unchanged shape comparisons. Visible result panels are relabelled sequentially. Numerical models, profiles, and full numerical exports are unchanged.

## Mori static-table explanation with finite focal blur (2026-09-18.11)

`mori-static.html` provides a separate, interactive explanation inspired by Mori et al., Fig.6.25: select a row-corresponding reconstruction plane, inspect the rotating source and row brackets, view weighted axial kernels, accumulate a full turn, and compare 16 planes at radii 0/80/160 mm. It now defaults to the 1.2 mm effective axial focal width adopted from Fig.6.6, convolved with the detector aperture before row interpolation. A point-focus comparison remains available. The 7-degree target angle is recorded as the reference condition; directional changes in apparent focal shape are outside this reduced axial model. See `MORI_STATIC_METHOD.md`. This is not full image FDK or an exact reproduction of the book figure. CSV and vector SVG exports use the same computed data. The main helical response operator is unchanged.

New browser sessions and Reset use transverse pitch and aperture 0.58 mm at isocentre. This is the approximate book-derived 1.03 mm physical detector scale, with equal pitch/aperture explicitly assumed. Existing URLs and saved conditions retain their explicit values and historical missing-field fallback of 0.25 mm. A default-condition change can change newly calculated responses; manuscript figures are not automatically replaced.

## Overview legend (2026-09-17.13)

The geometry-only overview identifies direct and complementary trajectories by solid and dashed lines, without circle/triangle symbols. The selected-weight diagram retains these marker symbols. This applies to the screen and 600-dpi exports in both languages.

## On-screen figure size (2026-09-17.12)

Single-column diagram cards are capped at 720 CSS pixels and other result cards at 900 CSS pixels. This prevents the 900-pixel diagram canvas from being enlarged to the full 1440-pixel page width. Cards remain responsive; narrow screens retain local scrolling for legible completed-chart labels. Canvas resolution, aspect ratios, numerical results and 600-dpi exports are unchanged.

## Diagram grid layers (2026-09-17.11)

Unwrapped diagrams draw the gray major-tick grid behind trajectories, weight markers and the target plane, on screen and in 600-dpi PNG exports. The black frame, ticks and axis labels remain in the foreground. The pale extent band, row colours, marker weights and numerical results are unchanged.

## Tail display (2026-09-17)

The public logarithmic tail view now shows normalized SSPz from 0.01 to 1 (1% to 100%), on screen and in 600-dpi PNG exports. This is a display threshold, not a contribution fraction or a truncation of the calculated profiles. Full numerical exports, FWHM and FWTM are unchanged. Profile display version: 2026-09-17.1. Earlier dated entries below describe prior releases.

## Current browser: shared axial interpolation response (2026-09-17.6)

The public comparison now uses common point acquisition, finite detector aperture, rowwise rebinning, angle/state definitions, rectangular T averaging and normalization. It compares merged candidate selection with RRI-equivalent linear row interpolation, plus a separate nondivergent reference. There is no transverse ramp or reconstructed image volume. This is a new numerical model, not an unchanged FBP SSP. See [AXIAL_RESPONSE_METHOD.md](AXIAL_RESPONSE_METHOD.md).

URL v11 records the new scope. Numerical APIs for earlier Taguchi/FBP results remain unchanged; all dated notes below are historical. Manuscript figures are not automatically replaced. New tests include independent all-row response evaluation, chapter-3 ray-coordinate checks and weight/response closure at 4, 80, 160 and 320 rows. These are implementation checks, not scanner validation or manuscript convergence.

## RRI as the primary 3D interpolation (2026-09-17.5)

The browser now uses **RRI-equivalent linear interpolation** for the 3D conjugate-data path. One result supplies the diagram weights, images, SSPz series, shape deviations and Excel/CSV/JSON/PNG exports. This simplifies visualization of candidate geometry and its distance-based weights; it does not claim that CBA and RRI responses are equivalent. The explicit acquired-row edge normalization is retained. See [CBA_METHOD.md](CBA_METHOD.md) for the adopted definition and historical paired APIs.

URL v10 records `fdk_method=rri`; old `hsieh` comparison links show a migration notice and recalculate RRI. RRI is red as the sole simulation channel; detector-row hues and existing figure opacity, grids and FWHM annotations are retained. CBA remains in the numerical API for historical reproducibility, and the original FDK reference remains optional. The dated entries below describe previous releases.

## Shared finite detector aperture (2026-09-17.4)

Both browser models now acquire a unit point through the same finite transaxial and axial detector cells. Transaxial active aperture and detector-center spacing are common, separate controls (default 0.25 mm each); neither is image pixel spacing. The axial reference applies linear channel readout followed by its existing longitudinal interpolation; the 3D path applies rebinning, ramp filtering and backprojection. See [DETECTOR_APERTURE_METHOD.md](DETECTOR_APERTURE_METHOD.md) for equations, assumptions and checks. This extends the axial model and changes its results; it is not full 2D image FBP. Browser URL v9 records both inputs. Historical low-level axial APIs remain available with `detectorModel: 'axial-only-legacy'`, which is also the API default when omitted.

## Ideal-point response (2026-09-17)

The browser's 3D paths now use a unit-integral ideal point, an analytic detector-cell projection and fixed-point profile extraction. Sphere diameter and sphere-radius ROI averaging are removed from the browser calculation. Shared geometry and thickness inputs remain. See [POINT_RESPONSE_METHOD.md](POINT_RESPONSE_METHOD.md) for the derivation, comparison with the axial model, tests and interpretation limits. Historical finite-sphere API calculations remain reproducible but are not the current browser result. The sections below record earlier feature introductions; the 80/160/320 presets were subsequently removed in favor of the common row-count input.

## Diagram layout (2026-09-15)

Overview and zoom diagrams now place a compact four-row legend below the axes. The 900 × 960 logical canvas preserves a 650-unit-high plotting field on screen and in 600-dpi PNG exports. Candidate coordinates, marker weights, color mapping and model calculations are unchanged.

## Hsieh conjugate backprojection (2026-09-15)

The 3D FBP controls now include Hsieh CBA with matched RRI. Both use the same finite-sphere projections, rowwise fan-to-parallel rebinning and filtering. Compare SSPz, individual FWHMs, start-angle deviations and central-voxel sample weights; export both methods to Excel, CSV, PNG and volume JSON. See [CBA_METHOD.md](CBA_METHOD.md) for the equations, source papers, numerical sensitivity and scope. The original FDK path remains available. This reference implements the specified interpolation, not every acquisition or adaptive weighting operation in Hsieh's scanner experiments.

## 3D FBP browser path (2026-09-14)

The public simulator now includes an integrated cylindrical-detector, full-turn helical FDK approximation for up to 320 rows, with 80/160/320-row presets. Select **3D FBP** in the shared calculation-model control. This browser path generates sphere projections, reconstructs a local 3D image, displays sphere-derived SSPz and start-angle deviations, and exports Excel, CSV, PNG and volume JSON. See [FDK_METHOD.md](FDK_METHOD.md) for equations, applicability and numerical checks. It is not TCOT or an exact wide-cone reconstruction. The earlier Python `reconstruction3d` prototype is development material, not the public app.

# CT展開図・SSPz幾何リファレンス

無料・登録不要の研究・教育用Webアプリです。取得幾何の展開図と、明示した体軸方向補間によるSSPzを分けて示します。患者診療、装置性能保証、商用再構成の定量予測には使用しません。

## 2026-09-08：厚いスライスの応答モデル

既定の `profileMode=taguchi-filter` は、Taguchi and Aradate (1998), Eq. (6), Figs. 5/6のフィルタ補間に基づきます。以前の「一つの再構成面で選んだ候補応答へ、幅Tの矩形平均を後から加える」モデルは既定のSSPzから置き換えました。旧モデルの保存済み結果は再利用しません。

1. 取得データを理想的な検出器列開口でサンプリングした、固定した薄い物体の応答を作ります。
2. 再構成面位置を `z_r` とすると、`z_f(i)=z_r+i FW/K`、`i=-I,...,I`、`K=2I+1` の各位置で、その位置を挟む取得候補を選び直して線形補間します。
3. 各位置の補間値を等しい矩形重みで平均します。有限Kの和であり、連続矩形畳み込みへの無断置換は行いません。
4. 物体を固定したまま再構成面を動かし、`z_r-z_object` に対するSSPzを求めます。FWHM・FWTM・標準偏差はその出力から算出します。

線形性を利用し、各ビューで局所的に候補を選び直した区分線形応答を先に合成してから有限K点のシフト和を計算します。固定断面で選択した旧候補カーネルを再利用する操作ではありません。

### 入力と校正境界

- `filterWidthMm`：体軸方向モデル内部のフィルタ幅FW。公開画面では別入力にせず、常に設定厚Tを使用します。
- `filterSamples / nf`：式（6）の再標本点数Kの最小値。既定129、奇数33–2049。FW/Kが最小投影列幅の1/8以下になるまでKを自動増加し、図・CSVには実際のKを記録します。必要Kが2049を超える条件は精度限界エラーとして出力しません。取得ビュー数・候補数とは異なり、この基準だけで収束を保証せず、Kをさらに増やした結果も確認します。
- `sliceThicknessMm / st`：設定スライス厚T（0より大きく20 mm以下）。公開画面の全モデルで体軸方向の矩形平均化幅として使います。FWHMは出力です。
- `profileMode / pm`：既定は `taguchi-filter`。旧公開URLのモードは移行し、再計算します。

公開URL v8以降はFW=Tをモデルの定義とします。体軸方向モデルでは補間後の矩形フィルタ、FDK・CBA・RRIでは再構成画像の矩形平均化にTを使います。これは実機への校正やFWHM=Tの強制ではありません。旧URL・保存条件の独立したfw／fdk_axialAverageMmはTで置き換え、画面に通知して再計算します。低水準の数値APIでは、履歴再現とフィルタ検証のため独立幅も引き続き指定できますが、ブラウザは常にthicknessMapping=configured-rectangularを渡します。

各曲線は薄い物体を固定した応答です。360曲線では、1回転寝台移動量 `F=pNd` 内の物体位置 `s=j/360` を変えます。図内のSSPz横軸は再構成面位置 `z_r-z_object` です。各曲線をピーク正規化しますが、ピーク・重心への追加位置合わせはしません。3D図と展開図は選択物体位置を通る中心面を幾何の参照として示します。

### 取得幾何と局所補間の表示

既定の取得幾何は180LIです。実データ側の各取得ビューβから理想対向角 `βc=β+180°+2γ` を求め、それを挟む両隣の実取得対向ビューを保持します。各角度枝で実データ側・対向データ側の全列候補を統合し、目的のz位置を挟む隣接取得データを選び、二枝を角度方向に線形合成します。比較用の実データ側のみ0–360°経路も残します。

全列候補の幾何計算は変更しません。設定厚Tでは候補を除外しません。FWは再標本位置の範囲であり、その位置を挟むために必要ならFW外の取得データも用います。最近接の取得候補を探索する回転数に恣意的な固定打切りは設けません。

2Aは実データ側・対向データ側の全列軌道です。2Bの○・△と濃淡、および2Cの `G_eff/T` 等の間隔は、選択中心位置での **FW=0の局所補間の監査** です。厚いスライスに寄与する全候補の表示ではありません。線・点は表示基準角度へ対応付けているため、独立な取得データ数として数えません。

3Cの候補位置標準偏差は、各実データ側ビューの全列と、理想対向角を挟む異なる実取得ビューの全列から求める無重み母標準偏差（mm）です。T、FW、候補選択、補間重み、列開口分散は使いません。これは取得幾何だけの指標で、SSPzの標準偏差ではありません。

### 実装と物理的妥当性の境界

原典の局所線形補間と有限再標本点のフィルタ平均を実装しますが、Taguchiらの最適化ピッチ選択・全画像再構成を再現するものではありません。理想列開口、等しいビュー重み、面内チャネルの連続座標、距離比によるコーン幾何は引き続き明示した仮定です。Schaller AAI、TCOT/MUSCOT固有の選択・重み、Parker重み、三次元逆投影、ノイズ、有限径ビーズは含めません。

旧固定断面モデルの分散恒等式 `sigma^2=mean(M2)+T^2/12` は、新しい移動再構成面応答の検証式ではありません。旧値を根拠に5 mm実測との一致・不一致を論じません。実測にフィルタ幅を合わせる場合は、調整用と独立検証用のデータを分ける必要があります。

## 実行

日本語版は `index.html`、英語版は `index-en.html` をダブルクリックするだけで起動できます。Google Chromeの `file://` 直接起動でも計算できる構成です。両ページ右上の言語切替は、現在の計算条件をURLクエリとして引き継ぎます。

ローカルファイル実行を組織のブラウザ設定が禁止している場合は、`起動_サーバー.cmd`をダブルクリックしてください。Pythonによるローカルサーバーを起動し、既定ブラウザを開きます。表示された黒い画面でEnterキーを押すとサーバーを終了します。

手動で起動する場合は、次の静的サーバー方式を使用します。

単純な静的ファイルなので、Pythonがあれば次のコマンドで起動できます。

```powershell
python -m http.server 4173
```

ブラウザで `http://localhost:4173/` を開きます。計算はWeb Worker内で行われ、サーバーへ入力値を送信しません。


## 検証

```powershell
npm run build
npm test
```

幾何の独立列挙、角度対応、全列表示、局所FW=0補間の検証と、新しいフィルタ応答の検証は分けます。Taguchi経路では原典の有限和を直接計算する独立参照、低水準APIのFW=0・独立参照Tの不変性、周期性、K収束を確認します。公開設定のFW=Tと3次元平均化はconfigured-thickness.mjsで別に検証します。旧数値fixtureは明示した旧モデル参照でのみ維持し、新モデルとの一致を受入基準にしません。実行済みの範囲とブラウザQAは `REPRODUCIBILITY.md` を参照してください。過去版のQAを新モデルの合格証明として流用しません。

## 投稿図出力

Web画面は日本語版と英語版を同じ計算核および作図処理から生成します。両版で次の作図規約を共通化します。

- 軸・文字は黒、補助グリッドは淡い灰色とし、色は条件または検出器列の識別に限定する。
- 変数名に続けて単位を丸括弧で示し、同一軸の目盛はすべて同じ小数桁数にする。
- 目盛間隔は1、2、5と10の整数べきの系列から選び、軸端はその目盛間隔の整数倍へ外側に丸める。たとえば必要範囲が±132 mmなら±150 mmなどへ丸める。ただし、全候補が±300 mmを超える条件を±150 mmへ切り詰めることはせず、±400 mmなど全データを含む次の切りのよい端点を用いる。
- 主目盛は軸の外側、副目盛は内側に置き、原則として各軸を5区間以上に分割する。
- 比較するパネルは役割ごとに同一の軸範囲を用いる。360状態SSPzでは、中心形状の左右2パネルで共通横軸を用いる。低振幅裾はコーン幾何を反映した単独パネルとし、その曲線だけから横軸を決める。中心形状と裾の軸範囲は混在させない。全候補列中心の体軸方向標準偏差は、コーン幾何を反映しない条件と反映する条件を同一の角度軸・mm軸へ重ねる。
- 図内の長い説明や多数の数値は避け、凡例の符号化を直交させる。展開図では色＝検出器列、細線＝各実取得ビューの全列候補軌道、円＝全列から選択された最近接補間端点、円の濃淡＝線形補間重みとする。設定厚 `T` による候補除外は示さない。

各図の「投稿用PNG（600 dpi）」は、画面を単純拡大せず、投稿寸法で再描画します。単一パネルは80 mm幅（1890 px）、全幅図は180 mm幅（4252 px）とし、PNG内にも約600 dpiの物理解像度情報を記録します。画面上の選択状態マーカーや長い操作説明、重複する題名・副題は投稿用出力から除外し、軸、データ、必要最小限の凡例を優先します。詳細条件はfigure captionに記載してください。

この規約は、Medical Physicsの[Author Guidelines](https://aapm.onlinelibrary.wiley.com/hub/journal/24734209/about/author-guidelines)およびWileyの[Electronic Artwork Guidelines](https://authorservices.wiley.com/asset/photos/electronic_artwork_guidelines.pdf)を参照しています。投稿原稿内の表は画像化せず、編集可能な表として作成し、単位を列見出しへ置き、略語は脚注で定義してください。英語版の用語は、下記のWangら、Schallerら、Kudoら、Taguchi and Aradate、Hu、Zamyatinらの研究で使用された表現を参照し、本Web独自の説明語と先行研究のアルゴリズム名を区別します。軸範囲、目盛、線幅、色、投稿寸法の規則は両言語版で変更しません。


PNGにはFW・K・T、CSVにはモデル版・応答座標・FW・K・参照Tを保存します。SSPzの全計算グリッドを描き、360状態も間引きません。低振幅裾の表示下限0.1%は描画上の閾値で、計算結果がそこで消えることを意味しません。

SSPz描画版 `profileDisplayVersion=2026-09-08.1` は、計算済みのz座標とSSPz値の隣接点を共通の描画関数で直線接続します。不等間隔のz座標もそのまま使い、描画のための再標本化、スプライン補間、平滑化、点や360状態の間引きは行いません。日本語・英語の画面と600 dpi PNGは同じ描画関数を使います。対数裾では従来どおり0.1%以上の元の点を対数座標で結び、閾値未満を跨いで線をつなぎません。これは描画規約の共通化・明示であり、前段のフィルタ補間計算、正規化、幅指標、`sim-core.js`、`worker.js` と数値モデル版 `2026-09-08.1` は変更していません。展開図専用の `diagramDisplayVersion=2026-09-08.3` は別に保持します。

## 公開と権利

日本語・英語の権利表記を共通ビルドで保持します。無料で通常利用できますが、無料提供と再配布許諾は同じではありません。画面の権利表記に従ってください。本更新はローカルの実装・検証であり、公開サイトや原稿を自動的に差し替えたことを意味しません。

## 計算モデルの文献的背景

Web画面には、モデル開発時に参照した以下の研究と、本Web版での実装境界を表示しています。

- Wang and Vannier (1994), spatial variation of SSP in spiral CT, https://doi.org/10.1118/1.597199
- Wang et al. (2003), SSP in multi-row-detector spiral CT, https://doi.org/10.3233/XST-2003-00064
- Schaller et al. (2000), multislice spiral interpolation theory, https://doi.org/10.1109/42.887832
- Kudo et al. (2004), exact and approximate helical cone-beam CT algorithms, https://doi.org/10.1088/0031-9155/49/13/011
- Taguchi and Aradate (1998), image reconstruction and two-point interpolation in multi-slice helical CT, https://doi.org/10.1118/1.598230
- Hu (1999), interlaced direct/complementary helical samples and generalized two-point linear interpolation, https://doi.org/10.1118/1.598470
- Zamyatin et al. (2005), complementary-ray geometry and the limitation of exact complementary rays in three-dimensional cone-beam geometry, https://doi.org/10.1118/1.2047784


各文献の役割と適用範囲を画面でも明示しています。Taguchiらの有限フィルタ補間以外の再構成法を実装したとは扱いません。

## 主要ファイル

- `index.html`: 日本語版の画面構造
- `index-en.html`: ビルドで生成する英語版の画面構造
- `styles.css`: PC・モバイル表示
- `app.js`: 入力、描画、CSV/PNG出力、URL共有
- `worker.js`: 非同期計算と進捗・中止
- `sim-core.js`: ブラウザ・Node共通の計算核
- `app-bundle.js`、`worker-source.js`: 日本語版のダブルクリック起動用生成ファイル
- `app-bundle-en.js`、`worker-source-en.js`: 英語版のダブルクリック起動用生成ファイル
- `scripts/build-standalone.mjs`: 日英両版の生成処理
- `scripts/english-replacements.mjs`: 先行研究の用語に合わせた英語表示辞書
- `tests/`: フルスキャン計算契約と固定数値の回帰試験
- `model-manifest.json`: モデル版、基準コード・固定データのハッシュ、実装範囲
- `REPRODUCIBILITY.md`: 数値回帰・ブラウザQA・公開手順の記録
- `.github/workflows/deploy-pages.yml`: GitHub Pages公開処理


## 2026-09-11: mean-centered shape distributions and Excel export

The new paired heatmaps align each complete native SSPz at its bilateral linear FWHM midpoint, interpolate on a shared 0.01-mm grid, and subtract the pointwise mean separately for each reference condition. The original display used fixed bins from -0.06 to +0.06 and sqrt(state fraction). The 2026-09-15 update below supersedes that display mapping; native numerical results are unchanged. Excluded states and out-of-range samples are disclosed. The model calculation is unchanged.

The Excel button exports all 360 native peak-normalized profiles for both references, aligned profiles, pointwise means, deviations, inclusion flags and centers, sweep metrics, units, parameters, and model/export versions. Native data preserve the worker Float32 values; no display rounding is applied. The workbook uses standard OOXML with ZIP compression, or uncompressed ZIP when browser compression is unavailable. Native, aligned, and deviation sheets support independent replotting. Fractions refer to sampled model states, not measured start-angle probabilities.

Validation: tests/shape-export.mjs; all eight manuscript simulation conditions agree with the retained Python shape deviations within 9e-16; Japanese/English UI, XLSX readback, and 600-dpi PNG export checked.

### ピッチ0の展開図（2026-09-14）

ビームピッチ0では、寝台移動なしの検出器列中心軌道を表示します。同じ軌道を複数回転分重ねず、1回転分を示します。既存の距離比によるコーン幾何を使用し、ヘリカル補間点・補間重み・SSPz・状態変動は計算対象外とします。正のピッチの計算経路は従来どおりです。日本語・英語のブラウザ表示と既存回帰テストを確認し、zero-pitch.mjsで列数・位置・取得経路・コーン幾何条件を検証しました。これは表示と実装の検証であり、アキシャル再構成の検証ではありません。


## 2026-09-15: manuscript-style density display (Web 2026-09-15.5)

`shape-display.js` is the common Canvas2D renderer for the paired axial-model maps and the added CBA/RRI (or FDK) map. It uses fraction^0.35 for every channel, labeled 0/25/50/75/100% lookup tables, numeric z ticks (0.5 mm for the 1-mm view and 1 mm for the 5-mm view), and mean-individual-FWHM arrows above the plotting rectangle. Widths are shown to 0.01 mm and sample SD to 0.001 mm (or SD < 0.001 mm). CBA/FDK is red; the matched linear RRI reference is blue. Axial-model panels retain gray for the parallel reference and red for cone geometry. These are computed sources, not measured TCOT/MUSCOT data.

The added 3D-FBP distribution translates each native FWHM midpoint to zero, without width rescaling, then linearly samples a common 0.01-mm grid and subtracts each method's own pointwise mean. Bins retain width 0.002; their vertical extent starts at +/-0.06 and expands to avoid clipping. This aligned distribution is separate from the retained, sphere-centred native mean-difference curves. Alignment and normalization affect the appearance near the half-height crossings; a shared bin does not establish equality of full profiles or absolute mean shapes. Fraction denominators are included model conditions, not measured start-angle probabilities.

Screen and 600-dpi PNG use the same renderer. Excel additionally includes method-specific aligned-profile and deviation sheets. Numerical cores, native profiles and native width calculations are unchanged. The new shape-display test checks known widths/translation, immutability, zero-mean deviations, histogram mass, expanded ranges and intensity endpoints. An audit using all 2880 manuscript model profiles reproduced the saved shape deviations within floating-point roundoff. Single-angle runs explicitly state that variation cannot be assessed.

The display has at most two active axial maps or one composite FBP map; typed-array histograms are cached with the result. No continuous redraw, animation, new runtime dependency or extra reconstruction is needed. Dense histogram pixels use nearest-neighbor rendering, never smoothing. Narrow screens retain legible chart widths with keyboard-accessible horizontal scrolling; existing URL and numerical-condition persistence are unchanged.
