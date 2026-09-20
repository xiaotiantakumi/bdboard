// bdboard-sso1.20: ThroughputStats.tsx から自己完結した表示専用コンポーネントを
// 移動しただけのファイル。挙動は一切変えていない。
export function ChartBlockHeader({
  heading,
  description,
  level,
}: {
  heading: string;
  description?: string;
  level: 4 | 5;
}) {
  const Heading = level === 4 ? 'h4' : 'h5';

  return (
    <>
      <Heading className="throughput-chart-heading">{heading}</Heading>
      {description !== undefined && (
        <p className="throughput-chart-description">{description}</p>
      )}
    </>
  );
}
