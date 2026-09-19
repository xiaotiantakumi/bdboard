# bd CLI のスキーマ互換性とアップグレード判断

## 要点

このリポジトリの Beads DB は、2026-08-23 時点では embedded mode の
`.beads/embeddeddolt/bdboard` にあり、読み取り専用の確認で
`schema_migrations` の最大バージョンが **v65** であることを確認している。
2026-09-05 に dolt sql-server モードへ移行済み（詳細は下記「sql-server
モードへの移行」節）で DB パスと排他方式は変わっているが、以下のスキーマ
バージョン互換性の判断自体はモードに依存しない。

一方、beads **v1.2.2 以降**は、v1.2.0 / v1.2.1 で誤って公開された未検証の
マイグレーションを巻き戻すための保守リリースであり、DB スキーマは **v53** までしか
認識しない。したがって、この DB を v1.2.2 以降の `bd` で開くと、次のようなエラーで
`bd` 全体が利用不能になるおそれがある。

```
schema version mismatch: database is at v65, binary knows up to v53
```

これは `bd human respond` などの個別コマンドの不具合ではない。チケットの読み書き、
claim、Beads の同期を含む bdboard 運用全体を止める DB 互換性の問題である。

## 現在の運用

このマシンでは beads を **v1.2.1 に固定**している。固定理由は二つある。

- `bd-m7zzd` に起因する、v1.2.2 の `bd human respond` / `dismiss` の退行を避けるため。
- v65 まで進んだ既存 DB と、v1.2.2 以降が認識する v53 上限とのスキーマ非互換を避けるため。

そのため、互換性を確認するまでは `brew upgrade beads` を実行せず、`brew pin beads` を
維持する。別マシンでも、Dolt 同期で同じ DB 履歴を扱う前に同じ確認を行う。

## 誤ってアップグレードした場合の復旧

upstream の一次手順を使用する。

- 現行の説明: [Accidental 1.2.1 release recovery](https://github.com/gastownhall/beads/blob/main/docs/recovery/accidental-1-2-1-release.md)
- v1.2.2 タグ時点のファイル名: [RECOVERY-1.2.1.md](https://github.com/gastownhall/beads/blob/v1.2.2/docs/RECOVERY-1.2.1.md)

手順の概要は、対象 DB をバックアップしてから、Dolt SQL で v53 より新しい
`schema_migrations` の記録を削除し、`DOLT_COMMIT` するものになる。

```sql
DELETE FROM schema_migrations WHERE version > 53;
-- schema_migrations を DOLT_ADD してから DOLT_COMMIT
```

上流手順では可逆な復旧として扱われ、所要時間は約2分とされている。ただし DB を直接
変更する操作なので、コマンド、DB パス、バックアップ方法は必ず上流の最新版を読んで
対象環境に合わせる。ここにある要約だけで実行してはいけない。

一時的にコマンドを通す必要がある場合は、次の応急措置もある。

```bash
BD_IGNORE_SCHEMA_SKEW=1 bd <command>
```

ただし、これは根本復旧ではない。この設定中は **events 監査テーブルのバージョニングが
一時停止する**副作用があるため、通常運用や恒久対処として使わない。復旧手順を実施する
までの限定的なつなぎにとどめる。

## `brew pin` を解除する判断

pin を解除してよいのは、schema v65（または対象 DB の実際の最大 schema）を正しく読める
正式リリースが出たことを、次の順で確認できた場合だけである。

1. Homebrew で入る候補バージョンのリリースノートと upstream のコードを確認し、v65 以上を
   認識するスキーマ互換性の修正が含まれることを確認する。未リリースの `main` のコミットや
   HEAD build だけでは足りない。
2. 上流の migration / recovery ドキュメントを確認し、v1.2.1 由来の DB に対するアップグレード
   手順とロールバック手順が明記されていることを確認する。
3. 本番 DB のバックアップを取り、可能ならそのコピーで候補 `bd` の読み取りコマンドを試す。
   `schema version mismatch` が出ず、通常の読み取りができることを確認する。
4. `bd-m7zzd` の `human respond` / `dismiss` 退行も、必要な運用経路で解消済みであることを確認する。
5. 上記を記録してから `brew unpin beads` とアップグレードを行う。問題が出た場合に備え、
   バックアップと upstream の復旧手順を手元に残す。

いずれかが確認できない間は pin を解除しない。bdboard 側のバージョン警告は気付くための
補助であり、この DB 互換性を回復したり、アップグレードを安全に戻したりするものではない。

## sql-server モードへの移行（2026-09-05）

bdboard の bd は 2026-09-05 に embedded mode から **dolt sql-server モード**へ
移行済み（bdboard-62u / gate bdboard-7h8）。同日、bd 管理下の他プロジェクトも
同じ backup/restore 手順で server モードへ移行し、全件で issue 件数一致を確認
している。embedded mode は DB を開くだけでプロセスレベルの排他 `flock` を取る
ため、常時稼働サーバー + 並列エージェントからの `bd` 呼び出しと衝突していた。
sql-server モードでは dolt プロセスが 1 つ DB を保持し、各 `bd` 呼び出しは
クライアント接続になる。

移行や `bd init --server` を伴う復旧作業を行う際の注意点。

- `bd init --server` も、[GIT-WORKFLOW.md](GIT-WORKFLOW.md) の「`.beads/`
  Dolt sync」節にある `bd init` / `bd bootstrap` の git origin 自動採用と同じ
  罠を踏む。実行後は必ず `bd dolt remote list` で origin が無いことを確認する
  手順に従うこと（手順の詳細は同節を参照。bd 1.2.1 は `bd dolt remote add` で
  git origin を指す URL を既定で拒否するが、`--allow-git-origin` で強行できる
  点に注意）。
- `bd init` は main に直接 autocommit することがあり（`.beads` を gitignore
  している repo では commit せず作業ツリーに差分を残す）、`AGENTS.md` の
  customization を消しうる。machine 固有の `.beads/dolt-server-config.yaml` も
  コミットしてしまうことがあるため、実行後は `git diff -- AGENTS.md` を確認し、
  `dolt-server-config.yaml` / `dolt-backup.json` を `.beads/.gitignore` に入れて
  追跡から外す。
- issue ID の接頭辞は DB 内に保存されており、backup restore で復元される
  （`bd init` の `--prefix` より優先）。DB 名と接頭辞が食い違うリポジトリでは、
  `bd init` に `--database <既存DB名>` を渡せば restore が正しく当たる。
- `bd list --all` は `bd status` の Total より少なく出ることがある。移行検証は
  同じ方法で前後比較するか、dolt backup を restore した一時ディレクトリで
  `dolt sql -q 'select count(*) from issues'` を数えて突き合わせる。
- ロールバック用バックアップは、移行前に取得した embedded 版一式と
  dolt-native なバックアップの二系統を安定確認できるまで残す。安定確認後は
  ディスク容量のため削除してよい。
