export interface DependencyWriterPort {
  addDependency(
    rootPath: string,
    issueId: string,
    dependsOnId: string,
  ): Promise<void>;
  removeDependency(
    rootPath: string,
    issueId: string,
    dependsOnId: string,
  ): Promise<void>;
}
