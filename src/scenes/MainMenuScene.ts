import Phaser from 'phaser';
import { createButton } from '../ui/createButton';
import type { TrackGraphSceneData } from './TrackGraphScene';

/** Jedna položka výběru levelu v hlavním menu. */
interface LevelMenuEntry {
  levelKey: string;
  label: string;
}

/**
 * Dostupné levely k výběru v menu, v pořadí zobrazení. `levelKey` musí odpovídat
 * názvu souboru v `public/levels/<levelKey>.json` (bez přípony) — `TrackGraphScene`
 * ho použije jako cache klíč i jako cestu k `this.load.json`.
 */
const LEVEL_MENU_ENTRIES: LevelMenuEntry[] = [
  { levelKey: 'lvl_03_junction_hub', label: 'Level 3: Junction Hub' },
  { levelKey: 'lvl_04_bottleneck', label: 'Level 4: Bottleneck' },
  { levelKey: 'lvl_05_terminal_chaos', label: 'Level 5: Terminal Chaos' },
];

const BACKGROUND_COLOR = 0x1a202c;

/** Svislý rozestup mezi tlačítky výběru levelu a Y souřadnice prvního tlačítka. */
const BUTTON_SPACING = 58;
const FIRST_BUTTON_Y = 260;

/** Hlavní menu — název hry + seznam tlačítek pro výběr levelu, každé spustí `TrackGraphScene` s vlastním `levelKey`. */
export class MainMenuScene extends Phaser.Scene {
  constructor() {
    super('MainMenuScene');
  }

  create(): void {
    this.cameras.main.setBackgroundColor(BACKGROUND_COLOR);

    this.add
      .text(400, 110, 'TrainSim', {
        color: '#e2e8f0',
        fontSize: '48px',
        fontFamily: 'monospace',
        fontStyle: 'bold',
      })
      .setOrigin(0.5, 0.5);

    this.add
      .text(400, 160, 'Dispečerská simulace železnice', {
        color: '#a0aec0',
        fontSize: '15px',
        fontFamily: 'monospace',
      })
      .setOrigin(0.5, 0.5);

    this.add
      .text(400, 200, 'Vyber úroveň:', {
        color: '#a0aec0',
        fontSize: '14px',
        fontFamily: 'monospace',
      })
      .setOrigin(0.5, 0.5);

    LEVEL_MENU_ENTRIES.forEach((entry, index) => {
      const y = FIRST_BUTTON_Y + index * BUTTON_SPACING;
      createButton(this, 400, y, entry.label, () => {
        const data: TrackGraphSceneData = { levelKey: entry.levelKey };
        this.scene.start('TrackGraphScene', data);
      });
    });
  }
}
