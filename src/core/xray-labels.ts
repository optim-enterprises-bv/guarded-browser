// The Injection X-ray's fixed vocabulary. No imports: the chrome renderer bundles this file, and the
// overlay / panel chips draw ONLY these words (plus numbers), never page text.

export type HiddenReason =
  | 'display-none'
  | 'visibility-hidden'
  | 'opacity'
  | 'tiny-font'
  | 'clipped'
  | 'off-screen'
  | 'low-contrast'
  | 'aria-hidden'
  | 'alt-text'
  | 'title-attr'
  | 'aria-label'
  | 'comment'
  | 'noscript'
  | 'template';

export const HIDDEN_REASONS: readonly HiddenReason[] = [
  'display-none', 'visibility-hidden', 'opacity', 'tiny-font', 'clipped', 'off-screen', 'low-contrast',
  'aria-hidden', 'alt-text', 'title-attr', 'aria-label', 'comment', 'noscript', 'template',
];

/** Fixed labels: the ONLY words (besides numbers) the overlay and the panel's chips ever draw. */
export const REASON_LABELS: Record<HiddenReason, string> = {
  'display-none': 'display:none',
  'visibility-hidden': 'visibility:hidden',
  opacity: 'opacity ≈ 0',
  'tiny-font': 'font-size < 4px',
  clipped: 'clipped',
  'off-screen': 'off-screen',
  'low-contrast': 'text colour ≈ background',
  'aria-hidden': 'aria-hidden',
  'alt-text': 'alt text',
  'title-attr': 'title attribute',
  'aria-label': 'aria-label',
  comment: 'HTML comment',
  noscript: '<noscript>',
  template: '<template>',
};
