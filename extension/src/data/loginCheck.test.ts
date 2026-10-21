import { describe, expect, it } from 'vitest';
import { classifyLogin, loginSummary } from './loginCheck';

describe('classifyLogin', () => {
  it('treats any Okta page as signed out', () => {
    expect(classifyLogin('atlas', { url: 'https://example.okta.com/signin' })).toBe('out');
    expect(classifyLogin('koho', { url: 'https://sso.okta.com/app/x' })).toBe('out');
  });

  it('Atlas: /login or the Okta button means out; an app page with content means in', () => {
    expect(classifyLogin('atlas', { url: 'https://atlas.wealthsimple.com/login', text: '' })).toBe('out');
    expect(classifyLogin('atlas', { url: 'https://atlas.wealthsimple.com/', text: 'Login With Okta' })).toBe('out');
    expect(classifyLogin('atlas', { url: 'https://atlas.wealthsimple.com/', text: 'Search clients' })).toBe('in');
    expect(classifyLogin('atlas', { url: 'https://atlas.wealthsimple.com/', text: '  ' })).toBe('unknown');
  });

  it('KOHO: the user search bar means in; the SSO screen means out', () => {
    expect(classifyLogin('koho', { url: 'https://admin.koho.ca/', hasKohoSearch: true })).toBe('in');
    expect(classifyLogin('koho', { url: 'https://admin.koho.ca/', text: 'Email  Continue with SSO' })).toBe('out');
    expect(classifyLogin('koho', { url: 'https://admin.koho.ca/', text: 'Loading' })).toBe('unknown');
  });

  it('a tab still on another host is unknown', () => {
    expect(classifyLogin('koho', { url: 'about:blank' })).toBe('unknown');
  });
});

describe('loginSummary', () => {
  it('lists each checked site', () => {
    expect(loginSummary({ atlas: 'in', koho: 'out' })).toBe('Atlas ✓ · KOHO: sign-in needed (tab opened)');
    expect(loginSummary({ koho: 'checking' })).toBe('KOHO: checking…');
  });
});
