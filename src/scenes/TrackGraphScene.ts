import Phaser from 'phaser';
import type { LevelDefinition, TrackNode } from '../types/level';
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

/** Jednotné tmavé pozadí scény — čistý schematický styl (Mini Metro / Rail Route), žádné fotorealistické assety. */
const BACKGROUND_COLOR = 0x1a202c;

const COLORS = {
  trackActive: 0xe2e8f0,
  trackInactive: 0x2d3748,
  station: 0x38a169,
  switchNode: 0xd69e2e,
  signalRed: 0xe53e3e,
  signalGreen: 0x38a169,
  malfunction: '#f6e05e',
  text: '#e2e8f0',
} as const;

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
 * externí obrázkové/video assety, kvůli čitelnosti a jednotnému stylu.
 */
export class TrackGraphScene extends Phaser.Scene {
  private level!: LevelDefinition;
  private graphIndex!: TrackGraphIndex;
  private trainManager!: TrainManager;
  private eventManager!: EventManager;
  private segmentsGraphics!: Phaser.GameObjects.Graphics;
  private signalsGraphics!: Phaser.GameObjects.Graphics;
  private scoreText!: Phaser.GameObjects.Text;
  private gameOverText!: Phaser.GameObjects.Text;
  private lastRenderedScore = 0;
  private readonly switchLabels = new Map<string, Phaser.GameObjects.Text>();
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

  constructor() {
    super('TrackGraphScene');
  }

  init(data: TrackGraphSceneData): void {
    this.levelKey = data?.levelKey ?? DEFAULT_LEVEL_KEY;
    this.levelEnding = false; // scéna se recykluje při "Hrát znovu" — nový běh nesmí zdědit starý stav
    this.elapsedSec = 0;
    this.lastRenderedTimeSec = -1;
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

    this.signalsGraphics = this.add.graphics();
    this.drawNodes(this.level.trackGraph.nodes);
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
    this.elapsedSec += deltaSec;
    this.eventManager.update(deltaSec);
    this.trainManager.update(deltaSec);
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

  // ---- Segmenty ---------------------------------------------------------

  /** Překreslí všechny segmenty; celá aktuálně průjezdná trasa silněji a světleji, zbytek ztlumeně. */
  private redrawSegments(): void {
    const g = this.segmentsGraphics;
    g.clear();
    const reachable = this.graphIndex.computeReachableSegments();
    for (const segment of this.level.trackGraph.segments) {
      const active = reachable.has(segment.id);
      g.lineStyle(active ? 5 : 3, active ? COLORS.trackActive : COLORS.trackInactive, active ? 1 : 0.6);
      g.beginPath();
      const [start, ...rest] = segment.curve;
      g.moveTo(start[0], start[1]);
      for (const point of rest) {
        g.lineTo(point[0], point[1]);
      }
      g.strokePath();
    }
  }

  // ---- Semafory -----------------------------------------------------------

  /** Překreslí barvu všech semaforů podle živého `state` (TrainManager ho mění při průjezdu vlaku). */
  private redrawSignals(): void {
    const g = this.signalsGraphics;
    g.clear();
    for (const node of this.level.trackGraph.nodes) {
      if (!isSignalNode(node)) continue;
      const color = node.state === 'GREEN' ? COLORS.signalGreen : COLORS.signalRed;
      g.fillStyle(color, 1);
      g.fillCircle(node.x, node.y, 8);
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
    g.fillStyle(COLORS.station, 1);
    g.fillRoundedRect(node.x - 24, node.y - 16, 48, 32, 6);
    this.add
      .text(node.x, node.y + 26, `${node.name}\n(${node.tracks} koleje)`, {
        color: COLORS.text,
        fontSize: '12px',
        fontFamily: 'monospace',
        align: 'center',
      })
      .setOrigin(0.5, 0);
  }

  private drawSwitch(node: Extract<TrackNode, { type: 'switch' }>): void {
    const size = 10;
    const g = this.add.graphics();
    g.fillStyle(COLORS.switchNode, 1);
    g.fillPoints(
      [
        new Phaser.Math.Vector2(node.x, node.y - size),
        new Phaser.Math.Vector2(node.x + size, node.y),
        new Phaser.Math.Vector2(node.x, node.y + size),
        new Phaser.Math.Vector2(node.x - size, node.y),
      ],
      true,
    );

    const label = this.add
      .text(node.x, node.y - 22, `${node.id}\n[${node.current}]`, {
        color: COLORS.text,
        fontSize: '10px',
        fontFamily: 'monospace',
        align: 'center',
      })
      .setOrigin(0.5, 1);
    this.switchLabels.set(node.id, label);
    // Výhybka má dvouřádkový popisek nad sebou (id + aktuální větev) — overlay posazen výš, aby se s ním nepřekrýval.
    this.createErrorOverlay(node.id, node.x, node.y, 48);

    // Graphics objekty nemají přesný hit-test na vykreslený tvar — neviditelná Zone
    // přes celou výhybku dává spolehlivý klikací obdélník (pointerdown).
    const hitSize = size * 2.4;
    this.add
      .zone(node.x, node.y, hitSize, hitSize)
      .setInteractive({ useHandCursor: true })
      .on('pointerdown', () => this.toggleSwitch(node));
  }

  private toggleSwitch(node: Extract<TrackNode, { type: 'switch' }>): void {
    if (this.eventManager.isSwitchLocked(node.id)) {
      // Porucha výhybky: hráč nad ní po dobu poruchy ztrácí kontrolu, klik se ignoruje.
      return;
    }

    const currentIndex = node.branches.indexOf(node.current);
    const nextIndex = (currentIndex + 1) % node.branches.length;
    node.current = node.branches[nextIndex];

    this.switchLabels.get(node.id)?.setText(`${node.id}\n[${node.current}]`);
    this.redrawSegments();
  }

  private drawSignal(node: Extract<TrackNode, { type: 'signal' }>): void {
    // Kruh semaforu se kreslí (a překresluje) v `redrawSignals()` — tady jen popisek a klikací zóna.
    this.add
      .text(node.x, node.y - 18, node.id, {
        color: COLORS.text,
        fontSize: '10px',
        fontFamily: 'monospace',
      })
      .setOrigin(0.5, 1);
    this.createErrorOverlay(node.id, node.x, node.y, 32);

    const hitSize = 24;
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
