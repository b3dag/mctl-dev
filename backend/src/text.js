/**
 * Console output arrives with two kinds of colour markup that mean nothing in a
 * browser: ANSI escapes from the image's init scripts, and Minecraft's own
 * section-sign codes from RCON replies. Strip both once, on the way out.
 */
const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]`, 'g');
const SECTION = /§./g;

export const stripFormatting = (s) => String(s ?? '').replace(ANSI, '').replace(SECTION, '');
