import Phaser from 'phaser';
import { MainMenuScene } from './scenes/MainMenuScene';
import { TrackGraphScene } from './scenes/TrackGraphScene';
import { LevelEndScene } from './scenes/LevelEndScene';

new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'app',
  width: 800,
  height: 480,
  backgroundColor: '#0e1420',
  // Phaser spouští VŽDY první scénu v poli — hra tedy startuje v MainMenuScene.
  scene: [MainMenuScene, TrackGraphScene, LevelEndScene],
});
