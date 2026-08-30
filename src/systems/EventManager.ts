import type { LevelEvent } from '../types/level';
import { isSignalNode, isSwitchNode } from '../types/level';
import { TrackGraphIndex } from './TrackGraphIndex';

interface ActiveMalfunction {
  readonly event: LevelEvent;
  expiresAtSec: number;
}

/**
 * Spouští naplánované poruchy z `LevelDefinition.events` v jejich `triggerTimeSec`
 * a po dobu `durationSec` drží cílový uzel uzamčený pro hráčovu interakci:
 *
 * - `SIGNAL_MALFUNCTION`: při spuštění okamžitě přepne semafor na `RED` (blokový
 *   systém v `TrainManager` čte `state` živě každý snímek, takže vynucené RED
 *   funguje beze změny v TrainManageru) a po dobu poruchy hráč nemůže semafor
 *   uvolnit (`releaseSignal` je ignorováno — viz `isSignalLocked`).
 * - `SWITCH_MALFUNCTION`: nemění `switch.current` ani routing — vlaky jí dál
 *   normálně projíždí — jen po dobu poruchy blokuje hráčovo přepínání
 *   (`toggleSwitch` je ignorováno — viz `isSwitchLocked`).
 *
 * Časová osa (`elapsedSec`) je nezávislá na `TrainManageru` (stejný vzor: obě
 * třídy dostávají stejný `deltaSec` ze `Scene.update`, ale nesdílí si hodiny) —
 * `triggerTimeSec`/`durationSec` je proto potřeba zadávat ve stejné škále jako
 * `TrainDefinition.spawnTimeSec` (sekundy od začátku levelu), ne v reálném čase.
 */
export class EventManager {
  private elapsedSec = 0;
  private readonly pending: LevelEvent[];
  private readonly activeByNode = new Map<string, ActiveMalfunction>();

  constructor(
    private readonly graph: TrackGraphIndex,
    events: LevelEvent[],
  ) {
    this.pending = [...events].sort((a, b) => a.triggerTimeSec - b.triggerTimeSec);
  }

  /** Zavolat jednou za snímek (typicky ze `Scene.update`, PŘED `TrainManager.update`). */
  update(deltaSec: number): void {
    this.elapsedSec += deltaSec;

    while (this.pending.length > 0 && this.pending[0].triggerTimeSec <= this.elapsedSec) {
      this.activate(this.pending.shift()!);
    }

    for (const [nodeId, malfunction] of this.activeByNode) {
      if (this.elapsedSec >= malfunction.expiresAtSec) {
        this.activeByNode.delete(nodeId);
        console.log(`[EventManager] ${malfunction.event.type} na "${nodeId}" skončila — uzel odemčen.`);
      }
    }
  }

  private activate(event: LevelEvent): void {
    const node = this.graph.getNode(event.nodeId);
    if (!node) {
      console.error(`[EventManager] "${event.type}": uzel "${event.nodeId}" v grafu neexistuje — událost přeskočena.`);
      return;
    }

    if (event.type === 'SIGNAL_MALFUNCTION') {
      if (!isSignalNode(node)) {
        console.error(`[EventManager] SIGNAL_MALFUNCTION cílí na "${event.nodeId}", který není semafor — přeskočeno.`);
        return;
      }
      node.state = 'RED'; // Okamžité vynucení — TrainManager i TrackGraphScene čtou stav živě.
    } else if (event.type === 'SWITCH_MALFUNCTION') {
      if (!isSwitchNode(node)) {
        console.error(`[EventManager] SWITCH_MALFUNCTION cílí na "${event.nodeId}", který není výhybka — přeskočeno.`);
        return;
      }
      // Routing (`node.current`) se záměrně nemění — vlaky jezdí dál, jen se zamyká interakce.
    }

    this.activeByNode.set(event.nodeId, { event, expiresAtSec: this.elapsedSec + event.durationSec });
    console.log(`[EventManager] ${event.type} aktivována na "${event.nodeId}" (trvání ${event.durationSec}s).`);
  }

  /** True, pokud na uzlu právě běží porucha semaforu — `TrackGraphScene.releaseSignal` musí klik ignorovat. */
  isSignalLocked(nodeId: string): boolean {
    return this.activeByNode.get(nodeId)?.event.type === 'SIGNAL_MALFUNCTION';
  }

  /** True, pokud na uzlu právě běží porucha výhybky — `TrackGraphScene.toggleSwitch` musí klik ignorovat. */
  isSwitchLocked(nodeId: string): boolean {
    return this.activeByNode.get(nodeId)?.event.type === 'SWITCH_MALFUNCTION';
  }

  /** True, pokud na uzlu běží JAKÁKOLI porucha — pro vykreslení "ERR!" overlaye v `TrackGraphScene`. */
  isMalfunctioning(nodeId: string): boolean {
    return this.activeByNode.has(nodeId);
  }
}
