# bd CLI のスキーマ互換性とアップグレード判断

## 要点

このリポジトリの Beads DB は embedded mode の
`.beads/embeddeddolt/bdboard` にあり、読み取り専用の確認で
`schema_migrations` の最大バージョンが **v65** であることを確認している。

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
