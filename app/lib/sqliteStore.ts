import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { getCurrentUser } from "./auth";
import { questionSlug } from "./questionSlug";
import { appendReview, parseReviews, scheduleNextReview } from "./scheduler";

export type QuestionRow = {
  deck_id: string;
  deck_name: string;
  user_id: string;
  question: string;
  reviews: string;
  next_due: number;
  last_answer: string;
  last_answer_summary: string;
  reference_answer: string;
};

export type DueQuestion = {
  deckId: string;
  deckName: string;
  question: string;
  reviews: string;
  nextDue: number;
  lastAnswer: string | null;
  lastAnswerSummary: string | null;
  referenceAnswer: string | null;
};

export type QuestionAttempt = {
  id: number;
  deckId: string;
  question: string;
  rawAnswer: string;
  answerSummary: string;
  score: number;
  justification: string;
  submittedAt: number;
  resolvedAt: number;
};

export type PersistedEvaluation = {
  deckId: string;
  deckName: string;
  question: string;
  reviews: string;
  nextDue: number;
  lastAnswer: string | null;
  lastAnswerSummary: string | null;
  referenceAnswer: string | null;
} | null;

const DATA_DIR = path.join(process.cwd(), "data");
const QUESTIONS_DB_FILE = path.join(DATA_DIR, "questions.sqlite");
const LEGACY_QUESTIONS_FILE = path.join(DATA_DIR, "questions.csv");
const DEFAULT_DECK = {
  id: "deep-learning",
  name: "Deep Learning",
  slug: "deep-learning",
};
const BOOTSTRAP_QUESTIONS = Array.from(
  new Set(
    String.raw`
What is the basic supervised training loop?
What does a supervised loss measure?
Does loss directly measure distance from ideal parameters?
In classification, what does cross-entropy penalize?
With gradient descent, what happens to a parameter when its loss gradient is positive?
With gradient descent, what happens to a parameter when its loss gradient is negative?
What is the gradient descent update rule for one parameter?
What does $\frac{dL}{dw} = 0.3$ mean locally?
If $\frac{dL}{dw} = -0.7$, what local change to $w$ decreases loss?
What does the learning rate scale?
Why is a raw gradient not an exact correction for an example?
What can happen if the learning rate is too high?
Why use mini-batches instead of single-example updates?
What does a full-batch gradient represent?
Why can larger batches often support larger learning rates?
What does training loss down while validation loss rises usually indicate?
What should be checked before trusting an overfitting diagnosis?
Why can data augmentation improve generalization?
What makes an augmentation unsafe?
What is an inductive bias in a model architecture?
What bias do shared CNN filters create?
What is translation equivariance?
What is translation invariance?
Why should early vision layers preserve spatial location?
What is attention's core role in a transformer?
In attention, what do queries and keys determine?
How are Q, K, and V produced in a transformer layer?
If $\frac{dL}{dy} = 48$ and $\Delta y = 0.01$, what is the approximate $\Delta L$?
For one variable $z$ with local derivative $\frac{dL}{dz}$, how do you estimate the loss change from a small $\Delta z$?
If $L = y^2$, what is $\frac{dL}{dy}$?
Why are local derivatives multiplied along a chain?
For $h = wx$, $y = 2h$, $L = y^2$, $w = 3$, and $x = 4$, what is $\frac{dL}{dw}$?
For input batch shape (batch, in_features) and weight shape (in_features, out_features), what is the output shape?
When adding bias shape (out_features,) to activations shape (batch, out_features), how is the bias broadcast?
For logits shape (batch, classes), what does one row represent?
For target class k, what pressure does cross-entropy put on logits?
Why can a classification target be class ID 0 instead of one-hot vector [1, 0, 0, 0]?
With logits shape (batch, classes) and targets shape (batch,), how many per-example losses are computed before reduction?
Why reduce per-example losses to one scalar before backprop?
For the same batch, how does mean-reduction gradient compare to sum-reduction gradient?
If you switch from sum loss to mean loss and keep the same learning rate, what happens to update size?
Why call zero_grad() before backprop on the next batch?
What is gradient accumulation used for?
What is the usual order of a training step?
What can happen if optimizer.step() runs before loss.backward()?
What does eval mode change during validation?
What does no-grad or inference mode change during validation?
Why should dropout be disabled during validation?
Why should batch norm use eval mode during validation?
Why not use validation data for gradient updates?
Why keep a final test set separate from validation?
What validation split problems should be checked before changing model capacity or regularization?
Why can training loss be higher than validation loss without a bug?
What is the failure mode of too-aggressive augmentation?
When is an augmentation appropriate?
Why can CNNs need less image data than MLPs?
Why do stacked CNN layers support hierarchical visual features?
Given dL/dw = -20, manual Delta w = +0.03, and optimizer learning rate eta = 0.03, what are approximate Delta L and optimizer Delta w?
Given w = 2.0, dL/dw = +8, and optimizer learning rate eta = 0.05, what are optimizer Delta w and new w?
Given w = 7.0, dL/dw = -6, and optimizer learning rate eta = 0.2, what are optimizer Delta w and new w?
You increase batch size from 32 to 4096, keep the same optimizer and learning rate, and training becomes much less noisy but also makes slower progress per epoch. What are two plausible reasons?
If loss uses mean reduction, and batch size increases from 32 to 4096, what happens by default to gradient noise vs expected gradient scale?
If batch size is 100 and sum-reduction gradient is 500, what would the mean-reduction gradient be for that same batch?
A training script accidentally changes CrossEntropyLoss(reduction="mean") to reduction="sum" while keeping the same batch size and learning rate. What happens to the effective update size, and what symptom might you see during training?
You change batch size from 32 to 128, keep reduction="mean" and the same learning rate. Compared to before, do you expect each optimizer step to be automatically 4x larger, 4x smaller, or neither by default? Why?
A model is training with batch size 32, reduction="mean", and learning rate 1e-3. You increase batch size to 512. Name one thing that improves and one thing you may need to retune or watch.
Same dataset, same number of epochs: if batch size increases from 32 to 512, what happens to the number of optimizer updates per epoch?
A classifier outputs logits with shape (64, 10), and the targets have shape (64,). What does one row of the logits represent, and what does one target integer represent?
Suppose after softmax, one example has class probabilities [0.1, 0.7, 0.2], and the target class index is 1. Which number does cross-entropy take the negative log of?
Probabilities are [0.92, 0.05, 0.03], and the target class index is 1. Does cross-entropy produce a small or large loss, and why?
In PyTorch, CrossEntropyLoss expects raw logits, not softmax probabilities. Why is it usually better to pass logits directly instead of applying softmax yourself first?
During training, your classifier's final layer outputs shape (64, 10). You apply softmax, then pass the result into CrossEntropyLoss. What is the bug, and what should you pass instead?
Why is passing softmax probabilities into CrossEntropyLoss not just redundant, but the wrong API usage?
For logits [2, 1, -1] with target index 0, which is bigger: logsumexp(logits) or the largest logit 2, and why?
If logits are [2, -100, -100] and the target is class 0, will the cross-entropy loss be near 0 or large? Why?
If logits are [4, -2, 0] and the target class index is 2, what is the target logit value used in logsumexp(logits) - target_logit?
For logits [4, -2, 0] and target class index 2, is the cross-entropy loss closer to 0, 4, or 100? Use logsumexp(logits) - target_logit qualitatively.
Why does computing logsumexp([1000, 999]) naively as log(exp(1000) + exp(999)) risk numerical overflow, and what does subtracting the max logit change inside the exponentials?
Natural log maps 1 to 0 and e ~= 2.718 to 1. Is log(1.1) closer to 0 or 1?
Now use the same anchors: is ln(1.368) closer to 0 or to 1, and why?
Put it together: why is logsumexp([1000, 999]) about 1000.313 instead of about 1001?
Without exact calculation, if the shifted logits are [0, -1], why must the logsumexp correction ln(exp(0) + exp(-1)) be less than ln(2)?
Since exp(-1) = 1 / exp(1), and exp(1) = e ~= 2.718, is exp(-1) about 0, about 0.37, or about 2.7?
Directed recall: what is exp(1) equal to, approximately?
Directed recall: complete the pattern exp(-a) = ?
Is exp(-3) exactly zero, or a small positive number? Use the reciprocal rule.
Simpler analogy: if you factor x^10 out of x^3, what leftover factor do you need so that x^10 * leftover = x^3?
Same pattern: if you factor exp(1000) out of exp(100), what leftover factor do you need so that exp(1000) * leftover = exp(100)?
Fill in the blank: exp(1000) + exp(100) = exp(1000) * (exp(0) + ___).
Now take ln of both sides: why does ln(exp(1000) * (exp(0) + exp(-900))) become 1000 + ln(exp(0) + exp(-900))?
If logits are [1000, 100], what goes wrong with naive softmax's exp(1000) step, and how does subtracting the max avoid it?
For a 3-class one-hot target [0, 1, 0] and predicted probabilities [0.2, 0.7, 0.1], what terms remain in the general cross-entropy sum -sum target_i * log(prob_i)?
If the target class is 1, and softmax says p_target = exp(logit_1) / sum_j exp(logit_j), what expression do we get when substituting that into CE = -ln(p_target)?
Algebra-only: if A = ln(exp(logit_i)) and B = ln(sum_j exp(logit_j)), what is -(A - B)?
Now simplify -ln(exp(logit_i)) + ln(sum_j exp(logit_j)). What does it become using ln(exp(x)) = x and logsumexp(logits) = ln(sum_j exp(logit_j))?
In one sentence, why does cross-entropy with a one-hot target reduce to logsumexp(logits) - target_logit?
Complete the sentence: one-hot cross-entropy becomes -ln(p_target), and because p_target = exp(target_logit) / sum_j exp(logit_j), this simplifies to what?
Sign check: what is ln(sum_j exp(logit_j)) equal to in shorthand: logsumexp(logits) or -logsumexp(logits)?
Final recap: in one or two lines, derive CE = logsumexp(logits) - target_logit from CE = -ln(p_target) and the softmax formula for p_target.
Directed recall: what are the four anchor formulas exp(1), exp(-a), ln(1), and ln(exp(x))?
A linear layer maps input shape (batch, 20) to output shape (batch, 5). What shape should its weight matrix have if we use the convention output = input @ W + b?
Concrete version: if input is (32, 20), W is (20, 5), and b is (5,), what is the shape of input @ W, and what shape is b broadcast to when added?
Bug check: a batch has input shape (32, 20), but your linear layer was created with weight shape (10, 5) under input @ W. What dimension mismatch causes the error?
In matrix multiply (32, 20) @ (10, 5), which two dimensions are supposed to match, and what are their actual values here?
If the multiply were valid as (32, 20) @ (20, 5), which dimensions survive into the output shape?
A classifier outputs logits shape (32, 5), but the target tensor has shape (32, 5) with one-hot rows. If using PyTorch CrossEntropyLoss in its usual class-index mode, what target shape should it have instead, and what does each value mean?
Your model outputs logits (16, 3), targets are class indices (16,), and CrossEntropyLoss(reduction="none") is used. What shape is the unreduced loss, and what does each element represent?
If that (16,) unreduced loss is changed to reduction="mean", what shape is the final loss, and why is a scalar convenient for backprop?
In a normal PyTorch training step, should optimizer.step() happen before or after loss.backward(), and why?
What can go wrong if you forget optimizer.zero_grad() before the next backward pass?
When is it intentional to not call optimizer.step() after every backward() call, and what training technique is that?
If you want an effective batch size of 128 but can only fit micro-batches of 32, how many micro-batches would you accumulate before one optimizer step?
If each micro-batch loss is already a mean over 32 examples and you accumulate 4 micro-batches, why might you divide each loss by 4 before calling backward()?
Training bug: validation loss is computed without torch.no_grad(), but you still never call backward() on it. What is the main problem?
If dL/dw = -12 at the current point and you manually nudge w by +0.04, what is the approximate change in loss, and is this an optimizer update?
Same gradient: dL/dw = -12. If the optimizer uses learning rate 0.04, what Delta w does gradient descent apply?
If a full-batch gradient is the exact gradient of the current training-set loss, why might mini-batches still train better or faster in practice?
What is one way mini-batch gradient noise can help optimization or generalization, compared with a deterministic full-batch gradient?
Imagine two parameter regions fit training equally well: one is very sharp, where tiny parameter changes quickly hurt loss, and one is flat, where tiny changes barely hurt loss. Why might mini-batch noise make the flat region easier to stay in?
In mini-batch SGD, each batch gives a slightly different gradient estimate. If the full-dataset gradient points straight downhill, why might the mini-batch gradient sometimes point a bit sideways instead?
Suppose the full-dataset gradient is mostly [downhill=1.0, sideways=0.0], but one mini-batch gives [downhill=1.0, sideways=0.3]. In this toy setup, which part is the useful downhill signal and which part is stochastic sideways noise?
If logits has shape (32, 5) and target[0] = 2, which single logit does cross-entropy use as the true-class logit for the first example?
If logits[0] = [1.2, -0.4, 3.0, 0.7, -2.1] and target[0] = 2, what is the true-class logit value, and why is that value not itself a probability?
If logits[0] = [1.2, -0.4, 3.0, 0.7, -2.1] and target[0] = 2, what is the true-class logit value?
Why is the value 3.0 a logit rather than a probability?
What two constraints must class probabilities satisfy that raw logits do not?
What operation converts logits into class probabilities?
If you apply softmax to model outputs before passing them to PyTorch CrossEntropyLoss, what is the mistake?
For logits shape (64, 10), what shape should class-index targets have for PyTorch CrossEntropyLoss?
If a batch has 64 examples, how many class-index target values should the target tensor contain?
So for logits shape (64, 10), what is the class-index target tensor shape?
During validation, what different problem does model.eval() solve compared with torch.no_grad()?
Sign check: starting from CE = -ln(exp(target_logit) / sum_j exp(logit_j)), what does it simplify to?
What is ln(A / B) equal to in terms of ln(A) and ln(B)?
Then what is -ln(A / B) equal to?
In attention, after the query-key scores choose weights over positions, what role do the value vectors play?
With logits shape (16, 3), class-index targets shape (16,), and CrossEntropyLoss(reduction="none"), what shape is the unreduced loss?
Why does unreduced cross-entropy for logits (16, 3) and class-index targets (16,) return (16,) instead of (16, 3)?
For one row of 3 logits and one target class index, how many loss scalars does cross-entropy produce?
If each of 16 examples produces one loss scalar, what is the shape of the unreduced loss?
If shifting the input image right causes the convolutional feature map to shift right too, is that translation equivariance or translation invariance?
If a classifier gives the same class score whether the object is left or right in the image, is that closer to translation equivariance or translation invariance?
In one sentence, what is the difference between translation equivariance and translation invariance?
In attention, after the query-key scores become weights, what role do the value vectors play in producing the output?
In the formula output = attention_weights @ V, what exactly is being multiplied by the attention weights?
Does each row of V represent content for one token, or content for a pair of tokens?
For one query token, if its attention weights over three source tokens are [0.1, 0.7, 0.2], what kind of combination of the three value vectors forms its output?
If x and y are tensors with the same shape, what happens to the shape when you compute x + y?
If x has shape (4, 5), what shape does x * 3.0 have?
If x has shape (2, 3, 4), what shape does torch.relu(x) have?
What do elementwise operations do to each tensor entry, and why does that usually preserve shape?
If h has shape (4, 3) and bias b has shape (3,), what shape is h + b?
In h + b with h shape (4, 3) and b shape (3,), is b reused across the batch axis or across the feature axis?
If b = [b1, b2, b3], does each row of h get the same three bias values, or does each column get one repeated bias value down the batch?
In h + b where h is (4, 3) and b is (3,), which axis is b repeated across?
If b has one value per feature column, is it aligned with the feature axis or repeated across the feature axis?
`
      .trim()
      .split("\n")
      .map((question) => question.trim())
      .filter(Boolean),
  ),
);

let database: DatabaseSync | null = null;
let databaseInitialized = false;

function parseCsvRows(source: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];

    if (inQuotes) {
      if (character === '"' && source[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        inQuotes = false;
      } else {
        field += character;
      }

      continue;
    }

    if (character === '"') {
      inQuotes = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (character !== "\r") {
      field += character;
    }
  }

  if (field || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

function readLegacyCsvQuestions(): QuestionRow[] | null {
  if (!existsSync(LEGACY_QUESTIONS_FILE)) {
    return null;
  }

  const rows = parseCsvRows(readFileSync(LEGACY_QUESTIONS_FILE, "utf8"));
  const header = rows[0] ?? [];
  const questionIndex = header.indexOf("question");
  const reviewsIndex = header.indexOf("reviews");
  const nextDueIndex = header.indexOf("next_due");

  if (questionIndex === -1) {
    return null;
  }

  return rows
    .slice(1)
    .filter((row) => row[questionIndex]?.trim())
    .map((row) => ({
      question: row[questionIndex] ?? "",
      deck_id: DEFAULT_DECK.id,
      deck_name: DEFAULT_DECK.name,
      user_id: getCurrentUser().id,
      reviews: reviewsIndex === -1 ? "" : (row[reviewsIndex] ?? ""),
      next_due: Number(nextDueIndex === -1 ? 0 : row[nextDueIndex]),
      last_answer: "",
      last_answer_summary: "",
      reference_answer: "",
    }))
    .map((row) => ({
      ...row,
      next_due: Number.isFinite(row.next_due) ? row.next_due : 0,
    }));
}

function withWriteTransaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec("BEGIN IMMEDIATE");

  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Ignore rollback failures so the original error stays visible.
    }

    throw error;
  }
}

function insertSeedRows(db: DatabaseSync, rows: QuestionRow[]): void {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO questions (deck_id, question, question_slug, reviews, next_due)
    VALUES (?, ?, ?, ?, ?)
  `);

  withWriteTransaction(db, () => {
    for (const row of rows) {
      insert.run(
        row.deck_id || DEFAULT_DECK.id,
        row.question,
        questionSlug(row.question),
        row.reviews,
        Math.round(row.next_due),
      );
    }
  });
}

function ensureColumn(
  db: DatabaseSync,
  tableName: string,
  columnName: string,
  definition: string,
): void {
  const columns = db
    .prepare(`PRAGMA table_info(${tableName})`)
    .all() as Record<string, SQLOutputValue>[];
  const hasColumn = columns.some((column) => column.name === columnName);

  if (!hasColumn) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  }
}

function currentDeckId(): string {
  return DEFAULT_DECK.id;
}

function seedCurrentUserAndDeck(db: DatabaseSync): void {
  const now = Date.now();
  const user = getCurrentUser();

  db.prepare(
    `
    INSERT OR IGNORE INTO users (id, display_name, email, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `,
  ).run(user.id, user.displayName, user.email, now, now);

  db.prepare(
    `
    UPDATE users
    SET display_name = ?, email = ?, updated_at = ?
    WHERE id = ?
  `,
  ).run(user.displayName, user.email, now, user.id);

  db.prepare(
    `
    INSERT OR IGNORE INTO decks (id, user_id, name, slug, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
  ).run(DEFAULT_DECK.id, user.id, DEFAULT_DECK.name, DEFAULT_DECK.slug, now, now);

  db.prepare(
    `
    UPDATE decks
    SET user_id = ?, name = ?, slug = ?, updated_at = ?
    WHERE id = ?
  `,
  ).run(user.id, DEFAULT_DECK.name, DEFAULT_DECK.slug, now, DEFAULT_DECK.id);
}

function migrateExistingQuestionsToDefaultDeck(db: DatabaseSync): void {
  db.prepare(
    `
    UPDATE questions
    SET deck_id = ?, updated_at = ?
    WHERE deck_id IS NULL OR deck_id = ''
  `,
  ).run(DEFAULT_DECK.id, Date.now());

  db.prepare(
    `
    UPDATE question_attempts
    SET deck_id = ?
    WHERE deck_id IS NULL OR deck_id = ''
  `,
  ).run(DEFAULT_DECK.id);
}

function initializeDatabase(db: DatabaseSync): void {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      email TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch('subsec') * 1000),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch('subsec') * 1000)
    );

    CREATE TABLE IF NOT EXISTS decks (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      slug TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch('subsec') * 1000),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch('subsec') * 1000),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE UNIQUE INDEX IF NOT EXISTS decks_user_slug_idx
      ON decks (user_id, slug);

    CREATE TABLE IF NOT EXISTS questions (
      question TEXT PRIMARY KEY,
      question_slug TEXT NOT NULL,
      deck_id TEXT NOT NULL DEFAULT '${DEFAULT_DECK.id}',
      reviews TEXT NOT NULL DEFAULT '',
      next_due INTEGER NOT NULL DEFAULT 0,
      last_answer TEXT NOT NULL DEFAULT '',
      last_answer_summary TEXT NOT NULL DEFAULT '',
      reference_answer TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL DEFAULT (unixepoch('subsec') * 1000),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch('subsec') * 1000),
      FOREIGN KEY (deck_id) REFERENCES decks(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS questions_next_due_idx
      ON questions (next_due);

    CREATE TABLE IF NOT EXISTS question_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      deck_id TEXT NOT NULL DEFAULT '${DEFAULT_DECK.id}',
      question TEXT NOT NULL,
      raw_answer TEXT NOT NULL,
      answer_summary TEXT NOT NULL,
      score INTEGER NOT NULL,
      justification TEXT NOT NULL,
      submitted_at INTEGER NOT NULL,
      resolved_at INTEGER NOT NULL,
      FOREIGN KEY (deck_id) REFERENCES decks(id) ON DELETE CASCADE,
      FOREIGN KEY (question) REFERENCES questions(question) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS question_attempts_question_submitted_idx
      ON question_attempts (question, submitted_at DESC);
  `);
  seedCurrentUserAndDeck(db);
  ensureColumn(
    db,
    "questions",
    "deck_id",
    `TEXT NOT NULL DEFAULT '${DEFAULT_DECK.id}'`,
  );
  ensureColumn(db, "questions", "question_slug", "TEXT NOT NULL DEFAULT ''");
  const slugRows = db
    .prepare(
      `
      SELECT question
      FROM questions
      WHERE question_slug = ''
    `,
    )
    .all() as Array<{ question?: SQLOutputValue }>;
  const updateQuestionSlug = db.prepare(`
    UPDATE questions
    SET question_slug = ?
    WHERE question = ?
  `);

  withWriteTransaction(db, () => {
    for (const row of slugRows) {
      const question = String(row.question ?? "");

      updateQuestionSlug.run(questionSlug(question), question);
    }
  });
  ensureColumn(db, "questions", "last_answer", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(
    db,
    "questions",
    "last_answer_summary",
    "TEXT NOT NULL DEFAULT ''",
  );
  ensureColumn(db, "questions", "reference_answer", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(
    db,
    "question_attempts",
    "deck_id",
    `TEXT NOT NULL DEFAULT '${DEFAULT_DECK.id}'`,
  );
  migrateExistingQuestionsToDefaultDeck(db);
  db.exec(`
    CREATE INDEX IF NOT EXISTS questions_deck_next_due_idx
      ON questions (deck_id, next_due);

    CREATE UNIQUE INDEX IF NOT EXISTS questions_question_slug_idx
      ON questions (question_slug);

    CREATE INDEX IF NOT EXISTS question_attempts_deck_question_submitted_idx
      ON question_attempts (deck_id, question, submitted_at DESC);
  `);

  const countRow = db
    .prepare(
      `
      SELECT COUNT(*) AS count
      FROM questions
      WHERE deck_id = ?
    `,
    )
    .get(currentDeckId()) as { count?: SQLOutputValue } | undefined;
  const questionCount = Number(countRow?.count ?? 0);

  if (questionCount > 0) {
    return;
  }

  insertSeedRows(
    db,
    readLegacyCsvQuestions() ??
      BOOTSTRAP_QUESTIONS.map((question) => ({
        question,
        deck_id: DEFAULT_DECK.id,
        deck_name: DEFAULT_DECK.name,
        user_id: getCurrentUser().id,
        reviews: "",
        next_due: 0,
        last_answer: "",
        last_answer_summary: "",
        reference_answer: "",
      })),
  );
}

function getDatabase(): DatabaseSync {
  mkdirSync(DATA_DIR, { recursive: true });

  if (!database) {
    database = new DatabaseSync(QUESTIONS_DB_FILE);
  }

  if (!databaseInitialized) {
    initializeDatabase(database);
    databaseInitialized = true;
  }

  return database;
}

function normalizeRow(row: Record<string, SQLOutputValue>): QuestionRow {
  return {
    deck_id: String(row.deck_id ?? DEFAULT_DECK.id),
    deck_name: String(row.deck_name ?? DEFAULT_DECK.name),
    user_id: String(row.user_id ?? getCurrentUser().id),
    question: String(row.question ?? ""),
    reviews: String(row.reviews ?? ""),
    next_due: Number(row.next_due ?? 0),
    last_answer: String(row.last_answer ?? ""),
    last_answer_summary: String(row.last_answer_summary ?? ""),
    reference_answer: String(row.reference_answer ?? ""),
  };
}

function normalizeAttemptRow(row: Record<string, SQLOutputValue>): QuestionAttempt {
  return {
    id: Number(row.id ?? 0),
    deckId: String(row.deck_id ?? DEFAULT_DECK.id),
    question: String(row.question ?? ""),
    rawAnswer: String(row.raw_answer ?? ""),
    answerSummary: String(row.answer_summary ?? ""),
    score: Number(row.score ?? 0),
    justification: String(row.justification ?? ""),
    submittedAt: Number(row.submitted_at ?? 0),
    resolvedAt: Number(row.resolved_at ?? 0),
  };
}

export async function ensureQuestionsDatabase(): Promise<void> {
  getDatabase();
}

export async function readQuestions(): Promise<QuestionRow[]> {
  const db = getDatabase();
  return db
    .prepare(
      `
      SELECT
        q.deck_id,
        d.name AS deck_name,
        d.user_id,
        q.question,
        q.reviews,
        q.next_due,
        q.last_answer,
        q.last_answer_summary,
        q.reference_answer
      FROM questions q
      JOIN decks d ON d.id = q.deck_id
      WHERE q.deck_id = ? AND d.user_id = ?
      ORDER BY q.rowid ASC
    `,
    )
    .all(currentDeckId(), getCurrentUser().id)
    .map(normalizeRow);
}

export async function getDueQuestions(now = Date.now()): Promise<DueQuestion[]> {
  const db = getDatabase();

  return db
    .prepare(
      `
      SELECT
        q.deck_id,
        d.name AS deck_name,
        d.user_id,
        q.question,
        q.reviews,
        q.next_due,
        q.last_answer,
        q.last_answer_summary,
        q.reference_answer
      FROM questions q
      JOIN decks d ON d.id = q.deck_id
      WHERE q.deck_id = ? AND d.user_id = ? AND q.next_due <= ?
      ORDER BY q.next_due ASC
    `,
    )
    .all(currentDeckId(), getCurrentUser().id, Math.round(now))
    .map(normalizeRow)
    .map((row) => ({
      deckId: row.deck_id,
      deckName: row.deck_name,
      question: row.question,
      reviews: row.reviews,
      nextDue: row.next_due,
      lastAnswer: row.last_answer || null,
      lastAnswerSummary: row.last_answer_summary || null,
      referenceAnswer: row.reference_answer || null,
    }))
    .filter((row) => Number.isFinite(row.nextDue) && row.nextDue <= now)
    .sort((a, b) => a.nextDue - b.nextDue);
}

export async function getAllQueuedQuestions(): Promise<DueQuestion[]> {
  const db = getDatabase();

  return db
    .prepare(
      `
      SELECT
        q.deck_id,
        d.name AS deck_name,
        d.user_id,
        q.question,
        q.reviews,
        q.next_due,
        q.last_answer,
        q.last_answer_summary,
        q.reference_answer
      FROM questions q
      JOIN decks d ON d.id = q.deck_id
      WHERE q.deck_id = ? AND d.user_id = ?
      ORDER BY q.next_due ASC
    `,
    )
    .all(currentDeckId(), getCurrentUser().id)
    .map(normalizeRow)
    .map((row) => ({
      deckId: row.deck_id,
      deckName: row.deck_name,
      question: row.question,
      reviews: row.reviews,
      nextDue: row.next_due,
      lastAnswer: row.last_answer || null,
      lastAnswerSummary: row.last_answer_summary || null,
      referenceAnswer: row.reference_answer || null,
    }))
    .filter((row) => Number.isFinite(row.nextDue))
    .sort((a, b) => a.nextDue - b.nextDue);
}

export async function getQuestionSnapshot(
  question: string,
): Promise<DueQuestion | null> {
  const db = getDatabase();
  const row = db
    .prepare(
      `
      SELECT
        q.deck_id,
        d.name AS deck_name,
        d.user_id,
        q.question,
        q.reviews,
        q.next_due,
        q.last_answer,
        q.last_answer_summary,
        q.reference_answer
      FROM questions q
      JOIN decks d ON d.id = q.deck_id
      WHERE q.deck_id = ? AND d.user_id = ? AND q.question = ?
    `,
    )
    .get(currentDeckId(), getCurrentUser().id, question);

  if (!row) {
    return null;
  }

  const normalized = normalizeRow(row);

  return {
    deckId: normalized.deck_id,
    deckName: normalized.deck_name,
    question: normalized.question,
    reviews: normalized.reviews,
    nextDue: normalized.next_due,
    lastAnswer: normalized.last_answer || null,
    lastAnswerSummary: normalized.last_answer_summary || null,
    referenceAnswer: normalized.reference_answer || null,
  };
}

export async function getQuestionAttempts(
  question: string,
): Promise<QuestionAttempt[]> {
  const db = getDatabase();

  return db
    .prepare(
      `
      SELECT id, deck_id, question, raw_answer, answer_summary, score, justification, submitted_at, resolved_at
      FROM question_attempts
      WHERE deck_id = ? AND question = ?
      ORDER BY submitted_at ASC, id ASC
    `,
    )
    .all(currentDeckId(), question)
    .map(normalizeAttemptRow)
    .filter(
      (attempt) =>
        Number.isFinite(attempt.id) &&
        Number.isFinite(attempt.score) &&
        Number.isFinite(attempt.submittedAt) &&
        Number.isFinite(attempt.resolvedAt),
    );
}

export async function getStoredReferenceAnswer(
  question: string,
): Promise<string | null> {
  const db = getDatabase();
  const row = db
    .prepare(
      `
      SELECT reference_answer
      FROM questions q
      JOIN decks d ON d.id = q.deck_id
      WHERE q.deck_id = ? AND d.user_id = ? AND q.question = ?
    `,
    )
    .get(currentDeckId(), getCurrentUser().id, question) as
    | { reference_answer?: SQLOutputValue }
    | undefined;
  const answer = String(row?.reference_answer ?? "").trim();

  return answer || null;
}

export async function saveReferenceAnswer(input: {
  question: string;
  answer: string;
  now: number;
}): Promise<void> {
  const db = getDatabase();

  db.prepare(
    `
    UPDATE questions
    SET reference_answer = ?, updated_at = ?
    WHERE deck_id = ? AND question = ?
  `,
  ).run(input.answer, Math.round(input.now), currentDeckId(), input.question);
}

export async function applyEvaluationToSqlite(input: {
  question: string;
  answer: string;
  answerSummary: string;
  justification: string;
  score: number;
  submittedAt: number;
  now: number;
}): Promise<PersistedEvaluation> {
  const db = getDatabase();

  return withWriteTransaction(db, () => {
    const rawRow = db
      .prepare(
        `
        SELECT
          q.deck_id,
          d.name AS deck_name,
          d.user_id,
          q.question,
          q.reviews,
          q.next_due,
          q.last_answer,
          q.last_answer_summary,
          q.reference_answer
        FROM questions q
        JOIN decks d ON d.id = q.deck_id
        WHERE q.deck_id = ? AND d.user_id = ? AND q.question = ?
      `,
      )
      .get(currentDeckId(), getCurrentUser().id, input.question);

    if (!rawRow) {
      return null;
    }

    const row = normalizeRow(rawRow);
    const previousReviews = parseReviews(row.reviews);
    const reviews = appendReview(row.reviews, {
      ts: input.now,
      score: input.score,
    });
    const nextDue = scheduleNextReview({
      previousReviews,
      newScore: input.score,
      now: input.now,
    });
    const roundedNextDue = Math.round(nextDue);

    db.prepare(
      `
      UPDATE questions
      SET reviews = ?, next_due = ?, last_answer = ?, last_answer_summary = ?, updated_at = ?
      WHERE deck_id = ? AND question = ?
    `,
    ).run(
      reviews,
      roundedNextDue,
      input.answer,
      input.answerSummary,
      Math.round(input.now),
      currentDeckId(),
      input.question,
    );

    db.prepare(
      `
      INSERT INTO question_attempts (
        deck_id,
        question,
        raw_answer,
        answer_summary,
        score,
        justification,
        submitted_at,
        resolved_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      currentDeckId(),
      input.question,
      input.answer,
      input.answerSummary,
      input.score,
      input.justification,
      Math.round(input.submittedAt),
      Math.round(input.now),
    );

    return {
      deckId: row.deck_id,
      deckName: row.deck_name,
      question: row.question,
      reviews,
      nextDue: roundedNextDue,
      lastAnswer: input.answer || null,
      lastAnswerSummary: input.answerSummary || null,
      referenceAnswer: row.reference_answer || null,
    };
  });
}
