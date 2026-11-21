import royalImg from './assets/boxes/royal_nourish_box.jpg';
import chapatiImg from './assets/boxes/chapati_nourish_box.jpg';
import riceImg from './assets/boxes/rice_nourish_box.jpg';

// Photos keyed by box label; any other box shows a placeholder.
const BOX_IMAGES = {
  'Royal Nourish Box': royalImg,
  'Chapati Nourish Box': chapatiImg,
  'Rice Nourish Box': riceImg
};

export function boxImage(label) {
  return BOX_IMAGES[label] || null;
}
