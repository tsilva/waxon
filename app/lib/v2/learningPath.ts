export type SequenceTarget = {
  key: string;
  statement: string;
  sourcePosition: number;
};

export type SequenceDraft = {
  modules: Array<{ key: string; title: string }>;
  nodes: Array<{
    targetKey: string;
    moduleKey: string;
    prerequisiteTargetKeys: string[];
    externalPrerequisiteKeys: string[];
  }>;
  externalPrerequisites: Array<{
    key: string;
    statement: string;
    reason: string;
    blocksTargetKeys: string[];
  }>;
};

export type NormalizedSequenceNode = {
  key: string;
  kind: "target" | "external_prerequisite";
  targetKey: string | null;
  moduleTitle: string;
  modulePosition: number;
  statement: string;
  reason: string | null;
  sourcePosition: number;
  pedagogicalPosition: number;
};

export type NormalizedSequence = {
  status: "ready" | "fallback_ready";
  nodes: NormalizedSequenceNode[];
  edges: Array<{ prerequisiteKey: string; dependentKey: string }>;
  diagnostics: string[];
};

export function removeSharedQuestionEdges(
  edges: NormalizedSequence["edges"],
  questionByTarget: ReadonlyMap<string, string>,
): NormalizedSequence["edges"] {
  return edges.filter((edge) => {
    const prerequisiteQuestion = questionByTarget.get(edge.prerequisiteKey);
    return !prerequisiteQuestion ||
      prerequisiteQuestion !== questionByTarget.get(edge.dependentKey);
  });
}

const MAX_MODULES = 16;
const MAX_EXTERNAL_PREREQUISITES = 24;
const MAX_PREREQUISITES_PER_NODE = 6;

function fallbackSequence(
  targets: SequenceTarget[],
  diagnostics: string[],
): NormalizedSequence {
  const ordered = [...targets].sort(
    (left, right) =>
      left.sourcePosition - right.sourcePosition || left.key.localeCompare(right.key),
  );
  return {
    status: "fallback_ready",
    diagnostics: [...new Set(diagnostics)].slice(0, 40),
    nodes: ordered.map((target, index) => ({
      key: target.key,
      kind: "target" as const,
      targetKey: target.key,
      moduleTitle: "Source order",
      modulePosition: 0,
      statement: target.statement,
      reason: null,
      sourcePosition: target.sourcePosition,
      pedagogicalPosition: index,
    })),
    edges: ordered.slice(1).map((target, index) => ({
      prerequisiteKey: ordered[index].key,
      dependentKey: target.key,
    })),
  };
}

function transitiveReduction(
  keys: string[],
  edges: Array<{ prerequisiteKey: string; dependentKey: string }>,
) {
  const adjacency = new Map(keys.map((key) => [key, new Set<string>()]));
  for (const edge of edges) {
    adjacency.get(edge.prerequisiteKey)?.add(edge.dependentKey);
  }
  function reachable(from: string, to: string, skipped: string): boolean {
    const seen = new Set<string>();
    const stack = [...(adjacency.get(from) ?? [])].filter((key) => key !== skipped);
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (current === to) return true;
      if (seen.has(current)) continue;
      seen.add(current);
      stack.push(...(adjacency.get(current) ?? []));
    }
    return false;
  }
  return edges.filter(
    (edge) =>
      !reachable(edge.prerequisiteKey, edge.dependentKey, edge.dependentKey),
  );
}

export function normalizeLearningPath(input: {
  targets: SequenceTarget[];
  draft: SequenceDraft | null;
  diagnostics?: string[];
}): NormalizedSequence {
  const diagnostics = [...(input.diagnostics ?? [])];
  const targetByKey = new Map(input.targets.map((target) => [target.key, target]));
  const draft = input.draft;
  if (!draft) {
    return fallbackSequence(input.targets, [
      ...diagnostics,
      "The sequencing agent did not return a usable path.",
    ]);
  }
  if (draft.modules.length === 0 || draft.modules.length > MAX_MODULES) {
    return fallbackSequence(input.targets, [
      ...diagnostics,
      "The learning-path module count was invalid.",
    ]);
  }
  const moduleByKey = new Map(
    draft.modules.map((module, index) => [
      module.key,
      { ...module, position: index },
    ]),
  );
  if (moduleByKey.size !== draft.modules.length) {
    return fallbackSequence(input.targets, [
      ...diagnostics,
      "The sequencing agent returned duplicate module keys.",
    ]);
  }
  const placementByTarget = new Map<string, SequenceDraft["nodes"][number]>();
  for (const node of draft.nodes) {
    if (
      !targetByKey.has(node.targetKey) ||
      !moduleByKey.has(node.moduleKey) ||
      placementByTarget.has(node.targetKey) ||
      node.prerequisiteTargetKeys.length > MAX_PREREQUISITES_PER_NODE ||
      node.externalPrerequisiteKeys.length > MAX_PREREQUISITES_PER_NODE
    ) {
      return fallbackSequence(input.targets, [
        ...diagnostics,
        "The sequencing agent returned an invalid or duplicate target placement.",
      ]);
    }
    placementByTarget.set(node.targetKey, node);
  }
  if (
    placementByTarget.size !== targetByKey.size ||
    [...targetByKey.keys()].some((key) => !placementByTarget.has(key))
  ) {
    return fallbackSequence(input.targets, [
      ...diagnostics,
      "The learning path did not place every required target exactly once.",
    ]);
  }
  if (draft.externalPrerequisites.length > MAX_EXTERNAL_PREREQUISITES) {
    return fallbackSequence(input.targets, [
      ...diagnostics,
      "The learning path proposed too many external prerequisites.",
    ]);
  }
  const externalByKey = new Map(
    draft.externalPrerequisites.map((gap) => [gap.key, gap]),
  );
  if (externalByKey.size !== draft.externalPrerequisites.length) {
    return fallbackSequence(input.targets, [
      ...diagnostics,
      "The sequencing agent returned duplicate prerequisite keys.",
    ]);
  }
  const allKeys = [...targetByKey.keys(), ...externalByKey.keys()];
  const knownKeys = new Set(allKeys);
  const edges: Array<{ prerequisiteKey: string; dependentKey: string }> = [];
  for (const node of draft.nodes) {
    for (const prerequisiteKey of node.prerequisiteTargetKeys) {
      if (!targetByKey.has(prerequisiteKey) || prerequisiteKey === node.targetKey) {
        return fallbackSequence(input.targets, [
          ...diagnostics,
          "The learning path referenced an invalid target prerequisite.",
        ]);
      }
      edges.push({ prerequisiteKey, dependentKey: node.targetKey });
    }
    for (const prerequisiteKey of node.externalPrerequisiteKeys) {
      if (!externalByKey.has(prerequisiteKey)) {
        return fallbackSequence(input.targets, [
          ...diagnostics,
          "The learning path referenced an unknown external prerequisite.",
        ]);
      }
      edges.push({ prerequisiteKey, dependentKey: node.targetKey });
    }
  }
  for (const gap of externalByKey.values()) {
    if (!gap.statement.trim() || gap.blocksTargetKeys.length === 0) {
      return fallbackSequence(input.targets, [
        ...diagnostics,
        "An external prerequisite lacked a statement or blocked target.",
      ]);
    }
    for (const targetKey of gap.blocksTargetKeys) {
      if (!targetByKey.has(targetKey)) {
        return fallbackSequence(input.targets, [
          ...diagnostics,
          "An external prerequisite referenced an unknown target.",
        ]);
      }
      edges.push({ prerequisiteKey: gap.key, dependentKey: targetKey });
    }
  }
  const uniqueEdges = [
    ...new Map(
      edges.map((edge) => [
        `${edge.prerequisiteKey}:${edge.dependentKey}`,
        edge,
      ]),
    ).values(),
  ];
  if (
    uniqueEdges.some(
      (edge) =>
        !knownKeys.has(edge.prerequisiteKey) ||
        !knownKeys.has(edge.dependentKey) ||
        edge.prerequisiteKey === edge.dependentKey,
    )
  ) {
    return fallbackSequence(input.targets, [
      ...diagnostics,
      "The learning path contained an invalid edge.",
    ]);
  }
  const incoming = new Map(allKeys.map((key) => [key, 0]));
  const outgoing = new Map(allKeys.map((key) => [key, new Set<string>()]));
  for (const edge of uniqueEdges) {
    if (!outgoing.get(edge.prerequisiteKey)!.has(edge.dependentKey)) {
      outgoing.get(edge.prerequisiteKey)!.add(edge.dependentKey);
      incoming.set(edge.dependentKey, (incoming.get(edge.dependentKey) ?? 0) + 1);
    }
  }
  const sourcePosition = (key: string) => {
    const target = targetByKey.get(key);
    if (target) return target.sourcePosition;
    const blocked = externalByKey.get(key)?.blocksTargetKeys ?? [];
    return Math.min(...blocked.map((item) => targetByKey.get(item)?.sourcePosition ?? 0));
  };
  const ready = allKeys
    .filter((key) => incoming.get(key) === 0)
    .sort((left, right) => sourcePosition(left) - sourcePosition(right) || left.localeCompare(right));
  const ordered: string[] = [];
  while (ready.length > 0) {
    const key = ready.shift()!;
    ordered.push(key);
    for (const dependent of outgoing.get(key) ?? []) {
      const count = (incoming.get(dependent) ?? 0) - 1;
      incoming.set(dependent, count);
      if (count === 0) {
        ready.push(dependent);
        ready.sort(
          (left, right) =>
            sourcePosition(left) - sourcePosition(right) || left.localeCompare(right),
        );
      }
    }
  }
  if (ordered.length !== allKeys.length) {
    return fallbackSequence(input.targets, [
      ...diagnostics,
      "The learning path contained a prerequisite cycle.",
    ]);
  }
  const nodes = ordered.map((key, pedagogicalPosition) => {
    const target = targetByKey.get(key);
    if (target) {
      const placement = placementByTarget.get(key)!;
      const pathModule = moduleByKey.get(placement.moduleKey)!;
      return {
        key,
        kind: "target" as const,
        targetKey: key,
        moduleTitle: pathModule.title,
        modulePosition: pathModule.position,
        statement: target.statement,
        reason: null,
        sourcePosition: target.sourcePosition,
        pedagogicalPosition,
      };
    }
    const gap = externalByKey.get(key)!;
    const firstBlocked = gap.blocksTargetKeys
      .map((targetKey) => placementByTarget.get(targetKey))
      .find(Boolean);
    const pathModule = firstBlocked
      ? moduleByKey.get(firstBlocked.moduleKey)
      : draft.modules[0]
        ? { ...draft.modules[0], position: 0 }
        : { title: "Prerequisites", position: 0 };
    return {
      key,
      kind: "external_prerequisite" as const,
      targetKey: null,
      moduleTitle: pathModule?.title ?? "Prerequisites",
      modulePosition: pathModule?.position ?? 0,
      statement: gap.statement,
      reason: gap.reason,
      sourcePosition: sourcePosition(key),
      pedagogicalPosition,
    };
  });
  return {
    status: "ready",
    nodes,
    edges: transitiveReduction(allKeys, uniqueEdges),
    diagnostics: [...new Set(diagnostics)].slice(0, 40),
  };
}
