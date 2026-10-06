import { describe, it, expect } from 'vitest';
import { isSignInLabel } from './i2cLogin';

describe('isSignInLabel', () => {
  it('matches the redesigned button label', () => {
    expect(isSignInLabel('Sign-in')).toBe(true);
  });

  it('matches spacing and casing variants', () => {
    expect(isSignInLabel('Sign In')).toBe(true);
    expect(isSignInLabel('sign in')).toBe(true);
    expect(isSignInLabel('SIGN-IN')).toBe(true);
    expect(isSignInLabel('  Sign-In  ')).toBe(true);
    expect(isSignInLabel('Signin')).toBe(true);
  });

  it('does not match the Reset button beside it', () => {
    expect(isSignInLabel('Reset')).toBe(false);
  });

  it('does not match the help links on the same page', () => {
    // Both sit directly above the buttons; an unanchored pattern would catch the first.
    expect(isSignInLabel('Problem Signing In?')).toBe(false);
    expect(isSignInLabel('Forgot Your Password?')).toBe(false);
  });

  it('does not match the page heading', () => {
    expect(isSignInLabel('Sign in to Your Account')).toBe(false);
  });

  it('does not match empty or whitespace labels', () => {
    expect(isSignInLabel('')).toBe(false);
    expect(isSignInLabel('   ')).toBe(false);
  });
});
