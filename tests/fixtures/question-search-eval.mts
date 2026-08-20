export type QuestionSearchEvalLabel =
  | "same_target"
  | "related_distinct"
  | "unrelated";

export type QuestionSearchEvalCase = {
  id: string;
  storedPrompt: string;
  storedAnswer: string;
  candidatePrompt: string;
  label: QuestionSearchEvalLabel;
  stratum: string;
  critical: boolean;
};

type Seed = {
  id: string;
  prompt: string;
  answer: string;
  paraphrase: string;
  typo: string;
  related: [string, string, string, string];
};

const seeds: Seed[] = [
  {
    id: "attention-scale",
    prompt: "Why are attention logits divided by $\\sqrt{d_k}$?",
    answer: "To keep their variance controlled and prevent softmax saturation.",
    paraphrase: "What is the purpose of scaling dot-product attention by the square root of the key dimension?",
    typo: "Why are attention logits divided by $\\sqrt{d_k}$",
    related: [
      "What tensor shapes participate in scaled dot-product attention?",
      "Why does softmax saturation weaken gradients?",
      "Why are attention values multiplied by attention weights?",
      "What happens if attention logits are divided by $d_k$ instead of $\\sqrt{d_k}$?",
    ],
  },
  {
    id: "http-idempotency",
    prompt: "What property makes an HTTP operation idempotent?",
    answer: "Repeating the same operation has the same intended effect as doing it once.",
    paraphrase: "When is an HTTP request considered idempotent?",
    typo: "What property makes a HTTP operation idempotent?",
    related: [
      "Which standard HTTP methods are idempotent?",
      "What is the difference between a safe and an idempotent HTTP method?",
      "How does an idempotency key prevent duplicate payment creation?",
      "Is `POST` inherently idempotent?",
    ],
  },
  {
    id: "france-capital",
    prompt: "What is the capital of France?",
    answer: "Paris.",
    paraphrase: "Which city is France's capital?",
    typo: "What is the capitol of France?",
    related: [
      "What is the capital of Germany?",
      "Which river runs through Paris?",
      "What country has Paris as its capital?",
      "Was Paris the capital of France in 1940?",
    ],
  },
  {
    id: "derivative-square",
    prompt: "What is $\\frac{d}{dx}x^2$?",
    answer: "$2x$.",
    paraphrase: "Differentiate $x^2$ with respect to $x$.",
    typo: "What is $d/dx x^2$?",
    related: [
      "What is $\\frac{d}{dx}x^3$?",
      "What is $\\int x^2\\,dx$?",
      "At what value of $x$ is the derivative of $x^2$ equal to 4?",
      "What is the second derivative of $x^2$?",
    ],
  },
  {
    id: "sql-left-join",
    prompt: "What rows does a SQL `LEFT JOIN` preserve?",
    answer: "Every row from the left table, with nulls for unmatched right columns.",
    paraphrase: "Which side's unmatched rows remain in the result of a `LEFT JOIN`?",
    typo: "What rows does a SQL LEFT JOIN perserve?",
    related: [
      "What rows does a SQL `RIGHT JOIN` preserve?",
      "How does an `INNER JOIN` treat unmatched rows?",
      "When can a `LEFT JOIN` increase the number of left-table rows?",
      "Where must a right-table filter go to preserve unmatched left rows?",
    ],
  },
  {
    id: "portuguese-water",
    prompt: "Qual é a fórmula química da água?",
    answer: "$H_2O$.",
    paraphrase: "What chemical formula represents water?",
    typo: "Qual e a formula quimica da água?",
    related: [
      "Qual é a fórmula química do peróxido de hidrogénio?",
      "Quantos átomos de hidrogénio existem numa molécula de água?",
      "Como se chama a ligação entre moléculas de água?",
      "A água pesada tem a fórmula $H_2O$?",
    ],
  },
  {
    id: "git-rebase",
    prompt: "What does `git rebase main` do to the current branch?",
    answer: "It replays the current branch's commits on top of `main`.",
    paraphrase: "How does rebasing the current branch onto `main` rewrite its history?",
    typo: "What does `git rebase mian` do to the current branch?",
    related: [
      "What does `git merge main` do to the current branch?",
      "What does `git rebase --onto` change?",
      "Why can rebasing published commits disrupt collaborators?",
      "What does `git rebase main` do to the `main` branch itself?",
    ],
  },
  {
    id: "dna-role",
    prompt: "What is DNA's primary biological role?",
    answer: "It stores and transmits hereditary genetic information.",
    paraphrase: "What information-bearing function does DNA serve in living organisms?",
    typo: "What is DNAs primary biological role?",
    related: [
      "What is RNA's role in translation?",
      "Which bonds hold complementary DNA strands together?",
      "How is DNA replicated semiconservatively?",
      "Does DNA directly catalyze every cellular reaction?",
    ],
  },
  {
    id: "moon-landing-date",
    prompt: "On what date did Apollo 11 land on the Moon?",
    answer: "July 20, 1969.",
    paraphrase: "When did the Apollo 11 lunar module touch down?",
    typo: "On what date did Appolo 11 land on the Moon?",
    related: [
      "On what date did Apollo 11 launch?",
      "Who first stepped onto the Moon during Apollo 11?",
      "On what date did Apollo 12 land on the Moon?",
      "Did Apollo 11 land on July 21, 1969 in UTC?",
    ],
  },
  {
    id: "python-identity",
    prompt: "How does Python's `is` differ from `==`?",
    answer: "`is` tests object identity; `==` tests value equality.",
    paraphrase: "What distinct comparisons are performed by Python `is` and `==`?",
    typo: "How does Pythons `is` differ from `==`?",
    related: [
      "When should Python code use `is None`?",
      "How can a class customize the behavior of `==`?",
      "What does Python's `in` operator test?",
      "Does `is` compare two objects' values?",
    ],
  },
  {
    id: "rrf-definition",
    prompt: "How does reciprocal rank fusion (RRF) combine ranked lists?",
    answer: "It sums reciprocal rank contributions such as $1/(k+r)$ across lists.",
    paraphrase: "What score does RRF use to merge results from multiple retrievers?",
    typo: "How does reciprical rank fusion (RRF) combine ranked lists?",
    related: [
      "Why does RRF not require calibrated retriever scores?",
      "What does the constant $k$ control in RRF?",
      "How does CombSUM fuse ranked results?",
      "Does RRF multiply raw similarity scores across retrievers?",
    ],
  },
  {
    id: "water-freezing",
    prompt: "At standard atmospheric pressure, at what Celsius temperature does pure water freeze?",
    answer: "$0\\,^{\\circ}\\mathrm{C}$.",
    paraphrase: "What is pure water's freezing point in degrees Celsius at 1 atmosphere?",
    typo: "At standard pressure, at what Celcius temperature does pure water freeze?",
    related: [
      "At standard pressure, at what Celsius temperature does pure water boil?",
      "What is water's freezing point in degrees Fahrenheit?",
      "How does dissolved salt affect water's freezing point?",
      "Does pure water freeze at $1\\,^{\\circ}\\mathrm{C}$ at 1 atmosphere?",
    ],
  },
];

export const QUESTION_SEARCH_EVAL_CASES: QuestionSearchEvalCase[] = seeds.flatMap(
  (seed, index) => {
    const unrelatedOne = seeds[(index + 4) % seeds.length] as Seed;
    const unrelatedTwo = seeds[(index + 7) % seeds.length] as Seed;
    const cases: Array<Omit<QuestionSearchEvalCase, "id">> = [
      {
        storedPrompt: seed.prompt,
        storedAnswer: seed.answer,
        candidatePrompt: `  ${seed.prompt.toLocaleUpperCase("und")}  `,
        label: "same_target",
        stratum: "exact_normalization",
        critical: true,
      },
      {
        storedPrompt: seed.prompt,
        storedAnswer: seed.answer,
        candidatePrompt: seed.prompt.replace(/ /gu, "  "),
        label: "same_target",
        stratum: "whitespace_punctuation",
        critical: false,
      },
      {
        storedPrompt: seed.prompt,
        storedAnswer: seed.answer,
        candidatePrompt: seed.paraphrase,
        label: "same_target",
        stratum: seed.id === "portuguese-water" ? "cross_language" : "paraphrase",
        critical: true,
      },
      {
        storedPrompt: seed.prompt,
        storedAnswer: seed.answer,
        candidatePrompt: seed.typo,
        label: "same_target",
        stratum: "typo_notation",
        critical: true,
      },
      ...seed.related.map((candidatePrompt, relatedIndex) => ({
        storedPrompt: seed.prompt,
        storedAnswer: seed.answer,
        candidatePrompt,
        label: "related_distinct" as const,
        stratum: [
          "same_topic_different_fact",
          "direction_or_relation",
          "entity_number_or_date",
          "negation_or_condition",
        ][relatedIndex] as string,
        critical: true,
      })),
      {
        storedPrompt: seed.prompt,
        storedAnswer: seed.answer,
        candidatePrompt: unrelatedOne.prompt,
        label: "unrelated",
        stratum: "unrelated",
        critical: false,
      },
      {
        storedPrompt: seed.prompt,
        storedAnswer: seed.answer,
        candidatePrompt: unrelatedTwo.prompt,
        label: "unrelated",
        stratum: "unrelated",
        critical: false,
      },
    ];
    return cases.map((item, caseIndex) => ({
      id: `${seed.id}-${caseIndex + 1}`,
      ...item,
    }));
  },
);
