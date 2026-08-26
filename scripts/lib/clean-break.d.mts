export function replaceWithCleanBaseline(options: {
  connectionString: string;
  baselineSql: string;
  migrationTimestamp: number;
}): Promise<void>;
