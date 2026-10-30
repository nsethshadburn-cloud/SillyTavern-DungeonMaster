// Which ambient bed fits where the party is: from the floor's theme, the weather, the hour and
// whether a fire is burning close by. Pure module (the sound itself is ui/sound.js).

/** Floor themes that are open to the sky. */
export const OUTDOOR_THEMES = new Set(['forest', 'camp', 'swamp', 'snow', 'desert', 'town', 'ship']);

/** Underground or stone-and-iron themes: drips and a low hum. */
const DEEP_THEMES = new Set(['dungeon', 'crypt', 'cave', 'mine', 'sewer', 'prison']);

/** Every bed the engine knows. */
export const AMBIENTS = Object.freeze(['dungeon', 'indoor', 'outdoors', 'night', 'wind', 'rain', 'storm', 'fire']);

/**
 * @param {{theme?: string, weather?: string, night?: boolean, fire?: boolean, outdoor?: boolean|null}} o
 * @returns {string} one of AMBIENTS
 */
export function ambientFor({ theme = '', weather = 'clear', night = false, fire = false, outdoor = null } = {}) {
    if (fire) return 'fire';
    const out = outdoor ?? OUTDOOR_THEMES.has(String(theme || '').toLowerCase());
    if (out) {
        if (weather === 'storm') return 'storm';
        if (weather === 'rain') return 'rain';
        if (weather === 'wind' || weather === 'snow' || weather === 'fog') return 'wind';
        return night ? 'night' : 'outdoors';
    }
    return DEEP_THEMES.has(String(theme || '').toLowerCase()) ? 'dungeon' : 'indoor';
}

/** What a footstep sounds like on this floor theme. */
export function footingFor(theme = '') {
    const t = String(theme || '').toLowerCase();
    if (['forest', 'camp', 'swamp', 'desert'].includes(t)) return 'soft';
    if (t === 'snow') return 'snow';
    if (['ship', 'tavern', 'house', 'library'].includes(t)) return 'wood';
    return 'stone';
}
