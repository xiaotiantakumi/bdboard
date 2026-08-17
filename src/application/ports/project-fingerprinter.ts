import type { Project } from '../../domain/project.js';

export interface ProjectFingerprinter {
  /** プロジェクトの「変わったか」を表す指紋。読めないものは無視して算出する */
  fingerprint(project: Project): Promise<string>;
}
