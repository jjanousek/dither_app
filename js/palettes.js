// Palette presets. Colors are hex strings; convert once with paletteToFloat().

export const PALETTES = [
  { id: 'bw',            name: '1-Bit Black & White', colors: ['#000000', '#ffffff'] },
  { id: 'wb',            name: '1-Bit Inverted',      colors: ['#ffffff', '#000000'] },
  { id: 'gray4',         name: 'Grayscale 4',         colors: ['#000000', '#555555', '#aaaaaa', '#ffffff'] },
  { id: 'gray8',         name: 'Grayscale 8',         colors: ['#000000', '#242424', '#494949', '#6d6d6d', '#929292', '#b6b6b6', '#dbdbdb', '#ffffff'] },
  { id: 'gray16',        name: 'Grayscale 16',        colors: ['#000000', '#111111', '#222222', '#333333', '#444444', '#555555', '#666666', '#777777', '#888888', '#999999', '#aaaaaa', '#bbbbbb', '#cccccc', '#dddddd', '#eeeeee', '#ffffff'] },
  { id: 'gameboy',       name: 'Game Boy (DMG)',      colors: ['#0f380f', '#306230', '#8bac0f', '#9bbc0f'] },
  { id: 'gbpocket',      name: 'Game Boy Pocket',     colors: ['#181818', '#4a5138', '#8c926b', '#c5caa4'] },
  { id: 'gblight',       name: 'Game Boy Light',      colors: ['#004f3b', '#00694a', '#009a70', '#00b582'] },
  { id: 'amber',         name: 'Amber Terminal',      colors: ['#1a0f00', '#ffb000'] },
  { id: 'green',         name: 'Green Phosphor',      colors: ['#001500', '#33ff33'] },
  { id: 'blueterm',      name: 'Blue Terminal',       colors: ['#00114f', '#8bd0ff'] },
  { id: 'paperwhite',    name: 'E-Ink Paper',         colors: ['#e7e3d5', '#3a3a38'] },
  { id: 'macintosh',     name: 'Macintosh',           colors: ['#333319', '#e5ffff'] },
  { id: 'cga1',          name: 'CGA Palette 1',       colors: ['#000000', '#55ffff', '#ff55ff', '#ffffff'] },
  { id: 'cga2',          name: 'CGA Palette 2',       colors: ['#000000', '#55ff55', '#ff5555', '#ffff55'] },
  { id: 'cga16',         name: 'CGA 16',              colors: ['#000000', '#0000aa', '#00aa00', '#00aaaa', '#aa0000', '#aa00aa', '#aa5500', '#aaaaaa', '#555555', '#5555ff', '#55ff55', '#55ffff', '#ff5555', '#ff55ff', '#ffff55', '#ffffff'] },
  { id: 'ega',           name: 'EGA 16',              colors: ['#000000', '#0000aa', '#00aa00', '#00aaaa', '#aa0000', '#aa00aa', '#aaaa00', '#aaaaaa', '#555555', '#5555ff', '#55ff55', '#55ffff', '#ff5555', '#ff55ff', '#ffff55', '#ffffff'] },
  { id: 'c64',           name: 'Commodore 64',        colors: ['#000000', '#626262', '#898989', '#adadad', '#ffffff', '#9f4e44', '#cb7e75', '#6d5412', '#a1683c', '#c9d487', '#9ae29b', '#5cab5e', '#6abfc6', '#887ecb', '#50459b', '#a057a3'] },
  { id: 'zx',            name: 'ZX Spectrum',         colors: ['#000000', '#0000d7', '#d70000', '#d700d7', '#00d700', '#00d7d7', '#d7d700', '#d7d7d7', '#0000ff', '#ff0000', '#ff00ff', '#00ff00', '#00ffff', '#ffff00', '#ffffff'] },
  { id: 'nes',           name: 'NES',                 colors: ['#000000', '#fcfcfc', '#f8f8f8', '#bcbcbc', '#7c7c7c', '#a4e4fc', '#3cbcfc', '#0078f8', '#0000fc', '#b8f818', '#00b800', '#00a800', '#f8b800', '#ac7c00', '#f83800', '#e40058', '#f878f8'] },
  { id: 'pico8',         name: 'PICO-8',              colors: ['#000000', '#1d2b53', '#7e2553', '#008751', '#ab5236', '#5f574f', '#c2c3c7', '#fff1e8', '#ff004d', '#ffa300', '#ffec27', '#00e436', '#29adff', '#83769c', '#ff77a8', '#ffccaa'] },
  { id: 'apple2',        name: 'Apple II',            colors: ['#000000', '#6c2940', '#403578', '#d93cf0', '#135740', '#808080', '#2697f0', '#bfb4f8', '#404b07', '#d9680f', '#808080', '#eca8bf', '#26c30b', '#bfca87', '#93d6bf', '#ffffff'] },
  { id: 'teletext',      name: 'Teletext',            colors: ['#000000', '#ff0000', '#00ff00', '#ffff00', '#0000ff', '#ff00ff', '#00ffff', '#ffffff'] },
  { id: 'vaporwave',     name: 'Vaporwave',           colors: ['#170d27', '#2e2157', '#f6019d', '#2de2e6', '#ff6c11', '#fdfdfd'] },
  { id: 'sepia',         name: 'Sepia',               colors: ['#2a1a0f', '#6b4226', '#b08d57', '#e8d5b7'] },
  { id: 'sunset',        name: 'Sunset',              colors: ['#1a1423', '#5d2e46', '#a84448', '#e8985e', '#f6e27f'] },
  { id: 'nokia',         name: 'Nokia 3310',          colors: ['#212c16', '#72a488'] },
  { id: 'obra',          name: 'Obra Dinn IBM',       colors: ['#333319', '#e5ffff'] },
  { id: 'cmyk',          name: 'CMYK',                colors: ['#000000', '#00aeef', '#ec008c', '#fff200', '#ffffff'] },
  { id: 'rgb3',          name: 'RGB Primaries',       colors: ['#000000', '#ff0000', '#00ff00', '#0000ff', '#ffffff'] },
  { id: 'custom',        name: 'Custom…',             colors: ['#000000', '#ffffff'] },
];

export function getPalette(id) {
  return PALETTES.find((p) => p.id === id) || PALETTES[0];
}

export function hexToRgb(hex) {
  const h = hex.replace('#', '');
  const v = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(v, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
}

// Flat Float32Array [r,g,b, r,g,b, ...] in 0..255, for the CPU quantizer.
export function paletteToFloat(colors) {
  const out = new Float32Array(colors.length * 3);
  colors.forEach((hex, i) => {
    const [r, g, b] = hexToRgb(hex);
    out[i * 3] = r;
    out[i * 3 + 1] = g;
    out[i * 3 + 2] = b;
  });
  return out;
}

// Flat array in 0..1 for GLSL uniforms (padded to `max` entries).
export function paletteToUniform(colors, max = 32) {
  const out = new Float32Array(max * 3);
  for (let i = 0; i < Math.min(colors.length, max); i++) {
    const [r, g, b] = hexToRgb(colors[i]);
    out[i * 3] = r / 255;
    out[i * 3 + 1] = g / 255;
    out[i * 3 + 2] = b / 255;
  }
  return out;
}
