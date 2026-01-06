# Effect Graph API Reference

> **Since:** Effect 3.18.0 (experimental)  
> **Import:** `import { Graph } from "effect"`

## Quick Start

```typescript
import { Graph } from "effect"

// Create a directed graph with initial nodes and edges
const graph = Graph.directed<string, number>((g) => {
  const a = Graph.addNode(g, "A")
  const b = Graph.addNode(g, "B")
  const c = Graph.addNode(g, "C")
  Graph.addEdge(g, a, b, 1)
  Graph.addEdge(g, b, c, 2)
})

// Check for cycles
console.log(Graph.isAcyclic(graph)) // true

// Topological sort
for (const [idx, data] of Graph.topo(graph)) {
  console.log(idx, data) // 0 "A", 1 "B", 2 "C"
}
```

## Constructors

| Function | Description |
|----------|-------------|
| `Graph.directed<N, E>(mutate?)` | Create directed graph, optionally with mutation function |
| `Graph.undirected<N, E>(mutate?)` | Create undirected graph |

## Mutations

```typescript
// During construction or with beginMutation/endMutation
Graph.addNode(mutable, data)           // Returns NodeIndex
Graph.addEdge(mutable, src, tgt, data) // Returns EdgeIndex
Graph.removeNode(mutable, nodeIdx)
Graph.removeEdge(mutable, edgeIdx)
Graph.updateNode(mutable, idx, fn)
Graph.updateEdge(mutable, idx, fn)

// Scoped mutation
const newGraph = Graph.mutate(graph, (g) => {
  Graph.addNode(g, "new node")
})
```

## Getters

| Function | Returns |
|----------|---------|
| `Graph.getNode(graph, idx)` | `Option<N>` |
| `Graph.getEdge(graph, idx)` | `Option<Edge<E>>` |
| `Graph.hasNode(graph, idx)` | `boolean` |
| `Graph.hasEdge(graph, src, tgt)` | `boolean` |
| `Graph.nodeCount(graph)` | `number` |
| `Graph.edgeCount(graph)` | `number` |
| `Graph.neighbors(graph, idx)` | `Array<NodeIndex>` |
| `Graph.neighborsDirected(graph, idx, dir)` | `Array<NodeIndex>` |
| `Graph.findNode(graph, pred)` | `Option<NodeIndex>` |
| `Graph.findNodes(graph, pred)` | `Array<NodeIndex>` |

## Algorithms

```typescript
// Cycle detection
Graph.isAcyclic(graph)  // boolean

// Topological sort (throws on cycle)
Graph.topo(graph, { initials?: NodeIndex[] })

// Strongly connected components (directed)
Graph.stronglyConnectedComponents(graph)  // Array<Array<NodeIndex>>

// Connected components (undirected)
Graph.connectedComponents(graph)

// Bipartite check (undirected)
Graph.isBipartite(graph)
```

## Path Finding

```typescript
// Dijkstra (non-negative weights)
Graph.dijkstra(graph, { source, target, cost: (e) => e })

// A* (with heuristic)
Graph.astar(graph, { source, target, cost, heuristic })

// Bellman-Ford (handles negative weights)
Graph.bellmanFord(graph, { source, target, cost })

// Floyd-Warshall (all pairs)
Graph.floydWarshall(graph, cost)
```

## Traversal Iterators

All return `Walker<NodeIndex, N>` - use helper functions to extract data:

```typescript
// DFS/BFS traversal
const dfs = Graph.dfs(graph, { start: [0], direction?: "outgoing" | "incoming" })
const bfs = Graph.bfs(graph, { start: [0] })
const postOrder = Graph.dfsPostOrder(graph, { start: [0] })

// Topological order
const topo = Graph.topo(graph, { initials?: [0] })

// All nodes/edges
const allNodes = Graph.nodes(graph)
const allEdges = Graph.edges(graph)

// External nodes (sources/sinks)
Graph.externals(graph, { direction: "outgoing" })  // sinks (no outgoing)
Graph.externals(graph, { direction: "incoming" })  // sources (no incoming)
```

## Walker Helpers

```typescript
const walker = Graph.topo(graph)

// Get just indices
for (const idx of Graph.indices(walker)) { ... }

// Get just values
for (const data of Graph.values(walker)) { ... }

// Get [index, data] pairs
for (const [idx, data] of Graph.entries(walker)) { ... }

// Custom mapping
walker.visit((idx, data) => ({ id: idx, name: data }))
```

## Export

```typescript
Graph.toGraphViz(graph, { nodeLabel?, edgeLabel?, graphName? })
Graph.toMermaid(graph, { nodeLabel?, edgeLabel?, direction?, nodeShape? })
```

## Types

```typescript
type NodeIndex = number
type EdgeIndex = number
type Kind = "directed" | "undirected"
type Direction = "outgoing" | "incoming"

interface Graph<N, E, T extends Kind>
interface MutableGraph<N, E, T extends Kind>
interface Edge<E> { source: NodeIndex; target: NodeIndex; data: E }
interface PathResult<E> { path: NodeIndex[]; distance: number; costs: E[] }

class GraphError extends Data.TaggedError  // thrown on invalid operations
```

## Common Patterns

### Topological Sort with Cycle Detection

```typescript
import { Graph, Option } from "effect"

function topoSort<N, E>(graph: Graph.DirectedGraph<N, E>): N[] | "cycle" {
  if (!Graph.isAcyclic(graph)) {
    return "cycle"
  }
  return Array.from(Graph.values(Graph.topo(graph)))
}
```

### Build Graph from Dependencies

```typescript
const plugins = [
  { name: "a", deps: [] },
  { name: "b", deps: ["a"] },
  { name: "c", deps: ["b"] },
]

const graph = Graph.directed<string, void>((g) => {
  const nodeMap = new Map<string, number>()
  
  // Add all nodes
  for (const p of plugins) {
    nodeMap.set(p.name, Graph.addNode(g, p.name))
  }
  
  // Add dependency edges
  for (const p of plugins) {
    const target = nodeMap.get(p.name)!
    for (const dep of p.deps) {
      const source = nodeMap.get(dep)!
      Graph.addEdge(g, source, target, undefined)
    }
  }
})
```
