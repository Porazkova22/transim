/**
 * Level Definition & Track Graph — Type Contracts
 * ================================================
 * Datový standard pro definici levelů (viz CLAUDE.md, sekce 1 a 2).
 * Tyto typy jsou zdrojem pravdy pro JSON soubory levelů (src/levels/*.json)
 * i pro runtime reprezentaci sítě v enginu (Phaser 3 scény).
 */

// ---------------------------------------------------------------------------
// Základní enumy
// ---------------------------------------------------------------------------

export type Difficulty = 'Easy' | 'Medium' | 'Hard';

export type SignalState = 'GREEN' | 'RED';

export type CargoType = 'COMMUTER' | 'PERISHABLE' | 'HAZARDOUS';

// ---------------------------------------------------------------------------
// Track Graph — uzly
// ---------------------------------------------------------------------------

interface BaseNode {
  /** Unikátní ID uzlu v rámci levelu (např. "ST_WEST", "SW_1", "SIG_1"). */
  id: string;
  x: number;
  y: number;
}

export interface StationNode extends BaseNode {
  type: 'station';
  /** Zobrazovaný název stanice (UI). */
  name: string;
  /** Počet kolejí/nástupišť na stanici — určuje kapacitu souprav v klidu. */
  tracks: number;
}

export interface SwitchNode extends BaseNode {
  type: 'switch';
  /** ID segmentů, mezi kterými výhybka přepíná (typicky 2, min. 2). */
  branches: string[];
  /** ID aktuálně nastavené větve (musí být prvkem `branches`). */
  current: string;
}

export interface SignalNode extends BaseNode {
  type: 'signal';
  /** Aktuální návěst — řídí vjezd do navazujícího blokového úseku. */
  state: SignalState;
}

/** Diskriminovaná unie všech typů uzlů v Track Graphu. */
export type TrackNode = StationNode | SwitchNode | SignalNode;

// Type guards -----------------------------------------------------------

export const isStationNode = (n: TrackNode): n is StationNode => n.type === 'station';
export const isSwitchNode = (n: TrackNode): n is SwitchNode => n.type === 'switch';
export const isSignalNode = (n: TrackNode): n is SignalNode => n.type === 'signal';

// ---------------------------------------------------------------------------
// Track Graph — hrany (traťové segmenty)
// ---------------------------------------------------------------------------

export interface TrackSegment {
  /** Unikátní ID segmentu (např. "SEG_MAIN"). */
  id: string;
  /** ID výchozího uzlu. */
  from: string;
  /** ID cílového uzlu. */
  to: string;
  /** Délka segmentu v herních jednotkách — základ pro interpolaci pohybu a ETA. */
  length: number;
  /**
   * Kontrolní body Bézierovy/spline křivky pro vykreslení a pohyb soupravy
   * po trati. Minimálně 2 body (start, cíl); víc bodů = plynulejší zatáčka.
   */
  curve: Array<[number, number]>;
  /** Volitelný rychlostní limit segmentu (přepisuje rychlost soupravy, pokud je nižší). */
  maxSpeed?: number;
  /**
   * Pokud `true`, je segment průjezdný v obou směrech (výchozí: `false` = jednosměrně dle `from`→`to`).
   * Blokový systém musí u obousměrných segmentů zamítnout vjezd (nebo vyvolat kolizi),
   * pokud se v bloku už nachází vlak jedoucí v protisměru.
   */
  bidirectional?: boolean;
}

export interface TrackGraph {
  nodes: TrackNode[];
  segments: TrackSegment[];
}

// ---------------------------------------------------------------------------
// Náklad (cargo) — diskriminovaná unie dle CargoType
// ---------------------------------------------------------------------------

export interface CommuterCargo {
  type: 'COMMUTER';
  /** Maximální přípustné zpoždění oproti `timetableETA`, než je cíl považován za nesplněný. */
  maxDelaySec: number;
}

export interface PerishableCargo {
  type: 'PERISHABLE';
  /** Odpočet trvanlivosti v sekundách od spawnu — po vypršení náklad ztrácí hodnotu. */
  decaySec: number;
}

export interface HazardousCargo {
  type: 'HAZARDOUS';
  /** Multiplikátor rychlosti (např. 0.5) vynucený při průjezdu uzly a výhybkami — bezpečnostní zpomalení. */
  speedPenalty: number;
}

export type CargoConfig = CommuterCargo | PerishableCargo | HazardousCargo;

// ---------------------------------------------------------------------------
// Události levelu (poruchy) — viz `EventManager`
// ---------------------------------------------------------------------------

export type LevelEventType = 'SIGNAL_MALFUNCTION' | 'SWITCH_MALFUNCTION';

interface BaseLevelEvent {
  /** ID cílového uzlu (musí být `SignalNode` pro SIGNAL_MALFUNCTION, `SwitchNode` pro SWITCH_MALFUNCTION). */
  nodeId: string;
  /** Čas spuštění události od začátku levelu, v sekundách (stejná časová osa jako `TrainDefinition.spawnTimeSec`). */
  triggerTimeSec: number;
  /** Doba trvání poruchy v sekundách — po jejím uplynutí se uzel automaticky odemkne. */
  durationSec: number;
}

/**
 * Porucha semaforu: cílový `SignalNode` se v `triggerTimeSec` okamžitě přepne na `RED`
 * a po `durationSec` je uzamčen — hráčovo `releaseSignal` je po tuto dobu ignorováno.
 */
export interface SignalMalfunctionEvent extends BaseLevelEvent {
  type: 'SIGNAL_MALFUNCTION';
}

/**
 * Porucha výhybky: cílový `SwitchNode` po `durationSec` blokuje hráčovo `toggleSwitch`
 * (aktuální `current` větev se NEMĚNÍ a vlaky jí dál normálně projíždí).
 */
export interface SwitchMalfunctionEvent extends BaseLevelEvent {
  type: 'SWITCH_MALFUNCTION';
}

/** Diskriminovaná unie všech typů naplánovaných událostí levelu. */
export type LevelEvent = SignalMalfunctionEvent | SwitchMalfunctionEvent;

// ---------------------------------------------------------------------------
// Vlaky
// ---------------------------------------------------------------------------

export interface TrainDefinition {
  /** Unikátní ID soupravy (např. "EXP_402"). */
  id: string;
  /** Čas spawnu od začátku levelu, v sekundách. */
  spawnTimeSec: number;
  /** ID uzlu (stanice), odkud souprava vyjíždí. */
  origin: string;
  /** ID uzlu (stanice), kam souprava směřuje. */
  destination: string;
  /** Násobič základní rychlosti soupravy. */
  speed: number;
  /** Plánovaný čas dojezdu do cíle, v sekundách od spawnu — základ pro hodnocení zpoždění. */
  timetableETA: number;
  cargo: CargoConfig;
}

// ---------------------------------------------------------------------------
// Level
// ---------------------------------------------------------------------------

export interface LevelDefinition {
  levelId: string;
  name: string;
  difficulty: Difficulty;
  /** Cílové skóre pro splnění levelu na "výbornou". */
  targetScore: number;
  /** Časový limit levelu v sekundách. */
  timeLimitSec: number;
  trackGraph: TrackGraph;
  trains: TrainDefinition[];
  /** Naplánované poruchy (semafor/výhybka) — volitelné, chybí-li, level žádné nemá. */
  events?: LevelEvent[];
}
