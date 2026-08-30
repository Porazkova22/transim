import Phaser from 'phaser';
import { MainMenuScene } from './scenes/MainMenuScene';
import { TrackGraphScene } from './scenes/TrackGraphScene';
import { LevelEndScene } from './scenes/LevelEndScene';

new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'app',
  width: 800,
  height: 480,
  backgroundColor: '#f1e9d8',
  // FIT škáluje plátno (při zachování poměru stran 800:480) na celou dostupnou
  // plochu #app v index.html — hra už nesedí jako malá krabička uprostřed
  // velkého monitoru. BEZE ZMĚNY logických 800x480 souřadnic, takže žádný level
  // JSON ani kreslicí kód (uzly/segmenty/labely) se tímhle nemusí přepočítávat.
  //
  // POZN.: Phaser 3.90 zrušil dřívější top-level `resolution` konfiguraci (v této
  // verzi neexistuje — `tsc` to správně odmítl jako neznámou property), takže se
  // zde nepoužívá. Plátno se renderuje na 800x480 fyzických pixelů a CSS ho
  // roztáhne na dostupnou plochu; na displejích s vysokým DPR to znamená mírné
  // rozostření tenkých čar/textu při větším zvětšení. Skutečné retina-ostré
  // vykreslování by vyžadovalo zdvojnásobit interní rozlišení (šířku/výšku i
  // všechny kreslicí konstanty), což je mimo rozsah této úpravy.
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
    width: 800,
    height: 480,
  },
  // Phaser spouští VŽDY první scénu v poli — hra tedy startuje v MainMenuScene.
  scene: [MainMenuScene, TrackGraphScene, LevelEndScene],
});
