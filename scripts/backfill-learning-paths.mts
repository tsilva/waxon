import { getV2Client } from "../app/db/v2/client.ts";
import {
  enqueueLearningPathBackfills,
  runPendingJobs,
} from "../app/lib/v2/service.ts";

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const userIndex = process.argv.indexOf("--user");
const requestedUser = userIndex >= 0 ? process.argv[userIndex + 1] : null;
const pool = getV2Client().pool;
const rows = await pool.query<{ user_id: string; missing: string }>(
  `SELECT source.user_id, count(*)::text AS missing
     FROM waxon_v2.sources source
     JOIN waxon_v2.generation_runs run
       ON run.user_id = source.user_id AND run.id = source.active_run_id
     LEFT JOIN waxon_v2.source_learning_paths path
       ON path.user_id = run.user_id AND path.generation_run_id = run.id
    WHERE run.status IN ('ready','needs_attention')
      AND path.id IS NULL
      AND ($1::text IS NULL OR source.user_id = $1)
    GROUP BY source.user_id
    ORDER BY source.user_id`,
  [requestedUser],
).then((result) => result.rows);

if (dryRun) {
  console.log(JSON.stringify({ dryRun: true, users: rows }, null, 2));
  process.exit(0);
}

let queued = 0;
let processed = 0;
for (const row of rows) {
  queued += await enqueueLearningPathBackfills(row.user_id);
  for (let pass = 0; pass < 50; pass += 1) {
    const count = await runPendingJobs({ userId: row.user_id, limit: 20 });
    processed += count;
    if (count === 0) break;
  }
}
console.log(JSON.stringify({ queued, processed, users: rows.length }, null, 2));
