# ヘックス地形画像 生成指示（チャッピー＝画像生成AI 用）

> 目的: 盤面のヘックスを「色だけ」から「ひと目で何が取れるか分かる地形イラスト」にする。
> この文書の「4. 各地形のプロンプト」をそのままコピペして画像を作らせる。

---

## 1. 使い方（技術前提：これに合わせて作る）

- 盤面のマスは **正六角形（flat-top＝上下が平らな辺・左右が尖る向き）**。
- 実装では **正方形の画像を六角形のマスクで切り抜いて** マスに敷く。
  - つまり **画像は正方形でOK**。四隅と上下のへりは六角形からはみ出て切り取られる。
  - → **重要な要素（その地形らしさ）は中央寄りに**。隅に小さな主役を置かない。
- マスの中央には **数字ディスク（白い丸＋黒い数字）** が後から重なる。
  - → **画像の中央付近は“穏やか”に**（真ん中に高コントラストの主役・真っ白/真っ黒の塊を置かない）。模様は全体に散らす。
- マスの縁取り（線）は実装側で描く。**画像に枠・縁・影の外周は不要**。

---

## 2. 共通仕様（全画像で必ず守る）

- **形**: 正方形（1:1）。
- **サイズ**: 1024×1024 px（最低 512×512）。PNG。
- **塗り**: **全面塗り（フルブリード）**。背景の透明部分は作らない（切り抜きは実装側でやる）。
- **入れない**: 文字・数字・ロゴ・枠線・UI・コマ（家や盗賊）・地形以外の説明。
- **視点**: 真上〜やや俯瞰の一定アングル。**8枚すべて同じ視点・同じ光の向き・同じ画風**でそろえる（バラけると盤面が不統一になる）。
- **明るさ**: 小さく表示（実機で約100〜150px）しても判別できるよう、**色は濃いめ・要素は大きく単純に**。ごちゃごちゃさせない。
- **色**: 各地形の「指定色」を主役の色にする（現行盤の色に合わせると統一感が出る）。

> コツ: できれば1回のセッションでまとめて、または「前の画像と同じ画風で」と指定して8枚そろえると失敗が少ない。

---

## 3. 画風（統一テイスト）

「**カタン公式ボードのような、温かみのある手描き調イラスト**。やわらかい陰影、少しデフォルメ、彩度高め、フレンドリー。写真ではなくイラスト。」

英語で指定する場合の共通スタイル句（各プロンプト末尾に付ける）:

```
warm hand-painted board-game illustration, soft shading, slightly stylized, friendly and vibrant, top-down slightly elevated view, even texture with no single high-contrast object in the dead center, full-bleed square, no text, no numbers, no border, no frame, no game pieces, consistent lighting
```

---

## 4. 各地形のプロンプト（必須6＋推奨2）

各地形、日本語の意図＋英語プロンプト。英語の方が安定しやすい。`{共通スタイル句}`＝上の英語句。

### ① 森（→ 木材）　指定色 #2d6a2d（深い緑）　ファイル名 `tile-forest.png`
- 意図: 上から見た深い森。丸い緑の樹冠が密に並ぶ。木材＝森。
- EN: `A dense lush forest seen from above, rounded green treetops with a few darker pine trees, deep forest green (#2d6a2d), {共通スタイル句}`

### ② 畑（→ 麦／穀物）　指定色 #c8a830（黄金色）　ファイル名 `tile-field.png`
- 意図: 実った小麦畑。畝（うね）がうっすら見える金色の畑。
- EN: `A ripe golden wheat field with subtle plowed rows, warm golden yellow (#c8a830), {共通スタイル句}`

### ③ 牧草地（→ 羊毛）　指定色 #6dbf4a（明るい緑）　ファイル名 `tile-pasture.png`
- 意図: なだらかな緑の牧草地。小さな羊が1〜2匹（中央以外に小さく）。羊毛＝牧草。
- EN: `A green rolling grassland meadow with one or two small grazing sheep placed off-center, fresh bright green (#6dbf4a), {共通スタイル句}`

### ④ 丘（→ レンガ／粘土）　指定色 #b85c2a（赤茶）　ファイル名 `tile-hill.png`
- 意図: 赤茶色の粘土の丘・採土場。テラコッタ色のなだらかな丘。
- EN: `Red-brown clay hills and a small claypit, terracotta soil, gentle earthy mounds (#b85c2a), {共通スタイル句}`

### ⑤ 山（→ 鉱石）　指定色 #888888（灰）　ファイル名 `tile-mountain.png`
- 意図: 岩の山。露出した鉱脈（鉱石のきらめき）が見える灰色の岩山。
- EN: `Rocky grey mountain peaks with exposed ore veins glinting in the stone, stone grey (#888888), {共通スタイル句}`

### ⑥ 砂漠（資源なし）　指定色 #d4b870（砂色）　ファイル名 `tile-desert.png`
- 意図: 不毛な砂丘。淡い砂色、まばらな岩。資源は出ない＝何もない感じ。
- EN: `Barren pale sandy desert dunes with a few scattered rocks, soft tan sand (#d4b870), {共通スタイル句}`

### ⑦【推奨】金タイル（→ 任意資源）　明るい金色＋輝き　ファイル名 `tile-gold.png`
- 意図: きらめく黄金の地。麦（黄土色）と紛れないよう、**明るく輝く金色**で差別化。
- EN: `A shimmering golden land glinting with gold nuggets and sparkles, radiant bright gold, clearly more brilliant and metallic than a wheat field, {共通スタイル句}`

### ⑧【任意】海　指定色 #1f6f8b（青）　ファイル名 `tile-sea.png`
- 意図: 穏やかな青い海。やさしい波のハイライト。（現状の海は無地でも可。雰囲気を出したい場合のみ）
- EN: `Calm blue ocean water with gentle wave highlights, deep teal blue (#1f6f8b), {共通スタイル句}`

---

## 5. 納品

- 上記ファイル名（`tile-森.png` ではなく英語名 `tile-forest.png` …）で、**正方形PNG**を8枚（最低6枚）。
- 受け取ったら `src/assets/` に置く。

---

## 6. 実装（こちら側で対応すること）

画像が `src/assets/` に揃ったら、次を実装する（画像が来てから着手）:
- `src/assets/manifest.ts` に8枚を import し `ASSETS.tile.{forest,field,...}` を追加。
- `src/renderer/board.ts` の `renderTile` で、六角形 `polygon` の上に `<image>` を敷き、
  六角形の `clipPath`（または `<polygon clip>`）でマスクする。数字ディスク・盗賊・港は従来どおり画像の上に描く。
- 既存の `.hex-tile.<terrain>` の色塗りは **画像読み込み前/欠落時のフォールバック**として残す。
- 初心者モードのホバー説明（資源名＋アイコン）とは別レイヤーなので干渉しない。
- 検証: `tsc` / `vitest` / `npm run build` 緑、実ブラウザで全地形＋数字ディスクの視認性を確認。

> 代替案（アートを作らない場合）: 既存の `res-*.png`（木材/レンガ/羊毛/麦/鉱石の小アイコン）を
> マス中央やや上に小さく重ねるだけでも「何が取れるか」は伝わる。フルの地形イラストの方が没入感は高い。
