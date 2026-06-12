import assert from "node:assert/strict";
import test from "node:test";
import {
  isUsefulConceptSlug,
  normalizeConceptSlug,
  normalizeConceptSlugList,
} from "../app/lib/conceptSlug.ts";

test("normalizeConceptSlug produces lowercase kebab-case phrases", () => {
  assert.equal(
    normalizeConceptSlug("Proximal Policy Optimization"),
    "proximal-policy-optimization",
  );
  assert.equal(normalizeConceptSlug("  KL Divergence  "), "kl-divergence");
});

test("isUsefulConceptSlug rejects acronym-only tags", () => {
  assert.equal(isUsefulConceptSlug("ppo"), false);
  assert.equal(isUsefulConceptSlug("rl"), false);
  assert.equal(isUsefulConceptSlug("proximal-policy-optimization"), true);
});

test("normalizeConceptSlugList deduplicates and limits slugs", () => {
  assert.deepEqual(
    normalizeConceptSlugList([
      "PPO",
      "Policy Entropy",
      "policy-entropy",
      "Entropy Bonus",
      "Clipped Surrogate Objective",
      "Advantage Estimation",
    ]),
    [
      "policy-entropy",
      "entropy-bonus",
      "clipped-surrogate-objective",
    ],
  );
});
