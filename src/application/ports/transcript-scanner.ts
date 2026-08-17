import type { Project } from '../../domain/project.js';
import type { SessionLink } from '../../domain/session.js';

export interface TranscriptScanner {
  /** 1tick分だけ走査して、見つかったリンクを返す */
  scan(input: {
    readonly projects: readonly Project[];
    readonly knownIdsByProject: ReadonlyMap<string, ReadonlySet<string>>;
    readonly now: Date;
  }): Promise<readonly SessionLink[]>;
}
