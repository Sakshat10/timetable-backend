// ---------------------------------------------------------------------------
// Tiny, deterministic max-flow helper for the pooled teacher-capacity check.
//
// IMPORTANT (what this does and does NOT prove):
// This is a max-flow RELAXATION. It treats each subject group's unassigned demand as divisible
// across its eligible teachers. A positive result (flow < demand) PROVES the configuration cannot
// be satisfied, because the relaxation only gets easier than the real problem. It cannot prove the
// opposite: the real problem needs whole per-section blocks to be given to a single teacher
// (one teacher per section + subject), and exact timetable placement, which are solver-level
// concerns. So passing this check never means "a timetable exists".
//
// No third-party dependency. Edmonds-Karp (BFS augmenting paths) on a source -> groups -> teachers ->
// sink network. Node and edge order is fixed by the input order, so the result is deterministic.
// ---------------------------------------------------------------------------

export interface BipartiteFlowInput {
  /** Unassigned demand (periods) of each group. */
  demands: number[];
  /** Remaining capacity (periods) of each teacher. */
  capacities: number[];
  /** [groupIndex, teacherIndex] pairs: the teacher is eligible for the group. */
  edges: Array<[number, number]>;
}

export interface BipartiteFlowResult {
  maxFlow: number;
  totalDemand: number;
  /**
   * When maxFlow < totalDemand: the groups reachable from the source in the residual graph and the
   * teachers adjacent to them. This is a Hall violator: the reachable groups need more periods than
   * their eligible teachers have left. Empty when all demand can be routed.
   */
  bottleneckGroups: number[];
  bottleneckTeachers: number[];
}

export function maxFlowBipartite(input: BipartiteFlowInput): BipartiteFlowResult {
  const groupCount = input.demands.length;
  const teacherCount = input.capacities.length;
  const source = 0;
  const groupNode = (g: number) => 1 + g;
  const teacherNode = (t: number) => 1 + groupCount + t;
  const sink = 1 + groupCount + teacherCount;
  const nodeCount = sink + 1;

  const totalDemand = input.demands.reduce((sum, d) => sum + d, 0);
  const infinity = totalDemand + 1;

  // Edge i and i ^ 1 are a forward edge and its residual twin.
  const edgeTo: number[] = [];
  const edgeCap: number[] = [];
  const adjacency: number[][] = Array.from({ length: nodeCount }, () => []);

  const addEdge = (from: number, to: number, capacity: number): void => {
    adjacency[from]!.push(edgeTo.length);
    edgeTo.push(to);
    edgeCap.push(capacity);
    adjacency[to]!.push(edgeTo.length);
    edgeTo.push(from);
    edgeCap.push(0);
  };

  for (let g = 0; g < groupCount; g++) addEdge(source, groupNode(g), input.demands[g]!);
  for (const [g, t] of input.edges) addEdge(groupNode(g), teacherNode(t), infinity);
  for (let t = 0; t < teacherCount; t++) addEdge(teacherNode(t), sink, input.capacities[t]!);

  let maxFlow = 0;
  for (;;) {
    // BFS for the shortest augmenting path.
    const viaEdge: number[] = new Array(nodeCount).fill(-1);
    const seen: boolean[] = new Array(nodeCount).fill(false);
    seen[source] = true;
    const queue: number[] = [source];
    for (let head = 0; head < queue.length && !seen[sink]; head++) {
      const node = queue[head]!;
      for (const edge of adjacency[node]!) {
        const next = edgeTo[edge]!;
        if (!seen[next] && edgeCap[edge]! > 0) {
          seen[next] = true;
          viaEdge[next] = edge;
          queue.push(next);
        }
      }
    }
    if (!seen[sink]) break;

    let bottleneck = Number.MAX_SAFE_INTEGER;
    for (let node = sink; node !== source; node = edgeTo[viaEdge[node]! ^ 1]!) {
      bottleneck = Math.min(bottleneck, edgeCap[viaEdge[node]!]!);
    }
    for (let node = sink; node !== source; node = edgeTo[viaEdge[node]! ^ 1]!) {
      edgeCap[viaEdge[node]!]! -= bottleneck;
      edgeCap[viaEdge[node]! ^ 1]! += bottleneck;
    }
    maxFlow += bottleneck;
  }

  if (maxFlow >= totalDemand) {
    return { maxFlow, totalDemand, bottleneckGroups: [], bottleneckTeachers: [] };
  }

  // Residual reachability from the source gives the minimum cut / Hall violator.
  const reachable: boolean[] = new Array(nodeCount).fill(false);
  reachable[source] = true;
  const queue: number[] = [source];
  for (let head = 0; head < queue.length; head++) {
    const node = queue[head]!;
    for (const edge of adjacency[node]!) {
      const next = edgeTo[edge]!;
      if (!reachable[next] && edgeCap[edge]! > 0) {
        reachable[next] = true;
        queue.push(next);
      }
    }
  }

  const bottleneckGroups: number[] = [];
  for (let g = 0; g < groupCount; g++) if (reachable[groupNode(g)]) bottleneckGroups.push(g);
  const bottleneckTeachers: number[] = [];
  for (let t = 0; t < teacherCount; t++) if (reachable[teacherNode(t)]) bottleneckTeachers.push(t);

  return { maxFlow, totalDemand, bottleneckGroups, bottleneckTeachers };
}
