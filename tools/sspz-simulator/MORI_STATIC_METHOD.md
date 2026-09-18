# 森『CTとMRI』図6.25の手順に沿う静止寝台の体軸応答モデル

Version 2026-09-18.1. Implementation: `mori-static-core.js`.

## 目的と位置づけ

森ほか『CTとMRI―その原理と装置技術―』（コロナ社）、pp.72–74、式6.34、図6.24–6.25で説明される「各投影角での検出器列間補間→逆投影重み→1回転の合算→等面積正規化」を、幾何と応答の対応を追える独立した計算として示す。

各曲線は、各列が回転中心軸に投影される位置に固定した再構成面の応答である。各検出器列単独の寄与を表示したものではない。取得幾何、線源のz位置、検出器全体は固定し、評価する再構成面を選ぶ。

**図6.25の数値的再現を達成したという主張ではない。** 本書の図に有限焦点の寸法、局所開口幅の取り扱いなど全条件が明示されていないため、以下の追加仮定を宣言する。特定装置、商用再構成、ヘリカル、多列の全条件を検証する機能ではない。

## 書籍由来の条件と追加仮定

| 項目 | 採用値・規則 | 根拠・適用範囲 |
|---|---|---|
| 検出器列数 | 16 | 図6.25 |
| 体軸方向列ピッチ・開口 | 回転中心換算でともに2 mm | 図6.25の2 mmを隙間のない理想列に適用 |
| 横断面内位置 | r=0、80、160 mm | 図6.25 |
| 線源―回転中心距離R | 600 mm | 本書p.54の例を採用。図6.25に全幾何値が再掲されているわけではない |
| 線源―検出器距離D | 1070 mm | p.60のRF=600、RD=470から採用。回転中心換算の列寸法を固定すれば応答式からDは相殺 |
| 取得角度数 | 900、0°以上360°未満 | p.54の例を採用。900が図6.25の確定条件とはしない |
| 焦点 | 理想点焦点 | 有限焦点寸法を図6.6から転用しない |
| 検出器 | 線源中心の円弧検出器 | 体軸位置・開口は対象までの横断面内距離Lに比例して投影 |
| 体軸方向開口応答B | 局所投影幅を持つ高さ1の矩形 | p.58式6.8のΠ表現に合わせる。各角度で面積1にはしない |
| 列間補間 | 再構成面を挟む隣接2列の線形補間 | pp.73–74 |
| 端列範囲の外側 | 最も近い端列で代用、欠損角度率を表示 | 本文の内側データ代替に対応する明示的なモデル選択。書籍に代替演算の完全な仕様はない |
| 逆投影の距離重み | R²/L² | 本書pp.20–21の等角ファン座標でのL^-2に対応する距離因子 |
| 最終正規化 | 各SSPの面積を1 | 図6.25 |

矩形幅Tを使った後段の体軸平均化は加えない。面内の有限開口、ファン方向の再配列、ランプフィルタ、コーンの前処理重み、画像逆投影の全体は計算しない。この独立した体軸応答では、現在のヘリカルモデルと全演算が同一であるとはしない。面内ピッチ0.58 mmの設定を、この計算が評価したとも扱わない。

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

再構成面jはZ=qjに固定する。cβk≤Z≤cβ,k+1のとき、

    wβk = (cβ,k+1 − Z)/(cβ,k+1 − cβk)
    wβ,k+1 = (Z − cβk)/(cβ,k+1 − cβk)

を用いる。一つの列中心と一致するとその列の重みは1。範囲の外側では最も近い端列の重みを1にする。この場合、再構成面を挟む補間は成立していないため、`edgeFallback=true`とする。近接列代替を正常な両側補間と混同しない。

## 応答の形成

横軸zは**固定した再構成面に対して信号を置く体軸位置**である。矩形関数Πは区間内で1、区間外で0とする。

    Bβk(z) = Π[(z − cβk)/aβ]
    hβj(z) = Σk wβk Bβk(z)
    Wβ = (R/Lβ)²
    Hj(z) = (1/M) Σβ Wβ hβj(z)
    SSPj(z) = Hj(z) / ∫Hj(z) dz

各Bβkの高さは1で面積aβ。そのため、局所開口幅が角度により異なると、最終合算における角度別の面積寄与はWβ aβとなる。各角度でBを面積1にしてから平均する演算とは異なる。p.72にはBの場所依存を回転中心の値で代表する近似も述べられているが、本計算では局所的な幾何倍率を明示的に使用する。

1/Mは一回転の平均という共通係数であり、最終等面積正規化で相殺される。アニメーションの途中では、全900角度で求めた最終面積を分母として使用する。途中の曲線をその都度面積1にしてしまうと「積み重なる様子」が消えるため、その処理はしない。

## 数値計算と出力

- 既定の体軸表示ビン幅は0.05 mm。矩形の各ビンへの重なりを解析的に積分し、ビン平均として描く。これは有限測定対象や追加のzフィルタではない。
- 全列・全角度の開口支持域を覆う共通z範囲に、空のビンを追加する。支持域を切る外部指定グリッドはエラーとする。
- 面積はビン平均×ビン幅の和で計算する。最終SSPの積分は1。
- `centroid`と`sigma`は連続的な矩形混合の解析モーメントから計算する。`sampledCentroid`と`sampledSigma`は表示ビンから得た値であり、離散化の確認用に残す。
- `sigma`は一つのSSP自体の標準偏差である。開始角度間のFWHMのSDとは異なる。
- `fwhm`は表示ビン間を線形補間した外側の半値交点間距離。多峰性の場合にはその間の谷を含むため、形状の完全な要約ではない。主要な比較は曲線とσを用いる。
- `edgeCount/edgeFraction`は両側列がなく代替した角度の数と割合であり、再構成のデータ充足性を証明する指標ではない。

## API

`moriStaticConfig(input)` validates and returns configuration.

`moriStaticView(config,{row,radius,angleDeg})` returns fixed plane `zPlane`,
`source`, `transverseDistance`, `radialDistance`, `detectorDistance`,
`rowScale=L/R` (`magnification` is an alias for this local-to-isocentre scale),
`physicalMagnification=D/L`, numeric `rowCentres` and `detectorRowCentres` arrays,
`selected:[{row,weight,zCentre,apertureMm}]`, `backprojectionWeight`,
`edgeFallback` and `edgeSide`.

`moriStaticAngleProfile(config,{row,radius,angleDeg,z?})` additionally returns
the common `z`, selected weighted `components:[{row,weight,zCentre,apertureMm,profile}]`,
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

1. 実装の候補選択を呼び出さない独立した列交差計算・矩形混合の解析モーメントと、全48曲線の面積・重心・σを照合。
2. 回転中心での全列が同じ幅2 mmの矩形となること、σ=2/√12、FWHM=2 mmを確認。
3. 支持域内では補間後の重心が固定再構成面と一致すること、端列代替では内向きにずれることを確認。
4. 列の左右対称性、360°周期性、実検出器から対象位置までのレイ交差と距離重みを確認。
5. 角度別の列寄与の和、累積表示の開始と終了、最終面積正規化を確認。
6. 表示ビン幅0.05→0.025 mmの収束と、900→1800角度でのσの変化を確認。

これは定義した演算の実装検証であり、書籍曲線の数値データや実機測定との外部検証ではない。
