// bdboard-sso1.19: sqlite-board-cache.ts から移動した DB 行の型定義。
// schema.ts / convert.ts / read.ts / write.ts から共有される。中身は1文字も変えていない。

export interface ProjectRow {
  readonly id: string;
  readonly name: string;
  readonly root_path: string;
  readonly prefixes: string;
  readonly alias_paths?: string | null;
  readonly fingerprint: string;
  readonly fetched_at: string;
  readonly tickets: string;
  readonly pending_decisions?: string | null;
}

export interface TranscriptOffsetRow {
  readonly file_path: string;
  readonly byte_offset: number;
}

export interface SessionUsageRow {
  readonly model: string;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_creation_input_tokens: number;
  readonly cache_read_input_tokens: number;
}

export interface MetaRow {
  readonly value: string;
}

export interface SessionLinkRowDb {
  readonly ticket_id: string;
  readonly session_id: string;
  readonly project_id: string;
  readonly source: string;
  readonly confidence: number;
  readonly observed_at: string;
}

export interface CfdSnapshotRowDb {
  readonly project_id: string;
  readonly status: string;
  readonly snapshot_date: string;
  readonly snapshotted_at: string;
  readonly count: number;
}

export interface InteractionRowDb {
  readonly id: string;
  readonly at: string;
  readonly actor: string;
  readonly ticket_id: string;
  readonly field: string;
  readonly old_value: string | null;
  readonly new_value: string | null;
  readonly reason: string | null;
}

export interface SqliteMasterRow {
  readonly name: string;
}

export interface TableInfoRow {
  readonly name: string;
}
