// Label matching for i2c's login form.
//
// i2c's 2026 "C-Agent redesign" ships a Sign-in control with no `type="submit"`
// attribute, so the attribute selectors findSubmit used to rely on stopped matching and
// the chain filled the form without submitting it. Matching the visible label is what
// the rest of content/i2c.ts already does (see tryKillSession's /^kill\s*all$/i), and it
// survives a restyle.

/**
 * Is this control's label the Sign-in button?
 *
 * Anchored deliberately. The login page also renders "Problem Signing In?" and the
 * heading "Sign in to Your Account", both of which an unanchored /sign.*in/i would
 * match — and "Reset" sits immediately beside the real button.
 */
export function isSignInLabel(label: string): boolean {
  return /^sign[\s-]*in$/i.test((label || '').trim());
}
