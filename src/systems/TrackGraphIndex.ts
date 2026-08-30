import type { TrackGraph, TrackNode, TrackSegment } from '../types/level';
import { isSwitchNode } from '../types/level';

/**
 * Odvozený index nad `TrackGraph` pro vyhledávání za běhu — uzly, segmenty a routing
 * přes výhybky. Postaven jednou z definice levelu; stav výhybky (`current`) se vždy
 * čte živě z objektu uzlu, takže přepnutí výhybky nevyžaduje žádnou re-indexaci.
 *
 * Konvence: `branches` výhybky jsou VŽDY segmenty vycházející z ní (`segment.from === switch.id`).
 * Slévání dvou tratí do jedné (konvergentní výhybka) tento model zatím nepodporuje —
 * viz poznámka u lvl_03_junction_hub.json.
 */
export class TrackGraphIndex {
  private readonly nodesById = new Map<string, TrackNode>();
  private readonly segmentsById = new Map<string, TrackSegment>();
  private readonly outgoingByNode = new Map<string, TrackSegment[]>();

  constructor(graph: TrackGraph) {
    for (const node of graph.nodes) {
      this.nodesById.set(node.id, node);
    }
    for (const segment of graph.segments) {
      this.segmentsById.set(segment.id, segment);
      const list = this.outgoingByNode.get(segment.from) ?? [];
      list.push(segment);
      this.outgoingByNode.set(segment.from, list);
    }
  }

  getNode(id: string): TrackNode | undefined {
    return this.nodesById.get(id);
  }

  getSegment(id: string): TrackSegment | undefined {
    return this.segmentsById.get(id);
  }

  /** Všechny segmenty vycházející z daného uzlu (`segment.from === nodeId`). */
  getOutgoing(nodeId: string): TrackSegment[] {
    return this.outgoingByNode.get(nodeId) ?? [];
  }

  /**
   * Segment, po kterém má vlak pokračovat po opuštění uzlu `nodeId`.
   * - Výhybka: outgoing segment odpovídající aktuální `current` větvi.
   * - Jiný uzel s jediným pokračováním (stanice průjezdná, semafor): jeho jediný outgoing segment.
   * - `undefined`: konečná stanice (žádný outgoing), nebo vadná konfigurace výhybky
   *   (current neodpovídá žádné z jejích branches).
   */
  getNextSegment(nodeId: string): TrackSegment | undefined {
    const node = this.getNode(nodeId);
    const outgoing = this.getOutgoing(nodeId);
    if (node && isSwitchNode(node)) {
      return outgoing.find((segment) => segment.id === node.current);
    }
    return outgoing[0];
  }

  /**
   * Množina ID segmentů, které jsou při současném nastavení výhybek průjezdné od
   * nějakého "kořenového" uzlu (uzel bez příchozích segmentů — typicky výchozí
   * stanice). Na rozdíl od lokálního pohledu "patří segment aktivní větvi své
   * výhybky" tohle zvýrazní CELOU aktuálně zvolenou trasu až do konce, ne jen
   * první segment za výhybkou — použití: vizuální zvýraznění v `TrackGraphScene`.
   */
  computeReachableSegments(): Set<string> {
    const hasIncoming = new Set<string>();
    for (const segment of this.segmentsById.values()) {
      hasIncoming.add(segment.to);
    }
    const roots = [...this.nodesById.keys()].filter((id) => !hasIncoming.has(id));

    const reachable = new Set<string>();
    for (const rootId of roots) {
      let nodeId = rootId;
      const visitedOnThisWalk = new Set<string>();
      for (;;) {
        const segment = this.getNextSegment(nodeId);
        if (!segment || visitedOnThisWalk.has(segment.id)) break;
        reachable.add(segment.id);
        visitedOnThisWalk.add(segment.id);
        nodeId = segment.to;
      }
    }
    return reachable;
  }
}
