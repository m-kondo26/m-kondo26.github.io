# 森『CTとMRI』図6.25の手順に沿う静止寝台の体軸応答モデル

Version 2026-09-18.2. Implementation: `mori-static-core.js`.

## 目的と位置づけ

森ほか『CTとMRI―その原理と装置技術―』（コロナ社）、pp.72–74、式6.34、図6.24–6.25で説明される「各投影角での検出器列間補間→逆投影重み→1回転の合算→等面積正規化」を、幾何と応答の対応を追える独立した計算として示す。

各曲線は、各列が回転中心軸に投影される位置に固定した再構成面の応答である。各検出器列単独の寄与を表示したものではない。取得幾何、線源のz位置、検出器全体は固定し、評価する再構成面を選ぶ。

**図6.25の数値的再現を達成したという主張ではない。** 焦点寸法は本書p.60の図6.6に明記されており、今回その値を採用する。ただし、図6.25でも同じ値を用いたことや、局所開口幅の取り扱いなど全条件が明示されているわけではないため、以下の追加仮定を宣言する。特定装置、商用再構成、ヘリカル、多列の全条件を検証する機能ではない。

## 書籍由来の条件と追加仮定

| 項目 | 採用値・規則 | 根拠・適用範囲 |
|---|---|---|
| 検出器列数 | 16 | 図6.25 |
| 体軸方向列ピッチ・開口 | 回転中心換算でともに2 mm | 図6.25の2 mmを隙間のない理想列に適用 |
| 横断面内位置 | r=0、80、160 mm | 図6.25 |
| 線源―回転中心距離R | 600 mm | 本書p.54の例を採用。図6.25に全幾何値が再掲されているわけではない |
| 線源―検出器距離D | 1070 mm | p.60のRF=600、RD=470から採用。回転中心換算の列幾何ではDが相殺されるが、有限焦点の投影幅には残る |
| 取得角度数 | 900、0°以上360°未満 | p.54の例を採用。900が図6.25の確定条件とはしない |
| 実効焦点寸法 | 1.2×1.2 mm | p.60図6.6の条件を採用。体軸方向の実効焦点幅1.2 mmを一様分布として計算。0 mm指定で従来の点焦点に戻る |
| ターゲット角 | 7°、参照条件として記録 | 図6.6。実効焦点寸法に再びsin7°を掛けない。ターゲット面やヒール効果の計算はしない |
| 検出器 | 線源中心の円弧検出器 | 体軸位置・開口は対象までの横断面内距離Lに比例して投影 |
| 体軸方向基礎応答B | 検出器の高さ1の矩形と、有限焦点の面積1の矩形を畳み込み | p.58の一様分布とp.72式6.34のBF*BDに対応。各角度でB全体を面積1にはしない |
| 列間補間 | 再構成面を挟む隣接2列の線形補間 | pp.73–74 |
| 端列範囲の外側 | 最も近い端列で代用、欠損角度率を表示 | 本文の内側データ代替に対応する明示的なモデル選択。書籍に代替演算の完全な仕様はない |
| 逆投影の距離重み | R²/L² | 本書pp.20–21の等角ファン座標でのL^-2に対応する距離因子 |
| 最終正規化 | 各SSPの面積を1 | 図6.25 |

矩形幅Tを使った後段の体軸平均化は加えない。面内の有限開口、ファン方向の再配列、ランプフィルタ、コーンの前処理重み、画像逆投影の全体は計算しない。この独立した体軸応答では、現在のヘリカルモデルと全演算が同一であるとはしない。面内ピッチ0.58 mmの設定を、この計算が評価したとも扱わない。

有限焦点は、体軸方向に固定した実効線分の一様分布という分離可能な近似である。面内焦点幅1.2 mmとターゲット角7°は採用条件の記録であり、本計算は面内焦点によるぼけ、傾斜ターゲット上の二次元焦点、視方向ごとに変化する見掛け焦点、ヒール効果、各焦点位置での候補列選び直しを計算しない。図6.6のMTF計算全体を実装したとも扱わない。

書籍§3.9はFeldkamp法の全式を省略している。したがって、R²/L²を使用する本計算を「FDK全体の実装」と呼ばない。円弧検出器の座標を用いるため、平面検出器のR²/(R−r cosβ)²を、平面への再配列なしに代入しない。

## 座標と選択

距離はmm、角度βは線源の回転角とする。寝台移動は0。検出器列番号kは実装では0からN−1。

    線源 Sβ = (R cosβ, R sinβ, 0)
    横断面内評価位置 = (r, 0)
    Lβ = sqrt(R² + r² − 2 R r cosβ)
    αβ = Lβ / R
    回転中心換算の列中心 qk = [k − (N−1)/2] d
    評価位置を通る体軸線上の列中心 cβk = αβ qk
    同位置での開口幅 aβ = αβ a
    実効体軸焦点幅 f = 1.2 mm（既定値）
    同位置での焦点ぼけ幅 bβ = f |1 − Lβ/D|

検出器を固定して線源を実効体軸方向にtだけ移すと、線源から横断面内距離Lβの位置でレイはt(1−Lβ/D)だけ移る。この関係からbβを求める。回転中心ではaβ=2 mm、bβ=1.2×(1−600/1070)=0.5271028037 mmとなる。fは実効寸法なので、ターゲット上の物理長さから再投影する演算は加えない。

再構成面jはZ=qjに固定する。cβk≤Z≤cβ,k+1のとき、

    wβk = (cβ,k+1 − Z)/(cβ,k+1 − cβk)
    wβ,k+1 = (Z − cβk)/(cβ,k+1 − cβk)

を用いる。一つの列中心と一致するとその列の重みは1。範囲の外側では最も近い端列の重みを1にする。この場合、再構成面を挟む補間は成立していないため、`edgeFallback=true`とする。近接列代替を正常な両側補間と混同しない。

## 応答の形成

横軸zは**固定した再構成面に対して信号を置く体軸位置**である。矩形関数Πは区間内で1、区間外で0とする。

    BD,βk(z) = Π[(z − cβk)/aβ]
    BF,β(z) = (1/bβ) Π[z/bβ]                 （bβ>0）
    Bβk(z) = BF,β * BD,βk
    hβj(z) = Σk wβk Bβk(z)
    Wβ = (R/Lβ)²
    Hj(z) = (1/M) Σβ Wβ hβj(z)
    SSPj(z) = Hj(z) / ∫Hj(z) dz

BFは総強度を1とした焦点分布の投影で、BDは高さ1、面積aβの検出器応答である。畳み込み後のBは支持幅aβ+bβの台形（両幅が等しければ三角形）となり、面積aβを保つ。aβ≥bβなら高さ1の平坦部を持ち、bβ>aβならピークはaβ/bβとなる。焦点幅0の場合、BFをデルタ関数とし、B=BDの従来の矩形計算に戻る。

BFに面積1を与えるのは、焦点の投影幅が変わっても総線源強度を保つための明示的な追加仮定である。書籍の矩形による形状の表現を、そのまま各角度で高さ1の焦点応答として掛ける演算とは区別する。bβは角度によって変わるため、その倍率差が最終正規化で一律に相殺されるとはしない。

局所開口幅が角度により異なると、最終合算における角度別の面積寄与はWβ aβとなる。各角度でBを面積1にしてから平均する演算とは異なる。p.72にはBの場所依存を回転中心の値で代表する近似も述べられているが、本計算では開口幅・焦点ぼけ幅の局所的な幾何倍率を明示的に使用する。

有限焦点を最終SSPへの任意の平滑化として追加しない。各角度・各列の基礎応答Bに含め、その後に既存の列間補間、距離重み、全角度の合算を適用する。この近似では平均焦点から求めた列中心・選択・重みを保持する。

1/Mは一回転の平均という共通係数であり、最終等面積正規化で相殺される。アニメーションの途中では、全900角度で求めた最終面積を分母として使用する。途中の曲線をその都度面積1にしてしまうと「積み重なる様子」が消えるため、その処理はしない。

## 数値計算と出力

- 既定の体軸表示ビン幅は0.05 mm。畳み込みで得た台形の区分的二次CDFの差を解析的に積分し、ビン平均として描く。右裾で1に近いCDF同士を引く桁落ちを避けるため、差を因数分解した式を使う。焦点幅0では従来と同じ矩形重なり計算を使う。これは有限測定対象や追加のzフィルタではない。
- 全列・全角度の開口支持域に焦点半影の最大半幅を加えた共通z範囲に、空のビンを追加する。支持域を切る外部指定グリッドはエラーとする。
- 面積はビン平均×ビン幅の和で計算する。最終SSPの積分は1。
- `centroid`と`sigma`は連続的な基礎応答混合の解析モーメントから計算する。各Bの重心はcβk、分散は(aβ²+bβ²)/12。`sampledCentroid`と`sampledSigma`は表示ビンから得た値であり、離散化の確認用に残す。
- `sigma`は一つのSSP自体の標準偏差である。開始角度間のFWHMのSDとは異なる。
- `fwhm`は表示ビン間を線形補間した外側の半値交点間距離。多峰性の場合にはその間の谷を含むため、形状の完全な要約ではない。主要な比較は曲線とσを用いる。
- `edgeCount/edgeFraction`は両側列がなく代替した角度の数と割合であり、再構成のデータ充足性を証明する指標ではない。

## API

`moriStaticConfig(input)` validates and returns configuration. `focalSizeMm`
is the effective axial source width (default 1.2, nonnegative, 0 selects the
point-focus limit). `focalTransverseMm=1.2` and `targetAngleDeg=7` are reference
metadata only; `targetAngleUse` explicitly records that the supplied source
width is already effective. `focalSpotModel` is `uniform-effective-axial` or
`ideal-point`. The reference target angle does not alter the computed response.
`baseNormalization` is `detector-peak-one-focus-unit-area` for finite focus and
the original `peak-one` for point focus; the convolved base need not peak at one
when the projected focus is wider than the detector aperture.

`moriStaticView(config,{row,radius,angleDeg})` returns fixed plane `zPlane`,
`source`, `transverseDistance`, `radialDistance`, `detectorDistance`,
`rowScale=L/R` (`magnification` is an alias for this local-to-isocentre scale),
`physicalMagnification=D/L`, numeric `rowCentres` and `detectorRowCentres` arrays,
`focalBlurMm=focalSizeMm*abs(1-L/D)`, `effectiveFocalSizeMm`,
`selected:[{row,weight,zCentre,apertureMm,focalBlurMm,effectiveFocalSizeMm}]`, `backprojectionWeight`,
`edgeFallback` and `edgeSide`.

`moriStaticAngleProfile(config,{row,radius,angleDeg,z?})` additionally returns
the common `z`, selected weighted `components` (all selected-row fields plus `profile`),
and their sum `raw`. Each component includes the distance weight.

`moriStaticCalculate(config)` returns `{version,config,z,groups}` where each
group is `{radius,profiles}` and each profile contains `row`, `zPlane`,
`raw`, final unit-area `profile`, `area`, `centroid`, `centroidOffset`,
`sigma`, sampled counterparts, `fwhm`, half-height crossing positions,
`edgeCount`, `edgeFraction` and mean distance `weightSum`.

`moriStaticProgress(config,{row,radius,angleDeg,z?})` sums actual acquisition
angles from 0 inclusive to `angleDeg` exclusive, using the full response's area
as denominator. At 0° it is zero; at 360° it equals the final profile. Returns
`z`, `profile`, `fraction`, `viewsIncluded`, `viewCount`, `normalizingArea`
and partial `edgeCount`.

## 検証

`node tests/mori-static.mjs`:

1. 実装の候補選択を呼び出さない独立した列交差計算・混合の解析モーメントと、点焦点・有限焦点それぞれ全48曲線の面積・重心・σを照合。
2. 回転中心で全列が同じ応答となることを確認。点焦点では幅2 mmの矩形、σ=2/√12。有限焦点ではぼけ幅0.5271028037 mmの台形、σ=sqrt[(2²+0.5271028037²)/12]。いずれもFWHM=2 mm。
3. 支持域内では補間後の重心が固定再構成面と一致すること、端列代替では内向きにずれることを確認。
4. 列の左右対称性、360°周期性、実検出器から対象位置までのレイ交差と距離重みを確認。
5. 角度別の列寄与の和、累積表示の開始と終了、最終面積正規化を確認。
6. 表示ビン幅0.05→0.025 mmの収束と、900→1800角度でのσの変化を確認。
7. 別の積分式（正値部二乗で書いたCDF）と各ビンを照合し、検出器幅より狭い焦点・等しい焦点・広い焦点の台形／三角形の面積と形状を確認。
8. 焦点幅0の全48曲線とグリッドが、変更前の公開版2026-09-18.1から保存したSHA256と一致することを確認。ターゲット角の参照メタデータだけを変えても応答が変わらないことを確認。

これは定義した演算の実装検証であり、書籍曲線の数値データや実機測定との外部検証ではない。
