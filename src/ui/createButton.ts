import Phaser from 'phaser';

/** Rozměry a barvy sdíleného schematického tlačítka (MainMenuScene, LevelEndScene). */
const BUTTON_WIDTH = 220;
const BUTTON_HEIGHT = 46;
const BUTTON_COLOR = 0x2d3748;
const BUTTON_HOVER_COLOR = 0x4a5568;
const BUTTON_TEXT_COLOR = '#e2e8f0';

/**
 * Vykreslí jednoduché schematické tlačítko (obdélník + text, hover zvýrazní) na dané
 * pozici a napojí `onClick` na klik/tap. Čistě `Phaser.GameObjects.Rectangle`/`Text` —
 * žádné textury, konzistentní se zbytkem vektorového UI.
 */
export function createButton(scene: Phaser.Scene, x: number, y: number, label: string, onClick: () => void): void {
  const bg = scene.add.rectangle(x, y, BUTTON_WIDTH, BUTTON_HEIGHT, BUTTON_COLOR).setStrokeStyle(2, 0xe2e8f0, 1);
  const text = scene.add
    .text(x, y, label, { color: BUTTON_TEXT_COLOR, fontSize: '18px', fontFamily: 'monospace' })
    .setOrigin(0.5, 0.5);

  bg.setInteractive({ useHandCursor: true })
    .on('pointerover', () => bg.setFillStyle(BUTTON_HOVER_COLOR, 1))
    .on('pointerout', () => bg.setFillStyle(BUTTON_COLOR, 1))
    .on('pointerdown', onClick);

  // Text leží nad Rectangle (pozdější `add.text` = vyšší z-order ve stejné scéně) —
  // vlastní interaktivní zóna na textu zajistí klik i když kurzor míří přesně na písmena.
  text.setInteractive({ useHandCursor: true }).on('pointerdown', onClick);
}
