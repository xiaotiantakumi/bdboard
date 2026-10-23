// bdboard-v7sw: 属性ブロックを畳んだときの1行要約 (status · priority · type · labels)。
export function attributesSummary(input: {
  status: string;
  priority: number;
  issueType: string;
  labels: readonly string[];
}): string {
  const parts = [input.status, `P${input.priority}`, input.issueType];
  if (input.labels.length > 0) parts.push(input.labels.join(', '));
  return parts.join(' · ');
}
