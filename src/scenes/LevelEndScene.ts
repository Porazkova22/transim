import Phaser from 'phaser';
import { createButton } from '../ui/createButton';
import type { TrackGraphSceneData } from './TrackGraphScene';

/** Data předávaná do `LevelEndScene` přes `this.scene.start('LevelEndScene', data)`. */
export interface LevelEndSceneData {
  /** `true` = level splněn (všechny vlaky vyřízeny), `false` = GAME_OVER (kolize). */
  victory: boolean;
  /** Finální skóre v okamžiku ukončení levelu. */
  score: number;
  /** Lidsky čitelný důvod konce — hláška z `TrainManager.getGameOverMessage()`, nebo výherní text. */
  reason: string;
  /** ID levelu, který právě skončil — potřeba pro "Hrát znovu". */
  levelKey: string;
}

const BACKGROUND_COLOR = 0x1a202c;
const VICTORY_COLOR = '#68d391';
const DEFEAT_COLOR = '#fc8181';

/**
 * Obrazovka výsledků po dohrání levelu (výhra i prohra). Přijímá `LevelEndSceneData`
 * přes `init()` (Phaser scene-data pattern) a nabízí "Hrát znovu" (restart STEJNÉHO
 * levelu) a "Zpět do menu".
 */
export class LevelEndScene extends Phaser.Scene {
  private levelEndData!: LevelEndSceneData;

  constructor() {
    super('LevelEndScene');
  }

  init(data: LevelEndSceneData): void {
    this.levelEndData = data;
  }

  create(): void {
    this.cameras.main.setBackgroundColor(BACKGROUND_COLOR);

    const headline = this.levelEndData.victory ? 'VÝHRA' : 'PROHRA';
    const headlineColor = this.levelEndData.victory ? VICTORY_COLOR : DEFEAT_COLOR;

    this.add
      .text(400, 120, headline, {
        color: headlineColor,
        fontSize: '40px',
        fontFamily: 'monospace',
        fontStyle: 'bold',
      })
      .setOrigin(0.5, 0.5);

    this.add
      .text(400, 175, this.levelEndData.reason, {
        color: '#e2e8f0',
        fontSize: '13px',
        fontFamily: 'monospace',
        align: 'center',
        wordWrap: { width: 620 },
      })
      .setOrigin(0.5, 0.5);

    this.add
      .text(400, 225, `Finální skóre: ${this.levelEndData.score}`, {
        color: '#e2e8f0',
        fontSize: '20px',
        fontFamily: 'monospace',
      })
      .setOrigin(0.5, 0.5);

    createButton(this, 400, 305, 'Hrát znovu', () => {
      const restartData: TrackGraphSceneData = { levelKey: this.levelEndData.levelKey };
      this.scene.start('TrackGraphScene', restartData);
    });

    createButton(this, 400, 365, 'Zpět do menu', () => {
      this.scene.start('MainMenuScene');
    });
  }
}
