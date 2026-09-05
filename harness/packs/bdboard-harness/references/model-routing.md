# モデル振り分け

規律6の詳細。振り分け表の正本は、対象プロジェクトの
`.claude/bdboard-harness.json` の `models.routes`。
モデルの可用性は実行する CLI が判断し、議長は候補の順番と品質の昇格条件を守る。

## 着手時の複雑度

議長が `bd show <id>` と対象の grep を各 1 回行って見積もる。
high の条件があれば、ファイル数にかかわらず high を選ぶ。

| 複雑度 | ルーブリック |
| --- | --- |
| low | 対象ファイルが特定済み（または grep 1 回で確定）**かつ** 1〜2 ファイル **かつ** 公開契約（型・API・スキーマ・hook・`help-content.json` の構造）を変えない。 |
| high | 層をまたぐ（domain⇄interface、server⇄web）、セキュリティ境界（write-guard・hooks・contract parser・auth）、並列セッション整合（reclaim・merge-slot）、不可逆操作、のいずれか。 |
| med | それ以外。**迷ったら med**。 |

記録するメタデータは次の 2 つ。

| キー | 値 | 記録の意味 |
| --- | --- | --- |
| `bdboard.complexity` | `low` / `med` / `high` | 現在の複雑度。 |
| `bdboard.complexity.source` | `declared` / `estimated` / `escalated` | 人間の事前指定 / 議長の推定 / 品質の失敗による昇格。 |

初回推定の記録例（med と判断した場合）:

```bash
bd update <id> --set-metadata bdboard.complexity=med \
  --set-metadata bdboard.complexity.source=estimated
```

**declared は人間が事前に置いた値なので、自動上書きしない。降格は人間のみ。**
再開時は既存の推定・昇格を尊重し、もう一度見積もった結果だけで低い値に戻さない。
宣言値の変更が品質上必要になった場合も、理由を記録して人間に判断を返す。

## 候補表と route.sh

契約の例（既存の version / verify / prFlow などに `models` を追加する）:

```json
{
  "models": {
    "routes": {
      "implement": {
        "low": ["cursor:composer-2.5-fast", "claude:haiku"],
        "*": ["cursor:composer-2.5", "claude:sonnet"]
      },
      "review": { "*": ["claude:opus"] },
      "check": { "*": ["claude:fable", "claude:opus"] }
    }
  }
}
```

対象プロジェクト/worktree のルートで呼ぶ。スクリプト自身の配置場所から別のリポジトリを
推測しないので、正本パックのスクリプトを絶対パスで呼んでも **cwd の契約**を読む。

```bash
bash .claude/skills/bdboard-harness/scripts/route.sh implement low
```

この例では `cursor:composer-2.5-fast`、`claude:haiku` の順で 1 行ずつ出力する。
`implement med` は `*` の列になる。個別セルがあれば `*` の候補は連結しない。
候補の順番は配列の順番そのままで、並べ替えない。

| 状況 | 結果 |
| --- | --- |
| 該当セルが定義済み | そのセルの候補列。 |
| セル未定義、同じ工程に `*` あり | `*` の候補列。 |
| 契約 / `models` / 工程 / セル（`*` も）が無い | 無出力、exit 0。呼び出し側の従来の既定動作へ。 |
| jq がある | jq で JSON を読む。 |
| jq が無く python3 がある | python3 で同じ選択を行う。 |
| 両方の JSON ツールが無い | stdout は空、stderr に診断、**exit 127**。既定動作へは落ちない。契約ファイルが在るときだけ判定する (契約が無ければ読む必要が無いので exit 0 のまま)。 |

jq 経路と python3 経路は、**出力する候補と終了コードが一致するように書いてある** (候補文法の
検証は両者とも完全一致で、`^`/`\z` と `re.fullmatch` が同じ判定になることを実測で確認済み)。
既知の非等価は JSON パーサ自体の深さ上限だけで、jq は 256 段で落ちる。現実の契約では踏まない。
| JSON / 読み取る構造 / 選択セルの候補が不正、読取失敗 | stdout は空、stderr に診断、exit 1。契約を修正する。 |
| 引数不足・過剰、工程名や複雑度の書式不正 | stderr に usage、exit 2。呼び出しを修正する。 |

工程名は英小文字始まりの英小文字・数字・ハイフンで 1〜32 文字、複雑度は
`low` / `med` / `high`。候補は `member:model` 形式で 1〜6 個、同一セルの重複は禁止。
member は英小文字始まりの英小文字・数字・ハイフンで最大 16 文字、model は英数字始まりの
英数字・`.`・`_`・`-` で最大 64 文字。`claude:` の model は haiku / sonnet / opus / fable のみ。
`null` や空配列は未定義と同一視しない。セルが不正でも `*` へ落とさない。
`*` が無い工程は契約全体では 3 段すべての宣言が必要。
route.sh は選択に必要な構造と候補を検証する読み取り専用ツールであり、契約全体の検証や
モデルの実行は行わない。**選択に無関係な工程や、選択したセル以外の不正**は素通りする —
例えば `*` の無い工程で `low` だけを宣言した契約は、ボードでは不正だが
`route.sh <その工程> low` は候補を返す。契約全体の妥当性はボードの契約検証で確認する。

`*` は既定値であって排他ではない。同じ工程に `*` と個別キーを併記でき、**個別キーが勝つ**。

## 呼び出し側と委譲先の責任

議長は出力された候補から 1 件を選び、`:` の前を member、後ろを model として渡す。
`cursor-implementer` へは `member=cursor` と選んだ model を渡し、エージェント側で
モデルを再選択・固定しない。別 member の候補はその member の委譲経路へ送る。
`models` が無い場合も、従来の既定モデルを決めて渡す責任は呼び出し側にある。
ユーザーの明示したモデル指定があればそれを優先する。

実際に使ったモデルは、作業したエージェント自身が工程ごとに記録する:

```bash
bd update <id> --set-metadata bdboard.model.<stage>=<model>
```

## 可用性フォールバックと品質エスカレーション

**2 種を混ぜない。** rate limit に当たったという理由で複雑度は上がらない。

| フロー | 機械的なトリガー | 次に試す場所 | メタデータ・証拠 |
| --- | --- | --- | --- |
| 可用性フォールバック | rate limit / bin 不在 / タイムアウト / 同じ候補で 0 編集 2 連続 | **同じセルの次候補** | 複雑度も source も変更しない。失敗した候補と理由を残す。 |
| 品質エスカレーション | (a) 委譲成果の verify が赤、かつ同じセルで再委譲 1 回も赤。(b) レビューの major 以上の指摘が 3 件超（4 件以上）。(c) low 推定なのに当該作業の差分が 3 ファイル以上。**この 3 つだけ**。 | **1 段上のセル**（low → med → high）の先頭候補 | 新しい複雑度と `source=escalated` を記録し、`bd comment` に理由を 1 行残す。 |

低いセルの残り候補を使い切ることは品質昇格の条件ではない。
逆に、可用性で全候補が尽きても品質昇格しない。候補・失敗理由を報告して呼び出し側へ戻す。
verify はプロジェクトの契約で定めたフル検証を指す。同じセルでの再委譲は 1 回までで、
赤を無制限に再試行しない。差分のファイル数は当該作業のものを数え、無関係な既存変更は含めない。

low から med へ品質昇格する記録例（declared の場合は自動実行しない）:

```bash
bd update <id> --set-metadata bdboard.complexity=med \
  --set-metadata bdboard.complexity.source=escalated
bd comment <id> "品質昇格 low→med: verify が赤、同じセルで再委譲 1 回も赤"
bash .claude/skills/bdboard-harness/scripts/route.sh implement med
```

high には上のセルが無い。失敗理由を報告し、未検証の成果を成功扱いしない。
declared の上書き禁止と人間のみの降格は、このフローでも維持する。

## トラブルシュート

- **何も出ない**: exit code と stderr を先に確認する。exit 0 なら cwd と契約の有無、
  `models.routes.<stage>` の個別セル / `*` を確認する。契約の探索は cwd だけ。
- **Permission denied**: `scripts/` は実行ビット無しの 100644 で配布する。
  直接実行せず `bash <script>` で呼ぶ。hooks の実行ビットとは別の扱い。
- **jq / python3 が見つからない**: 非対話シェルの `command -v` で PATH を確認する。
  スクリプトは端末固有の絶対パスを決め打ちしない。**この場合は exit 127 で止まる** —
  「候補が無い」(無出力 exit 0) と「そもそも振り分けを解決できなかった」を呼び出し側が
  区別できる必要があるため、黙って既定動作へは落とさない。どちらかを入れて再実行する。
  なお**ツールの有無は呼ぶ前に `command -v` で決めており、呼んだ結果の終了コードでは
  判定しない**。PATH が痩せた非対話シェルで pyenv shim が
  `env: bash: No such file or directory` を出して 127 で終わる、という実例があり、
  終了コードで判定すると「ツールが在るのに壊れている」を「ツールが無い」と誤診断して
  操作者を間違った方向へ誘導する。診断メッセージには実際に使った経路 (`via jq` /
  `via python3`) を載せてあるので、読取エラーはそちらで切り分ける。
- **契約読取エラー**: JSON、選択セルの型・空配列・重複・候補文法を確認する。
  生の不正候補は診断に出力しない。jq が失敗した場合に python3 へ再解釈させない。
- **モデルが存在しない / CLI が起動しない**: 可用性の失敗として同じセルの次候補へ。
  他 member のモデル実在性はボード側では判断しない。
- **declared と推定が食い違う**: 宣言を保持し、根拠をコメントして人間へ判断を返す。
- **台帳への記録が失敗する**: 未記録のキー・コマンド・エラーを報告する。
  記録できたと装わず、実行済みの候補と検証結果を保持して再開できるようにする。
