'use strict';

(() => {

/**
 * Carbon icons used by this screen, on Carbon's 32x32 grid.
 * Paths are the real @carbon/icons geometry carried over from the design
 * system bundle, so glyph weight matches the rest of the kit.
 */
const ICON_PATHS = {
  folder:
    '<path d="M11.17,6l3.42,3.41.58.59H28V26H4V6h7.17m0-2H4A2,2,0,0,0,2,6V26a2,2,0,0,0,2,2H28a2,2,0,0,0,2-2V10a2,2,0,0,0-2-2H16L12.59,4.59A2,2,0,0,0,11.17,4Z"></path>',

  'data--base':
    '<path d="M24,3H8A2,2,0,0,0,6,5V27a2,2,0,0,0,2,2H24a2,2,0,0,0,2-2V5A2,2,0,0,0,24,3Zm0,2v6H8V5ZM8,19V13H24v6Zm0,8V21H24v6Z"></path>'
    + '<circle cx="11" cy="8" r="1"></circle><circle cx="11" cy="16" r="1"></circle><circle cx="11" cy="24" r="1"></circle>',

  checkmark:
    '<polygon points="13 24 4 15 5.414 13.586 13 21.171 26.586 7.586 28 9 13 24"></polygon>',

  document:
    '<path d="M25.7,9.3l-7-7C18.5,2.1,18.3,2,18,2H8C6.9,2,6,2.9,6,4v24c0,1.1,0.9,2,2,2h16c1.1,0,2-0.9,2-2'
    + 'V10C26,9.7,25.9,9.5,25.7,9.3 z M18,4.4l5.6,5.6H18V4.4z M24,28H8V4h8v6c0,1.1,0.9,2,2,2h6V28z"></path>'
    + '<rect x="10" y="22" width="12" height="2"></rect><rect x="10" y="16" width="12" height="2"></rect>',

  'warning--filled':
    '<path d="M16,2C8.3,2,2,8.3,2,16s6.3,14,14,14s14-6.3,14-14C30,8.3,23.7,2,16,2z M14.9,8h2.2v11h-2.2V8z M16,25'
    + ' c-0.8,0-1.5-0.7-1.5-1.5S15.2,22,16,22c0.8,0,1.5,0.7,1.5,1.5S16.8,25,16,25z"></path>',

  'checkmark--filled':
    '<path d="M16,2A14,14,0,1,0,30,16,14,14,0,0,0,16,2ZM14,21.5908l-5-5L10.5906,15,14,18.4092,21.41,11l1.5957,1.5859Z"></path>',

  'error--filled':
    '<path d="M16,2A13.914,13.914,0,0,0,2,16,13.914,13.914,0,0,0,16,30,13.914,13.914,0,0,0,30,16,13.914,13.914,0,0,0,16,2Z'
    + 'm5.4449,21L9,10.5557,10.5557,9,23,21.4448Z"></path>',

  'chevron--down':
    '<polygon points="16,22 6,12 7.4,10.6 16,19.2 24.6,10.6 26,12 "></polygon>',

  close:
    '<polygon points="17.4141 16 24 9.4141 22.5859 8 16 14.5859 9.4143 8 8 9.4141 14.5859 16 8 22.5859 9.4143 24 16 17.4141 22.5859 24 24 22.5859 17.4141 16"></polygon>',

  // Drawn to Carbon's 32-grid conventions; @carbon/icons "renew" was not part
  // of the design system bundle this project ships.
  renew:
    '<path d="M12,10H6.78A11,11,0,0,1,27,16h2A13,13,0,0,0,6,7.68V4H4v8h8Z"></path>'
    + '<path d="M20,22h5.22A11,11,0,0,1,5,16H3a13,13,0,0,0,23,8.32V28h2V20H20Z"></path>',
};

/** Render one icon at `size` px, inheriting currentColor. */
function icon(name, size = 16, className = '') {
  const path = ICON_PATHS[name];
  if (!path) return '';
  return `<svg class="cds-icon ${className}" width="${size}" height="${size}" viewBox="0 0 32 32" `
    + `fill="currentColor" aria-hidden="true" focusable="false">${path}</svg>`;
}

window.CarbonIcons = { icon, ICON_PATHS };
})();
