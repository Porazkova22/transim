import Phaser from 'phaser';
import type { LevelDefinition, TrackNode, TrackSegment } from '../types/level';
import { isStationNode, isSwitchNode, isSignalNode } from '../types/level';
import { TrackGraphIndex } from '../systems/TrackGraphIndex';
import { TrainManager } from '../systems/TrainManager';
import { EventManager } from '../systems/EventManager';
import type { LevelEndSceneData } from './LevelEndScene';

/** Level načtený, když scéna nedostane `levelKey` přes data scény (např. přímé spuštění mimo menu). */
const DEFAULT_LEVEL_KEY = 'lvl_03_junction_hub';

/** Data předávaná do `TrackGraphScene` přes `this.scene.start('TrackGraphScene', data)`. */
export interface TrackGraphSceneData {
  levelKey?: string;
}

/** Po kolizi počkat tolik ms (ať hráč vidí havárii), než se přepne na `LevelEndScene`. */
const DEFEAT_TRANSITION_DELAY_MS = 2000;

/**
 * Velmi tmavé, "elegantní" pozadí scény — [DESIGN: Neon Dispatch Rewrite]
 * (2026-08-30), náhrada za předchozí SVĚTLÝ Mini Metro motiv (krémová/bílá).
 * Hráčská zpětná vazba po otestování: "hra je nepřehledná, značení uzlů je
 * titěrné a neintuitivní" — řešeno kontrastním "neonovým" jazykem (tmavé
 * pozadí + svítivé aktivní tratě/světla), ne dalším zmenšováním textu.
 *
 * POZOR na důsledek pro OSTATNÍ scény: `MainMenuScene`/`LevelEndScene`/
 * `createButton.ts` v tomto kole ZŮSTÁVAJÍ na světlé Mini Metro paletě z
 * minulého kola (uživatel v tomto zadání explicitně vyjmenoval jen tento
 * soubor a `TrainManager.ts` jako dodávané soubory) — vznikne tak dočasná
 * vizuální nekonzistence (světlé menu → tmavá hra → světlý konec). `TrainManager.ts`
 * popisky vlaků JSOU v tomto kole přebarveny zpět na světlé (na tmavém pozadí
 * jinak nečitelné) — to je uvnitř explicitně dodávaného souboru, viz tam.
 */
const BACKGROUND_COLOR = 0x111118;

const COLORS = {
  // Trať: neaktivní tence/poloprůhledně, aktivní tlustě a svítivě (glow = širší
  // poloprůhledná čára POD ostrým jádrem, viz `redrawSegments`/`strokeGlowPath`).
  trackActive: 0x38bdf8,
  trackInactive: 0x333340,
  // Stanice beze změny — bílý/krémový "papírový" chip s tmavým inkoustem funguje
  // vizuálně nezávisle na barvě pozadí scény (vlastní kontrast), viz `drawStation`.
  stationFill: 0xfffdf7,
  ink: 0x1c1917,
  // Výhybka a semafor — nový tmavě šedý "socket/panel" jazyk (misto bílého chipu),
  // aby ladil s tmavým pozadím, se světlým obrysem pro čitelnost hrany.
  switchFill: 0x27272e,
  switchStroke: 0x52525b,
  switchAccent: 0xfbbf24,
  signalPanel: 0x27272e,
  signalPanelStroke: 0x52525b,
  signalRed: 0xef4444,
  signalGreen: 0x22c55e,
  malfunction: '#f87171',
  text: '#f4f4f5',
  textMuted: '#9ca3af',
  speedNormal: '#f4f4f5',
  speedPaused: '#fb923c',
} as const;

/** Poloměr kruhového "socketu" výhybky a délka indikační čáry k aktivní větvi (viz `redrawSwitches`). */
const SWITCH_RADIUS = 12;
const SWITCH_INDICATOR_LENGTH = 22;

/** Rozměr čtvercového panelu semaforu a poloměr jeho světla (viz `redrawSignals`). */
const SIGNAL_PANEL_SIZE = 30;
const SIGNAL_LIGHT_RADIUS = 9;

/**
 * Vykresluje Track Graph a hostí herní smyčku levelu:
 * - klik na výhybku přepíná `current` větev,
 * - klik na semafor ho uvolní z RED na GREEN (do RED ho vrací jen `TrainManager`,
 *   když jím projede vlak — hráč tedy jen "pouští provoz", neblokuje ho ručně),
 * - `TrainManager` každý snímek spawnuje a posouvá vlaky, řeší kolize a despawn,
 * - `EventManager` každý snímek spouští naplánované poruchy (`level.events`) a hlídá
 *   jejich uzamčené uzly — poruchový uzel dostane blikající "ERR!" overlay a jeho
 *   kliknutí (`toggleSwitch`/`releaseSignal`) je po dobu poruchy ignorováno,
 * - skóre a případný GAME_OVER_COLLISION banner se čtou z `TrainManager` každý snímek.
 *
 * Vizuál je čistě vektorový (`Phaser.GameObjects.Graphics`/`Shape`/`Text`) — žádné
 * externí obrázkové/video assety. Textové popisky jsou záměrně minimální — která
 * větev výhybky je aktivní se čte z INDIKAČNÍ ČÁRY (`redrawSwitches`), ne z textu;
 * která trať je právě průjezdná se čte ze zvýraznění (`redrawSegments`), ne z popisku.
 */
export class TrackGraphScene extends Phaser.Scene {
  private level!: LevelDefinition;
  private graphIndex!: TrackGraphIndex;
  private trainManager!: TrainManager;
  private eventManager!: EventManager;
  private segmentsGraphics!: Phaser.GameObjects.Graphics;
  private switchesGraphics!: Phaser.GameObjects.Graphics;
  private signalsGraphics!: Phaser.GameObjects.Graphics;
  private scoreText!: Phaser.GameObjects.Text;
  private gameOverText!: Phaser.GameObjects.Text;
  private lastRenderedScore = 0;
  /** Blikající "ERR!" overlay nad poruchovým uzlem — vytvořen skrytý pro každou výhybku/semafor, viz `createErrorOverlay`. */
  private readonly errorOverlays = new Map<string, Phaser.GameObjects.Text>();
  /** ID aktuálně hraného levelu — z `init(data)`, nebo `DEFAULT_LEVEL_KEY` při přímém spuštění. */
  private levelKey = DEFAULT_LEVEL_KEY;
  /** True jakmile je naplánovaný přechod na `LevelEndScene` — `update()` pak dál nic nepočítá/nepřekresluje. */
  private levelEnding = false;
  /** Uplynulý čas levelu v sekundách — nezávislá časová osa od `TrainManager.elapsedSec`, ale se stejným počátkem (create()). */
  private elapsedSec = 0;
  /** UI prvek s odpočtem zbývajícího času — text se přepisuje jen při změně zaokrouhlené hodnoty (viz `update`). */
  private timeText!: Phaser.GameObjects.Text;
  /** Poslední vykreslená hodnota odpočtu (celé sekundy) — zabraňuje zbytečnému `setText` každý snímek. */
  private lastRenderedTimeSec = -1;
  /** UI prvek s aktuální rychlostí simulace ("Rychlost: 1x" / "Rychlost: PAUZA" atd.), viz `setGameSpeed`. */
  private gameSpeedText!: Phaser.GameObjects.Text;
  /** Násobič simulačního kroku: 0 = pauza, 1/2/3 = normální/2x/3x. Ovládáno klávesnicí, viz `setGameSpeed`. */
  private timeMultiplier = 1;

  constructor() {
    super('TrackGraphScene');
  }

  init(data: TrackGraphSceneData): void {
    this.levelKey = data?.levelKey ?? DEFAULT_LEVEL_KEY;
    this.levelEnding = false; // scéna se recykluje při "Hrát znovu" — nový běh nesmí zdědit starý stav
    this.elapsedSec = 0;
    this.lastRenderedTimeSec = -1;
    this.timeMultiplier = 1; // "Hrát znovu" po pauze/2x/3x musí nastartovat čistě na 1x, ne zdědit starý stav
  }

  preload(): void {
    // Level JSON může být v `cache.json` už z předchozího hraní STEJNÉHO levelu ("Hrát
    // znovu") — za běhu se ale přímo MUTUJE (výhybky/semafory v `toggleSwitch`/`releaseSignal`/
    // `TrainManager`), takže bychom bez vynuceného refetche dostali rozehraný/zastaralý stav
    // místo čistého restartu od autorských hodnot z JSON souboru. `this.load.json()` sám o
    // sobě existující klíč v cache tiše přeskočí (nenačte znovu) — proto ho napřed odstraníme.
    if (this.cache.json.has(this.levelKey)) {
      this.cache.json.remove(this.levelKey);
    }
    this.load.json(this.levelKey, `levels/${this.levelKey}.json`);
  }

  create(): void {
    this.level = this.cache.json.get(this.levelKey) as LevelDefinition;
    this.graphIndex = new TrackGraphIndex(this.level.trackGraph);

    this.cameras.main.setBackgroundColor(BACKGROUND_COLOR);

    this.add.text(16, 12, `${this.level.name} — obtížnost: ${this.level.difficulty}`, {
      color: COLORS.text,
      fontSize: '18px',
      fontFamily: 'monospace',
      fontStyle: 'bold',
    });
    this.scoreText = this.add
      .text(16, 40, `Skóre: ${this.lastRenderedScore}`, {
        color: COLORS.text,
        fontSize: '16px',
        fontFamily: 'monospace',
      })
      .setDepth(20);
    this.timeText = this.add
      .text(16, 64, `Čas: ${this.level.timeLimitSec}s`, {
        color: COLORS.text,
        fontSize: '16px',
        fontFamily: 'monospace',
      })
      .setDepth(20);
    this.gameSpeedText = this.add
      .text(16, 88, 'Rychlost: 1x', {
        color: COLORS.speedNormal,
        fontSize: '16px',
        fontFamily: 'monospace',
      })
      .setDepth(20);
    this.add
      .text(16, 112, '[Mezerník] pauza  [1] [2] [3] rychlost', {
        color: COLORS.textMuted,
        fontSize: '11px',
        fontFamily: 'monospace',
      })
      .setDepth(20);

    // Ovládání času: SPACE přepíná pauzu (0x <-> naposledy nastavená rychlost),
    // 1/2/3 nastavují přímo danou rychlost. Dává hráči prostor zareagovat na
    // vyšší základní rychlost vlaků (viz `TrainManager.BASE_SPEED_UNITS_PER_SEC`).
    this.input.keyboard!.on('keydown-SPACE', () => this.setGameSpeed(this.timeMultiplier === 0 ? 1 : 0));
    this.input.keyboard!.on('keydown-ONE', () => this.setGameSpeed(1));
    this.input.keyboard!.on('keydown-TWO', () => this.setGameSpeed(2));
    this.input.keyboard!.on('keydown-THREE', () => this.setGameSpeed(3));

    this.gameOverText = this.add
      .text(400, 240, '', {
        color: '#ffffff',
        fontSize: '22px',
        fontFamily: 'monospace',
        align: 'center',
        backgroundColor: '#7f1d1d',
        padding: { x: 18, y: 12 },
      })
      .setOrigin(0.5, 0.5)
      .setDepth(50)
      .setVisible(false);

    this.segmentsGraphics = this.add.graphics();
    this.redrawSegments();

    this.switchesGraphics = this.add.graphics();
    this.signalsGraphics = this.add.graphics();
    this.drawNodes(this.level.trackGraph.nodes);
    this.redrawSwitches();
    this.redrawSignals();

    this.trainManager = new TrainManager(this, this.graphIndex, this.level.trains);
    this.eventManager = new EventManager(this.graphIndex, this.level.events ?? []);
  }

  update(_time: number, delta: number): void {
    if (this.levelEnding) {
      // Přechod na LevelEndScene je už naplánovaný (viz `scheduleLevelEnd`) — nic dalšího
      // se nepočítá ani nepřekresluje (u prohry je to navíc žádoucí "zamrznutí" scény
      // na 2s, ať hráč v klidu vidí havárii, než se scéna přepne).
      return;
    }

    const deltaSec = delta / 1000;
    const simDelta = deltaSec * this.timeMultiplier;
    this.elapsedSec += simDelta;
    this.eventManager.update(simDelta);
    this.trainManager.update(deltaSec, this.timeMultiplier);
    this.redrawSignals();
    this.updateErrorOverlays();

    const score = this.trainManager.getScore();
    if (score !== this.lastRenderedScore) {
      this.lastRenderedScore = score;
      this.scoreText.setText(`Skóre: ${score}`);
    }

    const remainingSec = Math.max(0, this.level.timeLimitSec - this.elapsedSec);
    const remainingRounded = Math.ceil(remainingSec);
    if (remainingRounded !== this.lastRenderedTimeSec) {
      this.lastRenderedTimeSec = remainingRounded;
      this.timeText.setText(`Čas: ${remainingRounded}s`);
    }

    const gameOverMessage = this.trainManager.getGameOverMessage();
    if (gameOverMessage) {
      // Kolize je vždy okamžitá prohra bez ohledu na skóre — neprochází přes
      // `evaluateLevelEnd`/`targetScore`, jen přes nepodmíněný 2s zpožděný přechod.
      if (!this.gameOverText.visible) {
        this.gameOverText.setText(gameOverMessage).setVisible(true);
      }
      this.scheduleLevelEnd(false, gameOverMessage, DEFEAT_TRANSITION_DELAY_MS);
      return;
    }

    if (remainingSec <= 0) {
      this.evaluateLevelEnd(score, 'Čas vypršel.');
      return;
    }

    if (this.trainManager.isLevelComplete()) {
      this.evaluateLevelEnd(score, 'Všechny vlaky úspěšně vyřízeny do cíle.');
    }
  }

  /**
   * Vyhodnotí konec levelu při dosažení jedné ze dvou NEHAVARIJNÍCH koncových
   * podmínek (vypršení času, nebo vyřízení všech vlaků) — na rozdíl od
   * `GAME_OVER_COLLISION` (vždy prohra) tady o výhře/prohře rozhoduje výhradně
   * `score >= this.level.targetScore` z JSONu levelu, ne to, KTERÁ podmínka nastala.
   */
  private evaluateLevelEnd(score: number, situation: string): void {
    const targetScore = this.level.targetScore;
    const victory = score >= targetScore;
    const reason = victory
      ? `${situation} Cílové skóre ${targetScore} dosaženo (skóre ${score}).`
      : `${situation} Cílové skóre ${targetScore} nebylo dosaženo (skóre ${score}).`;
    this.scheduleLevelEnd(victory, reason, 0);
  }

  /**
   * Naplánuje přechod na `LevelEndScene` po `delayMs` (0 = prakticky okamžitě, jen
   * odloženo na příští tick). `levelEnding` se nastaví HNED, takže i kdyby `update()`
   * mezitím proběhl znovu (defeat: `delayMs > 0`), `scheduleLevelEnd` se nezavolá podruhé.
   */
  private scheduleLevelEnd(victory: boolean, reason: string, delayMs: number): void {
    this.levelEnding = true;
    this.time.delayedCall(delayMs, () => {
      const data: LevelEndSceneData = {
        victory,
        score: this.trainManager.getScore(),
        reason,
        levelKey: this.levelKey,
      };
      this.scene.start('LevelEndScene', data);
    });
  }

  /**
   * Nastaví násobič rychlosti simulace (0 = pauza, 1/2/3 = normální/2x/3x) a
   * aktualizuje `gameSpeedText`. Ignorováno po `scheduleLevelEnd` — level, který
   * už končí, se nesmí dát znovu "rozpauzovat" doběhnuvší `delayedCall` přechodem.
   */
  private setGameSpeed(speed: number): void {
    if (this.levelEnding) {
      return;
    }
    this.timeMultiplier = speed;
    if (speed === 0) {
      this.gameSpeedText.setText('Rychlost: PAUZA');
      this.gameSpeedText.setColor(COLORS.speedPaused);
    } else {
      this.gameSpeedText.setText(`Rychlost: ${speed}x`);
      this.gameSpeedText.setColor(COLORS.speedNormal);
    }
  }

  // ---- Segmenty ---------------------------------------------------------

  /** Vykreslí jednu polylinii segmentu (curve body) do `g` — sdíleno mezi glow a jádrovým průchodem v `redrawSegments`. */
  private strokeSegmentPath(g: Phaser.GameObjects.Graphics, curve: TrackSegment['curve']): void {
    const [start, ...rest] = curve;
    g.beginPath();
    g.moveTo(start[0], start[1]);
    for (const point of rest) {
      g.lineTo(point[0], point[1]);
    }
    g.strokePath();
  }

  /**
   * Překreslí všechny segmenty. Neaktivní: tence a poloprůhledně (`trackInactive`,
   * šířka 3, alfa 0.45). Aktivní (celá aktuálně průjezdná trasa): "svítivě" —
   * širší poloprůhledná "glow" čára (šířka 14, alfa 0.25) POD ostrým jádrem
   * (šířka 6, plná barva) — jednoduchý trik bez shaderů/postFX pipeline
   * (viz [DESIGN: Neon Dispatch Rewrite]).
   */
  private redrawSegments(): void {
    const g = this.segmentsGraphics;
    g.clear();
    const reachable = this.graphIndex.computeReachableSegments();
    for (const segment of this.level.trackGraph.segments) {
      const active = reachable.has(segment.id);
      if (active) {
        g.lineStyle(14, COLORS.trackActive, 0.25);
        this.strokeSegmentPath(g, segment.curve);
        g.lineStyle(6, COLORS.trackActive, 1);
        this.strokeSegmentPath(g, segment.curve);
      } else {
        g.lineStyle(3, COLORS.trackInactive, 0.45);
        this.strokeSegmentPath(g, segment.curve);
      }
    }
  }

  // ---- Semafory -----------------------------------------------------------

  /**
   * Překreslí všechny semafory podle živého `state` — fyzický "panel": tmavě
   * šedý zaoblený obdélník (sloupek/skříňka), uvnitř svítící kruhové světlo
   * (červená/zelená) s jemnou "halo" glow vrstvou pod sebou.
   */
  private redrawSignals(): void {
    const g = this.signalsGraphics;
    g.clear();
    const half = SIGNAL_PANEL_SIZE / 2;
    for (const node of this.level.trackGraph.nodes) {
      if (!isSignalNode(node)) continue;

      g.fillStyle(COLORS.signalPanel, 1);
      g.fillRoundedRect(node.x - half, node.y - half, SIGNAL_PANEL_SIZE, SIGNAL_PANEL_SIZE, 6);
      g.lineStyle(2, COLORS.signalPanelStroke, 1);
      g.strokeRoundedRect(node.x - half, node.y - half, SIGNAL_PANEL_SIZE, SIGNAL_PANEL_SIZE, 6);

      const color = node.state === 'GREEN' ? COLORS.signalGreen : COLORS.signalRed;
      // Halo (glow) pod ostrým světlem — stejný trik jako u aktivní trati.
      g.fillStyle(color, 0.3);
      g.fillCircle(node.x, node.y, SIGNAL_LIGHT_RADIUS + 4);
      g.fillStyle(color, 1);
      g.fillCircle(node.x, node.y, SIGNAL_LIGHT_RADIUS);
    }
  }

  // ---- Uzly ---------------------------------------------------------------

  private drawNodes(nodes: TrackNode[]): void {
    for (const node of nodes) {
      if (isStationNode(node)) {
        this.drawStation(node);
      } else if (isSwitchNode(node)) {
        this.drawSwitch(node);
      } else if (isSignalNode(node)) {
        this.drawSignal(node);
      }
    }
  }

  private drawStation(node: Extract<TrackNode, { type: 'station' }>): void {
    const g = this.add.graphics();
    g.fillStyle(COLORS.stationFill, 1);
    g.fillRoundedRect(node.x - 24, node.y - 16, 48, 32, 8);
    g.lineStyle(2, COLORS.ink, 1);
    g.strokeRoundedRect(node.x - 24, node.y - 16, 48, 32, 8);
    this.add
      .text(node.x, node.y + 24, node.name, {
        color: COLORS.text,
        fontSize: '12px',
        fontFamily: 'monospace',
        fontStyle: 'bold',
        align: 'center',
      })
      .setOrigin(0.5, 0);
    this.add
      .text(node.x, node.y + 40, `${node.tracks} koleje`, {
        color: COLORS.textMuted,
        fontSize: '10px',
        fontFamily: 'monospace',
        align: 'center',
      })
      .setOrigin(0.5, 0);
  }

  /**
   * Statická část výhybky — jen popisek (POD uzlem, kvůli hustým layoutům jako
   * lvl_04) a klikací zóna. Samotný tvar (socket + indikační čára) kreslí
   * `redrawSwitches()`, protože se musí překreslit při KAŽDÉM přepnutí větve
   * (viz `toggleSwitch`), ne jen jednou při vytvoření scény.
   */
  private drawSwitch(node: Extract<TrackNode, { type: 'switch' }>): void {
    this.add
      .text(node.x, node.y + SWITCH_RADIUS + 6, node.id, {
        color: COLORS.textMuted,
        fontSize: '10px',
        fontFamily: 'monospace',
      })
      .setOrigin(0.5, 0);
    this.createErrorOverlay(node.id, node.x, node.y, SWITCH_RADIUS + 22);

    // Klikací zóna musí pokrýt i indikační čáru, ne jen centrální kruh — hráč
    // by jinak musel mířit přesně na malý socket uprostřed.
    const hitSize = (SWITCH_RADIUS + SWITCH_INDICATOR_LENGTH) * 2;
    this.add
      .zone(node.x, node.y, hitSize, hitSize)
      .setInteractive({ useHandCursor: true })
      .on('pointerdown', () => this.toggleSwitch(node));
  }

  /**
   * Překreslí VŠECHNY výhybky: kruhový "socket" (tmavě šedý, světlý obrys) a od
   * jeho středu tlustou indikační čáru (`switchAccent`, žlutá) mířící do
   * SKUTEČNÉHO směru aktuálně vybrané větve (`node.current`) — směr se počítá
   * ze skutečných souřadnic křivky segmentu (`getSwitchBranchDirection`), ne
   * z pevného úhlu, takže funguje pro libovolně natočenou výhybku v datech
   * levelu. Volá se z `create()` i z `toggleSwitch()` (žádné auto-update v
   * `update()` — na rozdíl od semaforů se výhybka mění jen na klik hráče).
   */
  private redrawSwitches(): void {
    const g = this.switchesGraphics;
    g.clear();
    for (const node of this.level.trackGraph.nodes) {
      if (!isSwitchNode(node)) continue;

      g.fillStyle(COLORS.switchFill, 1);
      g.fillCircle(node.x, node.y, SWITCH_RADIUS);
      g.lineStyle(2, COLORS.switchStroke, 1);
      g.strokeCircle(node.x, node.y, SWITCH_RADIUS);

      const dir = this.getSwitchBranchDirection(node.current);
      if (dir) {
        const endX = node.x + dir.x * SWITCH_INDICATOR_LENGTH;
        const endY = node.y + dir.y * SWITCH_INDICATOR_LENGTH;
        g.lineStyle(4, COLORS.switchAccent, 1);
        g.beginPath();
        g.moveTo(node.x, node.y);
        g.lineTo(endX, endY);
        g.strokePath();
        // Tečka na konci = jednoduchý "hrot", bez nutnosti kreslit trojúhelníkovou šipku.
        g.fillStyle(COLORS.switchAccent, 1);
        g.fillCircle(endX, endY, 3);
      }
    }
  }

  /** Jednotkový směrový vektor od výhybky k prvnímu bodu křivky dané větve (segmentu), nebo `null`. */
  private getSwitchBranchDirection(branchSegmentId: string): Phaser.Math.Vector2 | null {
    const segment = this.graphIndex.getSegment(branchSegmentId);
    if (!segment || segment.curve.length < 2) return null;
    const [p0, p1] = segment.curve;
    const dx = p1[0] - p0[0];
    const dy = p1[1] - p0[1];
    const length = Math.hypot(dx, dy);
    if (length === 0) return null;
    return new Phaser.Math.Vector2(dx / length, dy / length);
  }

  private toggleSwitch(node: Extract<TrackNode, { type: 'switch' }>): void {
    if (this.eventManager.isSwitchLocked(node.id)) {
      // Porucha výhybky: hráč nad ní po dobu poruchy ztrácí kontrolu, klik se ignoruje.
      return;
    }

    const currentIndex = node.branches.indexOf(node.current);
    const nextIndex = (currentIndex + 1) % node.branches.length;
    node.current = node.branches[nextIndex];

    // Indikační čára MUSÍ viditelně přeskočit na nový cíl při každém přepnutí,
    // stejně jako zvýraznění trati.
    this.redrawSwitches();
    this.redrawSegments();
  }

  private drawSignal(node: Extract<TrackNode, { type: 'signal' }>): void {
    // Panel + světlo semaforu se kreslí (a překresluje) v `redrawSignals()` — tady jen
    // popisek POD uzlem a ZVĚTŠENÁ klikací zóna (hráčská zpětná vazba: "titěrné").
    this.add
      .text(node.x, node.y + SIGNAL_PANEL_SIZE / 2 + 6, node.id, {
        color: COLORS.textMuted,
        fontSize: '10px',
        fontFamily: 'monospace',
      })
      .setOrigin(0.5, 0);
    this.createErrorOverlay(node.id, node.x, node.y, SIGNAL_PANEL_SIZE / 2 + 18);

    const hitSize = SIGNAL_PANEL_SIZE + 12;
    this.add
      .zone(node.x, node.y, hitSize, hitSize)
      .setInteractive({ useHandCursor: true })
      .on('pointerdown', () => this.releaseSignal(node));
  }

  /** Ruční uvolnění bloku hráčem — vždy nastaví GREEN (do RED se semafor vrací jen skrz TrainManager). */
  private releaseSignal(node: Extract<TrackNode, { type: 'signal' }>): void {
    if (this.eventManager.isSignalLocked(node.id)) {
      // Porucha semaforu: hráč nad ním po dobu poruchy ztrácí kontrolu, klik se ignoruje.
      return;
    }
    node.state = 'GREEN';
  }

  // ---- Poruchy (events) ----------------------------------------------------

  /** Vytvoří skrytý blikající "ERR!" popisek nad uzlem — zapíná/vypíná ho `updateErrorOverlays`. */
  private createErrorOverlay(nodeId: string, x: number, y: number, offsetAboveY: number): void {
    const overlay = this.add
      .text(x, y - offsetAboveY, 'ERR!', {
        color: COLORS.malfunction,
        fontSize: '12px',
        fontFamily: 'monospace',
        fontStyle: 'bold',
      })
      .setOrigin(0.5, 1)
      .setDepth(30)
      .setVisible(false);
    this.errorOverlays.set(nodeId, overlay);
  }

  /** Volá se každý snímek z `update()` — zobrazí/skryje a rozbliká "ERR!" nad právě poruchovými uzly. */
  private updateErrorOverlays(): void {
    // Blikání beze stavu na instanci: jednoduchý časový modulo (fází ~250 ms).
    const blinkOn = Math.floor(this.time.now / 250) % 2 === 0;
    for (const [nodeId, overlay] of this.errorOverlays) {
      const malfunctioning = this.eventManager.isMalfunctioning(nodeId);
      overlay.setVisible(malfunctioning && blinkOn);
    }
  }
}
