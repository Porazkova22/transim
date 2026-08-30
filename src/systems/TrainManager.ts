import Phaser from 'phaser';
import type { TrainDefinition, TrackSegment, CargoType } from '../types/level';
import { isSignalNode } from '../types/level';
import { TrackGraphIndex } from './TrackGraphIndex';

/**
 * Základní rychlost v herních jednotkách/s při `TrainDefinition.speed === 1`.
 * 3x zvýšeno z původních 15 po hráčské zpětné vazbě z playtestu ("vlaky jezdí
 * moc pomalu, level je nudný") — viz `TrackGraphScene.timeMultiplier` pro
 * kompenzační ovládání rychlosti simulace (pauza/1x/2x/3x), které dává hráči
 * čas na reakci i při této vyšší základní rychlosti.
 */
const BASE_SPEED_UNITS_PER_SEC = 45;

/** Pojistka proti nekonečné smyčce, kdyby graf obsahoval cyklus samých krátkých segmentů v jednom snímku. */
const MAX_SEGMENT_HOPS_PER_TICK = 8;

/** Body za úspěšný despawn vlaku v jeho cílové stanici (a stejná penalizace při propadnutí/zkažení nákladu). */
const DESPAWN_SCORE = 100;

/**
 * Pod touto vzdáleností (herní jednotky, počítáno GLOBÁLNĚ ve 2D prostoru dle
 * skutečných x/y souřadnic sprite, ne dle shody `currentSegment.id`) mezi dvěma
 * vlaky nastává kolize. Zachytí i čelní srážku mezi dvěma směrově oddělenými
 * segmenty (viz `SEG_BOTTLENECK_WE`/`SEG_BOTTLENECK_EW` v lvl_04), které mají
 * různé `id`, ale sdílejí stejnou fyzickou trať.
 */
const COLLISION_DISTANCE_THRESHOLD = 15;

/** Vzdálenost od začátku/konce segmentu, ve které HAZARDOUS náklad podléhá `speedPenalty`. */
const NODE_PROXIMITY_UNITS = 20;

/** Barva vlaků po havárii — výrazně odlišná od běžných barev nákladu. */
const COLLISION_COLOR = 0xff0000;

/**
 * O kolik herních jednotek zkrátí trasu KAŽDÝ další vlak čekající ve frontě na
 * stejném uzlu (semaforu) za vlakem před sebou. Řeší falešnou 2D kolizi vlaků
 * zastavených na identických souřadnicích uzlu — každý další vlak v pořadí
 * zastaví o `QUEUE_OFFSET_UNITS` dříve podél křivky (viz `computeQueueOffset`).
 */
const QUEUE_OFFSET_UNITS = 20;

/** Barva vektorového tvaru vlaku (tělo + špička) podle typu nákladu. */
const CARGO_COLOR: Record<CargoType, number> = {
  COMMUTER: 0x4299e1,
  PERISHABLE: 0x68d391,
  HAZARDOUS: 0xed8936,
};

/** Rozměry vektorového vlaku (obdélníkové tělo + trojúhelníková špička ve směru jízdy). */
const TRAIN_BODY_WIDTH = 16;
const TRAIN_BODY_HEIGHT = 8;
const TRAIN_NOSE_LENGTH = 7;

/** Barvy textového labelu nad vlakem podle stavu nákladu (viz `updateLabel`). */
// Barvy popisků vlaků - přepnuto na tmavé odstíny čitelné na světlém pozadí
// (Mini Metro paleta), viz `TrackGraphScene.BACKGROUND_COLOR`.
const LABEL_COLOR_NORMAL = '#1c1917';
const LABEL_COLOR_WARNING = '#c2410c';
const LABEL_COLOR_LOST = '#b91c1c';

interface RuntimeTrain {
  readonly def: TrainDefinition;
  currentSegment: TrackSegment;
  path: Phaser.Curves.Path;
  pathLength: number;
  /** Ujetá vzdálenost od začátku `currentSegment`, v herních jednotkách. */
  distance: number;
  /** Container drží tělo (Rectangle) + špičku (Triangle) — natáčí se jako celek ve směru jízdy. */
  sprite: Phaser.GameObjects.Container;
  label: Phaser.GameObjects.Text;
  /** Hodnota `this.elapsedSec` v okamžiku spawnu — základ pro výpočet doby jízdy (ETA/decay). */
  spawnedAtSec: number;
  /** True po dojezdu do cíle (viz `despawned`) nebo po zastavení kvůli vadné/nedostupné výhybkové větvi. */
  stopped: boolean;
  /** True po despawnu (sprite/label už jsou zničené) — nesmí se na ně dál sahat. */
  despawned: boolean;
  /**
   * Kolik herních jednotek se aktuálně odečítá od `pathLength` jako "parkovací"
   * pozice ve frontě na červeném semaforu (0 = vlak není ve frontě, nebo je na
   * ní první v pořadí). Viz `computeQueueOffset` a přestavěnou smyčku v
   * `advanceTrain` — řeší falešnou kolizi vlaků zastavených na identických
   * souřadnicích uzlu.
   */
  queueOffset: number;
  /**
   * True, pokud vlak už MÁ přiřazené místo ve frontě (i když je `queueOffset`
   * shodou okolností 0 — první v pořadí). Odděleno od `queueOffset`, protože 0
   * je platná ustálená hodnota pro vlak vpředu fronty — bez tohoto příznaku by
   * se `computeQueueOffset` volalo znovu KAŽDÝ snímek (nepodmíněný přírůstek
   * `distance` na začátku `advanceTrain` tam vlak škubne zpátky přes práh každý
   * snímek), a dva čekající vlaky by si navzájem donekonečna přehazovaly offset
   * o +20 výš (každý vidí toho druhého už "přiskočeného" v témže snímku).
   */
  queued: boolean;
}

/** Výsledek vyhodnocení nákladu při dojezdu do cíle — bodový přírůstek (může být záporný) a důvod pro log. */
interface CargoOutcome {
  delta: number;
  note: string;
}

/**
 * Spawnuje vlaky z definice levelu v jejich `spawnTimeSec`, posouvá je po trati
 * interpolací podél `Phaser.Curves.Path` aktuálně aktivního segmentu a řeší:
 *
 * - Blokový systém: semafor (`SignalNode`) chrání navazující blok. `RED` → vlak
 *   zastaví přesně na semaforu, kontrola se opakuje každý snímek (žádný cache) —
 *   jakmile ho hráč kliknutím uvolní na GREEN (viz `TrackGraphScene`), vlak
 *   v dalším snímku automaticky pokračuje. `GREEN` → vlak projede a semafor
 *   OKAMŽITĚ přepne na `RED` (obsazení bloku).
 * - Výhybky se řeší živě přes `switch.current` (beze změny oproti minulému kroku).
 * - HAZARDOUS náklad: v těsné blízkosti libovolného uzlu (do `NODE_PROXIMITY_UNITS`
 *   od začátku nebo konce aktuálního segmentu) jede rychlostí `def.speed * speedPenalty`;
 *   na rovince uprostřed segmentu plnou `def.speed`.
 * - Kolize: GLOBÁLNÍ 2D kontrola vzdálenosti mezi VŠEMI dvojicemi aktivních vlaků
 *   (dle skutečných x/y souřadnic sprite na plátně, ne dle `currentSegment.id`) —
 *   nezávisí na tom, jestli jsou na stejném segmentu; zachytí i čelní srážku na
 *   fyzicky sdílené, ale datově směrově rozdělené trati (bottleneck workaround).
 *   Pod `COLLISION_DISTANCE_THRESHOLD` nastává `GAME_OVER_COLLISION` — simulace
 *   (pohyb i spawnování) se natrvalo zastaví.
 * - Časový tlak nákladu (COMMUTER/PERISHABLE): nevyvolává Game Over, jen mění
 *   bodový zisk při despawnu (viz `resolveCargoOutcome`) — skóre může jít do
 *   mínusu. Label nad vlakem tiká v reálném čase (viz `updateLabel`).
 */
export class TrainManager {
  private elapsedSec = 0;
  private score = 0;
  private gameOverMessage: string | null = null;
  private readonly pending: TrainDefinition[];
  private readonly active: RuntimeTrain[] = [];
  /** Celkový počet vlaků v levelu — pojistka proti falešné výhře v `isLevelComplete()` u levelu bez vlaků. */
  private readonly totalTrainCount: number;

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly graph: TrackGraphIndex,
    trains: TrainDefinition[],
  ) {
    this.pending = [...trains].sort((a, b) => a.spawnTimeSec - b.spawnTimeSec);
    this.totalTrainCount = trains.length;
  }

  /**
   * Zavolat jednou za snímek (typicky ze `Scene.update`) se skutečně uplynulým
   * časem v sekundách (`deltaSec`, NEZÁVISLE na pauze/rychlosti) a aktuálním
   * `timeMultiplier` z `TrackGraphScene` (0 = pauza, 1/2/3 = normální/2x/3x).
   * Simulační krok `simDelta = deltaSec * timeMultiplier` je jediné místo, kde
   * se násobič aplikuje — `elapsedSec`, pohyb vlaků i případ pauzy (`simDelta === 0`,
   * viz guard v `advanceTrain`) z něj vychází jednotně.
   */
  update(deltaSec: number, timeMultiplier: number): void {
    if (this.gameOverMessage) {
      return; // simulace je po havárii natrvalo zamrzlá
    }

    const simDelta = deltaSec * timeMultiplier;
    this.elapsedSec += simDelta;
    this.spawnDueTrains();
    // Kopie pole: despawn (viz handleEndOfLine) může za běhu smazat prvek z `active`;
    // iterace nad kopií zabrání přeskočení následujícího vlaku ve stejném snímku.
    for (const train of [...this.active]) {
      if (!train.stopped) {
        this.advanceTrain(train, simDelta);
      }
    }

    this.checkCollisions();
  }

  /** Aktuální skóre hráče (může být záporné — viz penalizace propadlého/zkaženého nákladu). */
  getScore(): number {
    return this.score;
  }

  /** `null` pokud hra normálně běží, jinak text havárie pro zobrazení v UI scény. */
  getGameOverMessage(): string | null {
    return this.gameOverMessage;
  }

  /**
   * True, pokud level nemá žádné čekající ani aktivní vlaky — výherní podmínka
   * ("všechny vlaky vyřízené"). `totalTrainCount > 0` je nutná pojistka: bez ní by
   * level BEZ vlaků (např. testovací fixture) hlásil výhru okamžitě v prvním snímku.
   */
  isLevelComplete(): boolean {
    return this.totalTrainCount > 0 && this.pending.length === 0 && this.active.length === 0;
  }

  private spawnDueTrains(): void {
    while (this.pending.length > 0 && this.pending[0].spawnTimeSec <= this.elapsedSec) {
      const def = this.pending.shift()!;
      this.spawnTrain(def);
    }
  }

  /** Vytvoří vektorový tvar vlaku — obdélníkové tělo + trojúhelníková špička ve směru jízdy (lokálně +x). */
  private buildTrainShape(startX: number, startY: number, color: number): Phaser.GameObjects.Container {
    const body = this.scene.add
      .rectangle(0, 0, TRAIN_BODY_WIDTH, TRAIN_BODY_HEIGHT, color)
      .setStrokeStyle(2, 0x1a202c, 1);
    const halfBody = TRAIN_BODY_WIDTH / 2;
    const nose = this.scene.add
      .triangle(
        0,
        0,
        halfBody,
        -TRAIN_BODY_HEIGHT / 2,
        halfBody,
        TRAIN_BODY_HEIGHT / 2,
        halfBody + TRAIN_NOSE_LENGTH,
        0,
        color,
      )
      .setStrokeStyle(2, 0x1a202c, 1);
    return this.scene.add.container(startX, startY, [body, nose]);
  }

  private spawnTrain(def: TrainDefinition): void {
    const segment = this.graph.getNextSegment(def.origin);
    if (!segment) {
      console.error(`[TrainManager] ${def.id}: uzel "${def.origin}" nemá žádné pokračování — vlak se nespawnul.`);
      return;
    }

    const path = this.buildPath(segment);
    const start = path.getStartPoint();

    const sprite = this.buildTrainShape(start.x, start.y, CARGO_COLOR[def.cargo.type]);
    sprite.setDepth(10);
    const label = this.scene.add
      .text(start.x, start.y - 16, def.id, {
        color: LABEL_COLOR_NORMAL,
        fontSize: '10px',
        fontFamily: 'monospace',
      })
      .setOrigin(0.5, 1)
      .setDepth(10);

    const train: RuntimeTrain = {
      def,
      currentSegment: segment,
      path,
      pathLength: path.getLength(),
      distance: 0,
      sprite,
      label,
      spawnedAtSec: this.elapsedSec,
      stopped: false,
      despawned: false,
      queueOffset: 0,
      queued: false,
    };

    this.updateLabel(train); // počáteční text/barva labelu podle typu nákladu
    this.active.push(train);
  }

  private buildPath(segment: TrackSegment): Phaser.Curves.Path {
    const [start, ...rest] = segment.curve;
    const path = new Phaser.Curves.Path(start[0], start[1]);
    for (const point of rest) {
      path.lineTo(point[0], point[1]);
    }
    return path;
  }

  /** `def.speed`, s HAZARDOUS penalizací v blízkosti kraje aktuálního segmentu. */
  private computeSpeedMultiplier(train: RuntimeTrain): number {
    const baseSpeed = train.def.speed;
    const cargo = train.def.cargo;
    if (cargo.type !== 'HAZARDOUS') {
      return baseSpeed;
    }
    const nearNode =
      train.distance < NODE_PROXIMITY_UNITS || train.distance > train.pathLength - NODE_PROXIMITY_UNITS;
    return nearNode ? baseSpeed * cargo.speedPenalty : baseSpeed;
  }

  /**
   * Vypočte "parkovací" offset pro vlak, který právě zastavuje na `nodeId` kvůli
   * červené. Najde MAXIMÁLNÍ `queueOffset` mezi ostatními vlaky, které už na
   * stejném uzlu skutečně stojí (`currentSegment.to === nodeId` a jejich
   * `distance` odpovídá jejich vlastnímu parkovacímu bodu), a přiřadí se za ně
   * na konec fronty (+`QUEUE_OFFSET_UNITS`). Nepočítá pořadové číslo — díky tomu
   * se fronta sama "zhušťuje": když vlak vpředu odjede, zbylé vlaky si při
   * každém přepočtu (viz smyčka v `advanceTrain`) najdou nový, menší offset.
   */
  private computeQueueOffset(nodeId: string, excluding: RuntimeTrain): number {
    let maxOffset = -QUEUE_OFFSET_UNITS;
    for (const other of this.active) {
      if (other === excluding || other.despawned) {
        continue;
      }
      const isParkedHere = other.currentSegment.to === nodeId && other.queued;
      if (isParkedHere) {
        maxOffset = Math.max(maxOffset, other.queueOffset);
      }
    }
    return Math.max(0, maxOffset + QUEUE_OFFSET_UNITS);
  }

  private advanceTrain(train: RuntimeTrain, deltaSec: number): void {
    if (deltaSec <= 0) {
      // Pauza (TrackGraphScene.timeMultiplier === 0) — scéna už do `update()` pošle
      // nulový (zdejchaný) deltaSec, takže tahle větev je čistě obranná/rychlá cesta ven.
      return;
    }

    const speedMultiplier = this.computeSpeedMultiplier(train);
    train.distance += speedMultiplier * BASE_SPEED_UNITS_PER_SEC * deltaSec;

    let hops = 0;
    while (
      train.distance >= train.pathLength - train.queueOffset &&
      !train.stopped &&
      hops < MAX_SEGMENT_HOPS_PER_TICK
    ) {
      hops += 1;
      const arrivedNodeId = train.currentSegment.to;

      // KRITICKÉ: cíl se kontroluje PŘED jakýmkoli dalším routingem. Uzel může
      // být zároveň cílem jednoho vlaku i průjezdnou stanicí s vlastním outgoing
      // segmentem pro jiný vlak (viz ST_WEST/ST_EAST v lvl_04_bottleneck — obě
      // slouží zároveň jako startovní i cílová stanice). Kontrola "žádný další
      // segment = konec trati" by v takovém topologii cílovou stanici nikdy
      // nezachytila — vlak by jí prostě projel a nekonečně kroužil po síti.
      if (arrivedNodeId === train.def.destination) {
        this.arriveAtDestination(train, arrivedNodeId);
        break;
      }

      const arrivedNode = this.graph.getNode(arrivedNodeId);
      const isBlockedBySignal = !!arrivedNode && isSignalNode(arrivedNode) && arrivedNode.state === 'RED';

      if (isBlockedBySignal) {
        if (!train.queued) {
          // Poprvé v TÉTO frontě — přiřadit pevné místo za aktuálně zaparkované
          // vlaky (viz `computeQueueOffset`). Dál se offset NEPŘEPOČÍTÁVÁ, dokud
          // vlak čeká (viz `queued` na `RuntimeTrain`) — jen se každý snímek
          // znovu doklemuje na STEJNOU pozici, protože nepodmíněný přírůstek
          // `distance` výše ho škubne zpět přes práh i když stojí.
          train.queueOffset = this.computeQueueOffset(arrivedNodeId, train);
          train.queued = true;
        }
        train.distance = Math.max(0, train.pathLength - train.queueOffset);
        break;
      }

      if (train.queued) {
        train.queued = false;
        if (train.queueOffset > 0) {
          // GREEN, ale vlak byl kvůli frontě zastavený PŘED skutečnou hranicí
          // segmentu (`distance < pathLength`) — jen uvolnit frontu a NEPOKRAČOVAT
          // dál ve stejném snímku. Normální přírůstek `distance` v dalších snímcích
          // ho k hranici doveze sám; teprve pak tato smyčka znovu zareaguje a
          // proběhne přes běžnou (níže nezměněnou) routovací logiku.
          train.queueOffset = 0;
          break;
        }
        // queueOffset už byl 0 (vlak byl vpředu fronty, fyzicky přesně na hranici)
        // — žádná zvláštní "grace" snímka není potřeba, pokračuje rovnou níže.
        train.queueOffset = 0;
      }

      if (arrivedNode && isSignalNode(arrivedNode)) {
        // GREEN a vlak už fyzicky stojí přesně na hranici -> vjíždí do bloku
        // a okamžitě ho obsazuje.
        arrivedNode.state = 'RED';
      }

      const overshoot = train.distance - train.pathLength;
      const nextSegment = this.graph.getNextSegment(arrivedNodeId);
      if (!nextSegment) {
        this.handleDeadEnd(train, arrivedNodeId);
        break;
      }

      train.currentSegment = nextSegment;
      train.path = this.buildPath(nextSegment);
      train.pathLength = train.path.getLength();
      train.distance = overshoot;
      train.queueOffset = 0;
    }

    if (!train.despawned) {
      this.updatePosition(train);
    }
  }

  /** Vlak dorazil do svého `def.destination` — vyhodnotí náklad, připíše/odečte skóre a despawne. */
  private arriveAtDestination(train: RuntimeTrain, nodeId: string): void {
    const outcome = this.resolveCargoOutcome(train);
    this.score += outcome.delta;
    const scoreLabel = outcome.delta >= 0 ? `+${outcome.delta}` : `${outcome.delta}`;
    console.log(
      `[TrainManager] ${train.def.id}: dorazil do cíle "${nodeId}" (${scoreLabel} bodů — ${outcome.note}; skóre ${this.score}).`,
    );
    this.despawnTrain(train);
  }

  /** Vlak zastavil na uzlu, který není jeho cílem a nemá žádné další pokračování — chyba konfigurace/výhybky. */
  private handleDeadEnd(train: RuntimeTrain, nodeId: string): void {
    console.error(
      `[TrainManager] ${train.def.id}: zastavil na uzlu "${nodeId}" — žádné platné pokračování ` +
        '(výhybka může být nastavená jinam, nebo jde o konec trati).',
    );
    train.distance = train.pathLength;
    train.stopped = true;
  }

  /**
   * Vyhodnotí bodový přínos nákladu při dojezdu do cíle:
   * - COMMUTER: pokud celková doba jízdy (od spawnu) přesáhne `timetableETA + maxDelaySec`,
   *   náklad propadá — místo `+DESPAWN_SCORE` se odečte `DESPAWN_SCORE` (skóre může jít do mínusu).
   * - PERISHABLE: pokud doba jízdy přesáhne `decaySec` (trvanlivost), náklad je znehodnocený —
   *   stejná penalizace jako u COMMUTER.
   * - HAZARDOUS: žádný časový limit v zadání levelu — vždy `+DESPAWN_SCORE` (beze změny oproti
   *   předchozí verzi; `speedPenalty` už je vynucen v `computeSpeedMultiplier`).
   */
  private resolveCargoOutcome(train: RuntimeTrain): CargoOutcome {
    const travelSec = this.elapsedSec - train.spawnedAtSec;
    const cargo = train.def.cargo;

    if (cargo.type === 'COMMUTER') {
      const deadline = train.def.timetableETA + cargo.maxDelaySec;
      if (travelSec > deadline) {
        return {
          delta: -DESPAWN_SCORE,
          note: `COMMUTER náklad propadl (jízda ${travelSec.toFixed(1)}s > limit ${deadline.toFixed(1)}s)`,
        };
      }
      return {
        delta: DESPAWN_SCORE,
        note: `COMMUTER v termínu (jízda ${travelSec.toFixed(1)}s, limit ${deadline.toFixed(1)}s)`,
      };
    }

    if (cargo.type === 'PERISHABLE') {
      if (travelSec > cargo.decaySec) {
        return {
          delta: -DESPAWN_SCORE,
          note: `PERISHABLE náklad shnil (jízda ${travelSec.toFixed(1)}s > trvanlivost ${cargo.decaySec}s)`,
        };
      }
      return {
        delta: DESPAWN_SCORE,
        note: `PERISHABLE v pořádku (jízda ${travelSec.toFixed(1)}s, trvanlivost ${cargo.decaySec}s)`,
      };
    }

    // HAZARDOUS — bez časového limitu.
    return { delta: DESPAWN_SCORE, note: 'HAZARDOUS doručen' };
  }

  private despawnTrain(train: RuntimeTrain): void {
    train.stopped = true;
    train.despawned = true;
    // Explicitně zničit obě děti Containeru (tělo + špička) — nespoléhat na to,
    // že `Container.destroy()` samo smaže i potomky.
    for (const child of [...train.sprite.list]) {
      child.destroy();
    }
    train.sprite.destroy();
    train.label.destroy();
    const index = this.active.indexOf(train);
    if (index !== -1) {
      this.active.splice(index, 1);
    }
  }

  private updatePosition(train: RuntimeTrain): void {
    const t = Phaser.Math.Clamp(train.distance / train.pathLength, 0, 1);
    const point = train.path.getPoint(t);
    train.sprite.setPosition(point.x, point.y);
    // Natočení vlaku (Container) ve směru jízdy — tečna dráhy v aktuálním `t` převedená na úhel.
    const tangent = train.path.getTangent(t);
    train.sprite.setRotation(Math.atan2(tangent.y, tangent.x));
    train.label.setPosition(point.x, point.y - 16);
    this.updateLabel(train);
  }

  /**
   * Aktualizuje text a barvu labelu nad vlakem podle živého stavu časového tlaku nákladu.
   * Volá se každý snímek (z `updatePosition`), takže hráč vidí odpočet tikat v reálném čase —
   * i když vlak zrovna stojí na červené (updatePosition se volá i pro zaparkované vlaky).
   */
  private updateLabel(train: RuntimeTrain): void {
    const travelSec = this.elapsedSec - train.spawnedAtSec;
    const cargo = train.def.cargo;

    if (cargo.type === 'COMMUTER') {
      const deadline = train.def.timetableETA + cargo.maxDelaySec;
      if (travelSec > deadline) {
        train.label.setText(`${train.def.id} PROPADLÝ!`);
        train.label.setColor(LABEL_COLOR_LOST);
      } else if (travelSec > train.def.timetableETA) {
        const lateBy = Math.ceil(travelSec - train.def.timetableETA);
        train.label.setText(`${train.def.id} +${lateBy}s`);
        train.label.setColor(LABEL_COLOR_WARNING);
      } else {
        const remaining = Math.ceil(train.def.timetableETA - travelSec);
        train.label.setText(`${train.def.id} ETA ${remaining}s`);
        train.label.setColor(LABEL_COLOR_NORMAL);
      }
      return;
    }

    if (cargo.type === 'PERISHABLE') {
      const remaining = cargo.decaySec - travelSec;
      if (remaining <= 0) {
        train.label.setText(`${train.def.id} SHNILÉ!`);
        train.label.setColor(LABEL_COLOR_LOST);
      } else {
        train.label.setText(`${train.def.id} ${Math.ceil(remaining)}s`);
        train.label.setColor(remaining <= cargo.decaySec * 0.25 ? LABEL_COLOR_WARNING : LABEL_COLOR_NORMAL);
      }
      return;
    }

    // HAZARDOUS — žádný časový limit, jen ID vlaku.
    train.label.setText(train.def.id);
    train.label.setColor(LABEL_COLOR_NORMAL);
  }

  /**
   * Havárie: GLOBÁLNÍ 2D kontrola — porovná skutečné x/y souřadnice sprite VŠECH dvojic
   * aktivních vlaků, bez ohledu na `currentSegment.id`. Nutné kvůli workaroundu za
   * `getNextSegment` (viz TrackGraphIndex): obousměrný úsek je datově rozdělen na dva
   * směrové segmenty s různým `id`, takže srovnání jen podle `currentSegment.id` by
   * čelní srážku na sdílené fyzické trati vůbec nezachytilo.
   */
  private checkCollisions(): void {
    for (let i = 0; i < this.active.length; i += 1) {
      for (let j = i + 1; j < this.active.length; j += 1) {
        const a = this.active[i];
        const b = this.active[j];

        if (this.isConvergingApproach(a, b) || this.isConvergingApproach(b, a)) {
          // Jeden z páru už čeká zaparkovaný přesně NA souřadnicích uzlu (fronta s
          // offsetem 0 — vlak vpředu) a druhý se k TÉMUŽ uzlu teprve blíží po JINÉM
          // segmentu. Poslední úsek libovolného příjezdu geometricky prochází těsně
          // kolem souřadnic cílového uzlu bez ohledu na offset fronty — to není
          // skutečná srážka, jen sbíhající se trajektorie ke společnému semaforu.
          // Skutečná kolize (stojící vlak vs. vlak co do něj narazí) tímto vyloučená
          // NENÍ: jakmile druhý vlak sám dorazí a zjistí červenou, dostane vlastní
          // frontový slot (viz `advanceTrain`/`computeQueueOffset`) a bude se
          // kontrolovat úplně stejně jako každý jiný pár aktivních vlaků.
          continue;
        }

        const dx = a.sprite.x - b.sprite.x;
        const dy = a.sprite.y - b.sprite.y;
        const distance2D = Math.hypot(dx, dy);
        if (distance2D < COLLISION_DISTANCE_THRESHOLD) {
          this.triggerGameOver(a, b);
          return;
        }
      }
    }
  }

  /**
   * True, pokud `queuedTrain` už čeká zaparkovaný na semaforu (viz `queued`) a
   * `approaching` teprve směřuje k TOMUŽ SAMÉMU uzlu (`currentSegment.to` shodné)
   * — tedy jde o dva vlaky sbíhající se ke stejnému semaforu, ne o srážku na
   * fyzicky sdílené trati (ta se řeší dál mimo tuto výjimku, viz `checkCollisions`).
   */
  private isConvergingApproach(queuedTrain: RuntimeTrain, approaching: RuntimeTrain): boolean {
    return queuedTrain.queued && approaching.currentSegment.to === queuedTrain.currentSegment.to;
  }

  private triggerGameOver(a: RuntimeTrain, b: RuntimeTrain): void {
    const message = `GAME_OVER_COLLISION: ${a.def.id} × ${b.def.id} (2D vzdálenost < ${COLLISION_DISTANCE_THRESHOLD})`;
    this.gameOverMessage = message;
    console.error(`[TrainManager] ${message}`);

    for (const train of [a, b]) {
      for (const child of train.sprite.list as Phaser.GameObjects.Shape[]) {
        child.setFillStyle(COLLISION_COLOR, 1);
        child.setStrokeStyle(3, 0xffffff, 1);
      }
    }
  }
}
