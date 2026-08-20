export type BuildSpawn = (
  command: string,
  args: string[],
  options: {
    env: Record<string, string | undefined>;
    stdio: "inherit";
  },
) => {
  error?: Error;
  status: number | null;
};

export function runBuild(options?: {
  environment?: Record<string, string | undefined>;
  spawn?: BuildSpawn;
}): number;
